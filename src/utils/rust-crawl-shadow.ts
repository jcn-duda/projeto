/**
 * Shadow mode e captura para o parser de páginas do raspador (`adom-crawl`).
 *
 * Duas ligações, ambas FORA do caminho crítico (`setImmediate`) e fail-open —
 * nenhuma delas pode mudar o resultado TS:
 *
 *  1. `captureCrawlPage`: grava a página PRIMÁRIA da obra no `CRAWL_CAPTURE_DIR`
 *     (quando configurado) para virar fixture de golden/parity. INDEPENDE do
 *     `RUST_CORE`: capturar é coleta, não depende de o binário carregar.
 *  2. `shadowCrawlPage`: roda o `parseCrawlPage` do Rust ao lado do parse TS da
 *     MESMA unidade de página e loga a divergência; a resposta segue SEMPRE TS.
 *     Só corre com `RUST_CORE=shadow|on` E o binário carregado.
 *
 * Unidade comparada (por que não o `CrawlWorkResult`): o resultado do adaptador
 * é PÓS-rede — protetor já foi seguido e o magnet resolvido. O `parseCrawlPage`
 * do Rust para numa página só. Comparar os dois diverge sempre nos sites com
 * protetor. Aqui os DOIS lados falam da MESMA unidade: o conteúdo da página
 * primária e os links que o parser TS EXTRAIU dela (tap `onPageContent`), sem
 * seguir protetor. Metadados (título/ano/IMDb/status terminal) continuam do
 * adaptador porque são derivados DA PÁGINA.
 *
 * Segurança da captura: só a página PRIMÁRIA do site; o meta guarda host +
 * CAMINHO (a query — onde token viaja — fica fora); nada de cookie/header; e o
 * corpo passa por `scrubCrawlPage`, que REDIGE valores de parâmetros sensíveis
 * (`passkey`, `token`, `session`, nonce de CSRF, cookie em JS…) preservando a
 * ESTRUTURA que o parser lê (o `btih` do magnet, os hrefs). Captura é opt-in
 * (`CRAWL_CAPTURE_DIR`) e tem teto de bytes (`CRAWL_CAPTURE_MAX_BYTES`).
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import type { CrawlPageLink, CrawlPageUnit, CrawlWorkResult } from '../providers/crawl-types.js';
import { getCore, getMode } from './rust-core.js';
import { crawlUrlKey } from './crawl-url-key.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

/** Caracteres que um segmento de caminho pode ter (site e nome de arquivo). */
const SEGMENT_RE = /[^a-zA-Z0-9_-]/g;

/** Segmento de caminho seguro: nunca contém separador nem `..`. */
function safeSegment(value: string, fallback: string): string {
  return String(value || '').replace(SEGMENT_RE, '_').slice(0, 100) || fallback;
}

/** Host e caminho da página; a query (token) fica de fora do meta. */
function hostPathOf(url: string): { host: string; path: string } {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = ''; }
  return { host, path: crawlUrlKey(url) };
}

/**
 * Par chave=valor sensível (nome do parâmetro case-insensitive). O lookbehind
 * impede casar o sufixo de outro nome (`data-id` não vira `id`). A redação
 * preserva a chave e a fronteira (`&`, `#`, aspas), então o parser continua
 * enxergando o MESMO href/magnet — só o segredo vira `REDACTED`.
 *
 * `id`/`pub` entram porque são os tokens dos PROTETORES reais BR: nerd
 * `/link.php?id=<blob>` e vaca `…/go.php?id=<blob>&pub=PUB_…`. O valor do
 * protetor é o segredo; a URL (estrutura que o parser lê) permanece.
 */
const SENSITIVE_KV = /(?<![A-Za-z0-9_-])((?:passkey|passphrase|token|pub|id|api[_-]?key|apikey|auth|signature|sig|session|sessionid|session_id|csrf|nonce|password|senha|secret|cf_clearance|PHPSESSID|code)=)([^&#"'<>\s]+)/gi;

/**
 * Atributos de token do DOM cujo VALOR é bloco opaco (rede `data-token="…"`).
 * Aqui a aspa impede o `SENSITIVE_KV` de casar, então o atributo tem regra
 * própria; o nome do atributo fica (o parser o procura), o blob some.
 */
const SENSITIVE_ATTR = /((?:data-token|data-pub|data-id)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi;

/** `document.cookie = …` inline: o valor vira `"REDACTED"`. */
const COOKIE_JS = /(document\.cookie\s*=\s*)("[^"]*"|'[^']*'|[^;\r\n]+)/gi;

/**
 * Redige payloads sensíveis do corpo capturado de forma DETERMINÍSTICA (mesma
 * entrada → mesma saída, para a fixture e o shadow verem o MESMO texto). Não
 * mexe na estrutura que o parser usa (btih, href, tags) — só nos valores de
 * parâmetros/atributos sensíveis e em `document.cookie`. Cobre os tokens dos
 * protetores reais (`id`, `pub`, `data-token`).
 */
export function scrubCrawlPage(content: string): string {
  if (!content) return content;
  return content
    .replace(SENSITIVE_KV, '$1REDACTED')
    .replace(SENSITIVE_ATTR, '$1"REDACTED"')
    .replace(COOKIE_JS, '$1"REDACTED"');
}

/**
 * Captura UMA página primária de obra (HTML ou JSON) para o
 * `CRAWL_CAPTURE_DIR`, em background. Fail-open: qualquer falha vira debug.
 * Recebe o corpo JÁ scrubado (`scrubCrawlPage`) — nunca hop de protetor.
 */
export function captureCrawlPage(
  site: string,
  kind: string,
  url: string,
  content: string,
): void {
  const captureDir = config.crawl.captureDir;
  if (!captureDir || !content) return;

  const bytes = Buffer.byteLength(content, 'utf8');
  const maxBytes = config.crawl.captureMaxBytes;
  if (maxBytes > 0 && bytes > maxBytes) {
    metrics.count('rust.crawl.capture.skipped');
    log.debug(`[crawl-capture] ${site} ${crawlUrlKey(url)}: ${bytes} bytes acima do teto ${maxBytes}; não captura`);
    return;
  }

  const key = safeSegment(crawlUrlKey(url), 'root');
  const ext = content.trimStart().startsWith('{') ? 'json' : 'html';
  const meta = { site, kind, ...hostPathOf(url), bytes, capturedAt: new Date().toISOString() };

  setImmediate(() => {
    try {
      const base = path.resolve(captureDir);
      const siteDir = path.resolve(base, safeSegment(site, 'site'));
      // Contenção: site/chave já são segmentos limpos; a checagem é defesa em
      // profundidade contra path traversal (nada sai do diretório de captura).
      if (siteDir !== base && !siteDir.startsWith(base + path.sep)) return;
      if (!fs.existsSync(siteDir)) {
        fs.mkdirSync(siteDir, { recursive: true });
      }
      fs.writeFileSync(path.join(siteDir, `${key}.${ext}`), content, 'utf8');
      fs.writeFileSync(path.join(siteDir, `${key}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
      metrics.count('rust.crawl.capture.pages');
    } catch (err) {
      metrics.count('rust.crawl.capture.error');
      log.debug(`[crawl-capture] falha ao salvar ${site} (${key}):`, log.errorMessage(err));
    }
  });
}

/** Hash `btih` de um texto (magnet ou href), minúsculo; `null` se ausente. */
function btihOf(text: string): string | null {
  const match = /btih:([a-z0-9]{32,40})/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Identidade do torrent de um link DE PÁGINA (TS) ou de um release do Rust: o
 * `btih` quando existe, senão o `infoHash`. É a chave de comparação — dois
 * magnets do mesmo torrent com trackers diferentes casam.
 *
 * NUNCA devolve a URL crua: link de PROTETOR (sem magnet/infoHash) retorna
 * `null` e conta como NÃO-magnet. Assim ele não vira chave (o Rust também o
 * descarta) e não gera `torrents:` diff espúrio em vaca/nerd/tdf/comando.
 */
function torrentKey(link: CrawlPageLink): string | null {
  const magnet = String(link.magnet || '');
  if (/^magnet:/i.test(magnet)) return btihOf(magnet) || magnet.toLowerCase();
  const url = String(link.url || '');
  if (/^magnet:/i.test(url)) return btihOf(url) || url.toLowerCase();
  if (link.infoHash) return String(link.infoHash).toLowerCase() || null;
  return null;
}

/** Igualdade de MULTICONJUNTO ordenado de chaves (duplicatas contam). */
function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Shadow do parser: compara o parse TS da MESMA página (links do tap) contra o
 * `parseCrawlPage` do Rust e loga divergência. Opt-in por `RUST_CORE`; com
 * `off` (default) ou sem o binário é no-op. NUNCA altera o resultado TS.
 */
export function shadowCrawlPage(
  site: string,
  kind: string,
  url: string,
  content: string,
  tsResult: CrawlWorkResult,
  pageLinks?: readonly CrawlPageLink[],
  pageUnit?: CrawlPageUnit,
): void {
  const mode = getMode();
  if (mode === 'off') return;
  const core = getCore();
  if (!core || typeof core.parseCrawlPage !== 'function' || !content) return;
  // Teto de bytes PRÓPRIO do shadow (independente do teto de captura): sem ele,
  // uma página multi-MB roda o parser NATIVO síncrono na main thread. 0 desliga
  // só este teto (explícito).
  const maxBytes = config.crawl.shadowMaxBytes;
  if (maxBytes > 0 && Buffer.byteLength(content, 'utf8') > maxBytes) {
    metrics.count('rust.crawl.shadow.skipped');
    return;
  }

  setImmediate(() => {
    metrics.count('rust.crawl.pages');
    metrics.count(`rust.crawl.${site}.pages`);
    try {
      const rustResult = core.parseCrawlPage!(site, kind, url, content);
      const diffs: string[] = [];
      // Metadados da MESMA unidade do conteúdo: `pageUnit` quando o tap é por
      // unidade (ex.: Mico série, cujo tap é UM episódio) — NUNCA o resultado
      // agregado da série contra o parse de um episódio. Fallback POR CAMPO:
      // a unit pode trazer só `status` (mico-series.ts) e o campo ausente DEVE
      // cair no `tsResult` — não virar `null` (senão `imdb` vira `<none>` e
      // todo página de série Mico gera diff com o IMDb que o Rust deriva).
      const status = pageUnit?.status ?? tsResult.status;
      const title = pageUnit?.title ?? tsResult.title;
      const year = pageUnit?.year ?? tsResult.year;
      const imdb = pageUnit?.imdb ?? tsResult.imdb;

      // Torrents de PÁGINA (TS, pré-protetor) × releases do Rust. Calculados
      // ANTES do status: a explicação por protetor depende deles.
      const hasLinks = !!pageLinks;
      const links = pageLinks ?? [];
      const tsKeys = links.map(torrentKey).filter((k): k is string => !!k).sort();
      const rustReleases = [
        ...rustResult.releases,
        ...rustResult.groups.flatMap((g) => g.releases),
        ...rustResult.unlocated,
      ];
      const rustKeys = rustReleases
        .map((r) => torrentKey({ magnet: r.magnet }))
        .filter((k): k is string => !!k)
        .sort();
      const nonMagnet = hasLinks ? links.length - tsKeys.length : 0;

      // Status: só compara os terminais que o Rust modela. `partial`/`simulated`/
      // `no-work` são estados de FLUXO do motor (progresso/pausa), não do parser
      // de página — contá-los como divergência seria ruído, não paridade.
      if (status === 'done' || status === 'no-torrent' || status === 'error') {
        if (status !== rustResult.status) {
          // Divergência EXPLICADA por resolução de protetor: o TS chega a `done`
          // SÓ depois de seguir os protetores (nenhum magnet na página), enquanto
          // o Rust, pré-protetor, diz `no-torrent` (links de protetor não têm
          // magnet). NÃO é divergência de parser — conta em métrica PRÓPRIA e a
          // fronteira segue VISÍVEL (nada normalizado/mascarado).
          const explainedByProtector = status === 'done'
            && rustResult.status === 'no-torrent'
            && tsKeys.length === 0
            && nonMagnet > 0;
          if (explainedByProtector) {
            metrics.count('rust.crawl.status.protector');
          } else {
            diffs.push(`status: ts=${status} rust=${rustResult.status}`);
          }
        }
      } else {
        metrics.count('rust.crawl.status.out-of-scope');
      }

      // Metadados: divergência BILATERAL e UNILATERAL (um lado preenchido e o
      // outro vazio). Mico fica FORA do título: lá o `title` do TS é título de
      // RELEASE, não de obra — comparar com o título de obra do Rust seria
      // espúrio (o `pageUnit` do Mico série já não traz título).
      const norm = (v: unknown) => String(v ?? '').trim();
      const imdbTs = norm(imdb);
      const imdbRust = norm(rustResult.imdb);
      if ((imdbTs || imdbRust) && imdbTs !== imdbRust) {
        diffs.push(`imdb: ts=${imdbTs || '<none>'} rust=${imdbRust || '<none>'}`);
      }
      if (site !== 'mico') {
        const titleTsRaw = norm(title);
        const titleRustRaw = norm(rustResult.title);
        if ((titleTsRaw || titleRustRaw) && titleTsRaw.toLowerCase() !== titleRustRaw.toLowerCase()) {
          diffs.push(`title: ts=${titleTsRaw || '<none>'} rust=${titleRustRaw || '<none>'}`);
        }
      }
      const yearTs = year == null ? '' : String(year);
      const yearRust = rustResult.year == null ? '' : String(rustResult.year);
      if ((yearTs || yearRust) && yearTs !== yearRust) {
        diffs.push(`year: ts=${yearTs || '<none>'} rust=${yearRust || '<none>'}`);
      }

      // Torrents: TS = links de PÁGINA (pré-protetor); Rust = releases (magnets).
      // Sem `pageLinks` não há unidade equivalente — não compara (e conta).
      if (hasLinks) {
        if (!sameKeys(tsKeys, rustKeys)) {
          diffs.push(`torrents: ts=${tsKeys.length} rust=${rustKeys.length}`);
        }
        // Fronteira VISÍVEL (não divergência): links de página que NÃO carregam
        // magnet (URLs de protetor). O Rust não os representa na saída de
        // releases; contamos para o operador ver que existem, sem virar diff
        // sistemático. Sem protetor o número é 0 e nada é mascarado.
        if (nonMagnet > 0) metrics.count('rust.crawl.page_link.protector', nonMagnet);
      } else {
        metrics.count('rust.crawl.page_link.absent');
      }

      if (diffs.length > 0) {
        metrics.count('rust.crawl.diff');
        metrics.count(`rust.crawl.${site}.diff`);
        log.warn(`[rust-crawl] divergência em ${site} (${crawlUrlKey(url)}): ${diffs.join(', ')}`);
      }
    } catch (err) {
      metrics.count('rust.crawl.error');
      metrics.count(`rust.crawl.${site}.error`);
      log.debug(`[rust-crawl] erro ao avaliar ${site} (${crawlUrlKey(url)}):`, log.errorMessage(err));
    }
  });
}
