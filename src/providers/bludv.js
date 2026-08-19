// @ts-check
const config = require('../config');
const { opts } = require('../runtime');
const cache = require('../utils/cache');
const { mapLimit } = require('../utils/concurrency');
const log = require('../utils/logger');
const { prefix } = require('../utils/cache-keys');

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
function parseSize(text) {
  const m = String(text).match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  const mult = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()];
  return Number.isFinite(value) ? Math.round(value * mult) : null;
}

async function get(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      ...(referer ? { Referer: referer } : {}),
    },
    signal: AbortSignal.timeout(config.bludv.timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Cards da página de busca: div.post > div.title > a[href] */
function parsePosts(html) {
  const posts = [];
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
function parseDownloadLinks(html) {
  const out = [];
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

/** systemads → 302 → videosad → HTML com o magnet. Dois saltos, sem atalho. */
async function resolveMagnet(link, referer) {
  const html = await get(link.url, referer);
  const m = html.match(/magnet:\?[^"'<\s]+/);
  return m ? decodeEntities(m[0]) : null;
}

async function collectFromPost(post) {
  const html = await get(post.url, config.bludv.baseUrl);
  let links = parseDownloadLinks(html);

  if (opts().dubbedOnly) {
    links = links.filter((l) => l.audio !== 'legendado');
  }
  links = links.slice(0, config.bludv.maxLinksPerPost);

  // 'drop': botão sem magnet não tem o que exibir.
  const resolved = await mapLimit(
    links,
    config.bludv.concurrency,
    async (link) => {
      const magnet = await resolveMagnet(link, post.url);
      if (!magnet) return null;
      // O magnet não traz `dn`, então o nome vem do título do post + spec do botão.
      const name = post.title.replace(/\s*\((\d{4})\).*$/, ' $1').trim();
      return {
        title: [name, link.label, link.audio === 'dublado' ? 'DUBLADO' : 'LEGENDADO']
          .filter(Boolean)
          .join(' '),
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

async function search(query) {
  if (!config.bludv.enabled || !query) return [];

  // O buscador WordPress dos sites BR engasga com ":" — remover é o que faz
  // "O Poderoso Chefão: Parte II" voltar resultado.
  const q = String(query).replace(/:/g, ' ').replace(/\s+/g, ' ').trim();

  // A chave carrega a flag de dublado do USUÁRIO: a filtragem das legendadas
  // acontece DENTRO do scrape (collectFromPost), então sem a flag na chave um
  // usuário receberia a lista já cortada do outro. TTL BR: é a fonte mais cara
  // (raspa WordPress + dois saltos de protetor por botão) e a que menos muda.
  const { ttlBr, emptyTtl, maxItems } = config.rawCache;
  const rawKey = `${prefix('raw')}bludv:${opts().dubbedOnly ? 'd' : 't'}:${q}`;
  if (ttlBr > 0 && maxItems > 0) {
    const hit = cache.get(rawKey);
    if (hit && Array.isArray(hit.items)) return hit.items;
  }

  try {
    const html = await get(`${config.bludv.baseUrl}/?s=${encodeURIComponent(q)}`);
    const posts = parsePosts(html).slice(0, config.bludv.maxPosts);

    // 'drop': post que falhou (site fora, layout quebrado) sai do lote em vez
    // de contaminar o resultado — menos resultado, nunca erro.
    const chunks = await mapLimit(posts, config.bludv.concurrency, collectFromPost, { onItemError: 'drop' });
    const items = chunks.flat();
    if (ttlBr > 0 && maxItems > 0 && items.length <= maxItems) {
      // Vazio usa o TTL curto: site fora/rate-limit não pode congelar a
      // resposta. Falha (catch) continua sem cache — retry na próxima busca.
      cache.set(rawKey, { items }, items.length === 0 ? emptyTtl : ttlBr);
    }
    log.info(`[bludv] ${posts.length} post(s) → ${items.length} magnet(s)`);
    return items;
  } catch (err) {
    log.warn('[bludv]', err.message);
    return [];
  }
}

module.exports = { search, name: 'bludv', parsePosts, parseDownloadLinks };
