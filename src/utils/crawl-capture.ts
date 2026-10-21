/**
 * Captura de fixtures para o parser de páginas do raspador (`adom-crawl`).
 *
 * `captureCrawlPage` grava a página PRIMÁRIA da obra no `CRAWL_CAPTURE_DIR`
 * (quando configurado) para virar fixture de golden/parity do crate. É a ÚNICA
 * ligação daqui: capturar é coleta, roda FORA do caminho crítico (`setImmediate`)
 * e é fail-open — nenhuma falha de disco muda o resultado do crawl.
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
 * entrada → mesma saída, para a fixture ser reproduzível). Não mexe na
 * estrutura que o parser usa (btih, href, tags) — só nos valores de
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
