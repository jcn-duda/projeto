import config from '../config.js';
import { opts, capture, run } from '../runtime.js';
import { raceWithDeadline } from '../utils/deadline.js';
import { extractMagnet, isValidMagnetUri, releaseTitle } from '../../resolvers/profiles/bludv-parsers.js';
import { parseGateAndLegacyLinks, isGateUrl } from '../../resolvers/profiles/bludv-gate-links.js';
import { prefetchGateMagnet, resolveGateMagnet } from '../../resolvers/profiles/bludv-gate-flow.js';
import * as cache from '../utils/cache.js';
import { mapLimit } from '../utils/concurrency.js';
import * as log from '../utils/logger.js';
import { prefix } from '../utils/cache-keys.js';
// A detecção do portão é a MESMA do resolvedor standalone: nada de regex local.
import { assertNoAdGate, hasAdGate, isBludvAdGate } from '../../resolvers/profiles/bludv-gate.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

function decodeEntities(s = '') {
  return String(s)
    .replace(/&#0?38;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s = '') {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "3.39 GB" / "897 MB" → bytes, que é o que o formatador do addon espera. */
function parseSize(text: string) {
  const m = String(text).match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  const mult = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()] as number;
  return Number.isFinite(value) ? Math.round(value * mult) : null;
}

async function get(url: string, referer = '', deadlineAt = Date.now() + config.bludv.timeout) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('bludv: orçamento esgotado');
  const task = (async () => {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      ...(referer ? { Referer: referer } : {}),
    },
    signal: AbortSignal.timeout(Math.max(1, remaining)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
  })();
  return raceWithDeadline(task, remaining, () => { throw new Error('bludv: prazo esgotado'); });
}

/** Card da lista do WordPress: o que a raspa do post consome. */
type BludvPost = { url: string; title: string };

/** Cards da página de busca: div.post > div.title > a[href] */
function parsePosts(html: string) {
  const posts: BludvPost[] = [];
  const re = /<div class="post">[\s\S]*?<div class="title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    posts.push({ url: decodeEntities(m[1]), title: stripTags(m[2]) });
  }
  return posts;
}

/**
 * Percorre o post EM ORDEM DE DOCUMENTO mantendo a seção de áudio corrente.
 * BLUDV agrupa um bloco DUBLADO e outro LEGENDADO sob o mesmo post "Dual Áudio",
 * separados só por um cabeçalho — sem isso, release legendada entra como dublada.
 */
function parseDownloadLinks(html: string) {
  const out: { url: string; label: string; size: string | null; audio: string }[] = [];
  let audio = 'desconhecido';
  let cursor = 0;

  const anchor = /<a\s+href="(https?:\/\/(?:systemads|videosad)[^"]+)"[^>]*>[\s\S]*?<\/a>/gi;
  let m;
  while ((m = anchor.exec(html))) {
    // Texto entre a âncora anterior e esta: carrega o cabeçalho de seção
    // ("VERSÃO MKV DUAL ÁUDIO" / "VERSÃO MP4/MKV LEGENDADO") e, logo antes do
    // botão, a qualidade e o tamanho ("WEB-DL 1080p (3.39 GB - MKV)").
    const segment = stripTags(html.slice(cursor, m.index)).toUpperCase();
    cursor = anchor.lastIndex;

    const marker = [...segment.matchAll(/(DUAL\s+ÁUDIO|DUBLAD\w*|LEGENDAD\w*)/g)].pop();
    if (marker) audio = /LEGENDAD/.test(marker[1]) ? 'legendado' : 'dublado';

    // Só a especificação do botão: "WEB-DL 2160p x265 DV HDR (24.08 GB - MKV)".
    // A última ocorrência: o título do post no topo da página também cita
    // "WEB-DL 720p/1080p/4K" e casaria com o padrão.
    const spec = [
      ...segment.matchAll(/((?:WEB-DL|BLURAY|BLU-RAY|BDRIP|HDTV|WEBRIP)[^()]*?)\(([^)]*)\)/g),
    ].pop();
    const size = spec ? decodeEntities(spec[2]).split(/[-–—]/)[0].trim() : null;
    // Quando o segmento tem só um "(...)", o casamento começa no WEB-DL do
    // título do post; corta tudo antes da última fonte citada.
    let label = spec ? spec[1].replace(/\s+/g, ' ').trim() : '';
    const last = [...label.matchAll(/(WEB-DL|BLURAY|BLU-RAY|BDRIP|HDTV|WEBRIP)/g)].pop();
    if (last && last.index > 0) label = label.slice(last.index);

    out.push({
      url: decodeEntities(m[1]),
      label,
      size: size && /\d/.test(size) ? size : null,
      audio,
    });
  }
  return out;
}

/** O magnet direto não gasta rede; o legado continua seguindo seu protetor. */
async function resolveMagnet(link: string, referer: string, deadlineAt: number) {
  if (isValidMagnetUri(link)) return link;
  const html = await get(link, referer, deadlineAt);
  const magnet = extractMagnet(html);
  return magnet && isValidMagnetUri(magnet) ? magnet : null;
}

async function collectFromPost(post: BludvPost, deadlineAt: number, notePending: () => void) {
  const html = await get(post.url, config.bludv.baseUrl, deadlineAt);
  let links = parseGateAndLegacyLinks(html, post.url);
  // Nem vazio nem lote misto com gate pendente viram cache cru de longa duração.
  if (hasAdGate(html) || links.some((link) => isGateUrl(link.url, post.url))) notePending();
  // O BLUDV pode trocar o protetor de link por um portão de anúncio: nesse caso
  // o post não traz nenhum `systemads`/`videosad` e a raspa viraria 0 releases
  // silencioso. Lançar aqui é o que dá ao `search()` um MOTIVO para logar — mas
  // só quando não sobrou botão, para não perder release boa.
  assertNoAdGate(html, links.length);

  if (opts().dubbedOnly) {
    links = links.filter((l) => l.audio !== 'legendado');
  }
  // Gate não rouba as vagas dos links legados nem dispara N solves por post.
  const gate = links.find((link) => isGateUrl(link.url, post.url));
  links = links.filter((link) => !isGateUrl(link.url, post.url)).slice(0, config.bludv.maxLinksPerPost);
  if (gate && Date.now() < deadlineAt) links.push(gate);
  const context = capture();

  // 'drop': botão sem magnet não tem o que exibir.
  const resolved = await mapLimit(
    links,
    config.bludv.concurrency,
    async (link) => {
      let magnet: string | null;
      if (isGateUrl(link.url, post.url)) {
        // Resolve e prefetch compartilham coalescing/cache no núcleo. Aqui só se
        // aproveita o hit imediato; os ~30s do anúncio nunca entram na resposta.
        run(context, () => prefetchGateMagnet(link.url, post.url));
        magnet = await raceWithDeadline(resolveGateMagnet(link.url, post.url).catch(() => null), 0, () => null);
      } else {
        magnet = await resolveMagnet(link.url, post.url, deadlineAt);
      }
      if (!magnet || !isValidMagnetUri(magnet)) return null;
      return {
        title: releaseTitle(post.title, link),
        magnet,
        // O site não publica seeds. 0 faria o filtro MIN_SEEDERS descartar a
        // release antes de consultar o swarm; 1 é o valor neutro.
        seeders: 1,
        size: link.size ? parseSize(link.size) : null,
        tracker: 'BLUDV',
        audio: link.audio,
        isBr: true,
      };
    },
    { onItemError: 'drop' },
  );

  return resolved;
}

interface SearchOptions {
  /** Sombra read-only (F2.1): referência SEM efeitos. Só o cache `raw:v1`
   * (leitura e escrita) é suprimido aqui; a rede/parse são os mesmos. */
  readOnly?: boolean;
}

async function search(query: string, options: SearchOptions = {}) {
  if (!config.bludv.enabled || !query) return [];
  const readOnly = options.readOnly === true;

  // O buscador WordPress dos sites BR engasga com ":" — remover é o que faz
  // "O Poderoso Chefão: Parte II" voltar resultado.
  const q = String(query).replace(/:/g, ' ').replace(/\s+/g, ' ').trim();

  // A chave carrega a flag de dublado do USUÁRIO: a filtragem das legendadas
  // acontece DENTRO do scrape (collectFromPost), então sem a flag na chave um
  // usuário receberia a lista já cortada do outro. TTL BR: é a fonte mais cara
  // (raspa WordPress + dois saltos de protetor por botão) e a que menos muda.
  const { ttlBr, emptyTtl, maxItems } = config.rawCache;
  const rawKey = `${prefix('raw')}bludv:${opts().dubbedOnly ? 'd' : 't'}:${q}`;
  // Sombra read-only: o cache bruto é um efeito do Node (um hit serviria uma
  // lista que a coleta de referência não viu). Não lê e não grava.
  if (!readOnly && ttlBr > 0 && maxItems > 0) {
    const hit = cache.get(rawKey);
    if (hit && Array.isArray(hit.items)) return hit.items;
  }

  const deadlineAt = Date.now() + config.bludv.timeout;
  try {
    const html = await get(`${config.bludv.baseUrl}/?s=${encodeURIComponent(q)}`, '', deadlineAt);
    const posts = parsePosts(html).slice(0, config.bludv.maxPosts);

    // 'drop': post que falhou (site fora, layout quebrado) sai do lote em vez
    // de contaminar o resultado — menos resultado, nunca erro. O portão de
    // anúncio é separado da contagem genérica: sem ele o resumo
    // "N post(s) → 0 magnet(s)" não diz se o site mudou de protetor ou só não
    // tem o título procurado.
    let gatePosts = 0;
    let incomplete = false;
    const chunks = await mapLimit(
      posts,
      config.bludv.concurrency,
      async (post) => {
        try {
          return await collectFromPost(post, deadlineAt, () => {
            incomplete = true;
            gatePosts++;
            log.warn('[bludv] portão de anúncio ativo —', post.url);
          });
        } catch (err) {
          incomplete = true;
          if (isBludvAdGate(err) && !gatePosts) {
            gatePosts++;
            log.warn('[bludv] portão de anúncio ativo —', post.url);
          }
          // Rejoga: é o 'drop' do mapLimit que tira o post do lote.
          throw err;
        }
      },
      { onItemError: 'drop' },
    );
    const items = chunks.flat();
    if (!incomplete && !readOnly && ttlBr > 0 && maxItems > 0 && items.length <= maxItems) {
      // Vazio usa o TTL curto: site fora/rate-limit não pode congelar a
      // resposta. Falha (catch) continua sem cache — retry na próxima busca.
      cache.set(rawKey, { items }, items.length === 0 ? emptyTtl : ttlBr);
    }
    log.info(
      `[bludv] ${posts.length} post(s) → ${items.length} magnet(s)` +
        (gatePosts > 0 ? ` [portão de anúncio em ${gatePosts}/${posts.length} post(s)]` : ''),
    );
    return items;
  } catch (err) {
    log.warn('[bludv]', err.message);
    return [];
  }
}

export default { search, name: 'bludv', parsePosts, parseDownloadLinks };
