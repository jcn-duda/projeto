#!/usr/bin/env node
/**
 * Harness diferencial: TS vs Rust resolver.
 *
 * Compara as respostas HTTP de /search (releases + botões) entre o resolver
 * TypeScript (profile embutido no addon) e o resolver Rust (servidor espelho).
 *
 * Uso:
 *   node scripts/rust/resolver-diff.mjs --site=comandotorrents --port=8701 --rust-port=8801
 *
 * Flags:
 *   --site=<id>          Site a comparar (ex.: comandotorrents, torrentdosfilmes)
 *   --port=<n>           Porta do resolver TS (default: 8701)
 *   --rust-port=<n>      Porta do resolver Rust (default: porta TS + 100)
 *   --queries=<csv>      Queries CSV; vazio = defaults do site
 *   --host=<h>           Host dos resolvers (default: 127.0.0.1)
 *   --timeout-ms=<n>     Timeout por request em ms (default: 20000)
 *
 * Para cada query o script:
 *   1. GET /search?q= no TS
 *   2. GET /search?q= no Rust
 *   3. Extrai releases (título + magnet/btih) de cada HTML
 *   4. Extrai botões (/resolve URLs) de cada HTML
 *   5. Compara os conjuntos e reporta divergências
 *
 * Exit 0 se zero divergências, exit 1 se houver.
 *
 * Formato de saída:
 *   rust.resolver.<site>.diff — linhas de divergência no stdout
 */
import { parseArgs } from 'node:util';

// ── Parse de argumentos ──────────────────────────────────────────────────────
const { values, positionals } = parseArgs({
  options: {
    site: { type: 'string' },
    port: { type: 'string', default: '8701' },
    'rust-port': { type: 'string' },
    queries: { type: 'string', default: '' },
    host: { type: 'string', default: '127.0.0.1' },
    'timeout-ms': { type: 'string', default: '20000' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`Uso: node scripts/rust/resolver-diff.mjs --site=<id> [--port=<n>] [--rust-port=<n>] [--queries=<csv>]

Flags:
  --site=<id>          Site a comparar (obrigatório)
  --port=<n>           Porta do resolver TS (default: 8701)
  --rust-port=<n>      Porta do resolver Rust (default: porta TS + 100)
  --queries=<csv>      Queries CSV; vazio = defaults por site
  --host=<h>           Host dos resolvers (default: 127.0.0.1)
  --timeout-ms=<n>     Timeout por request (default: 20000)
  --help               Esta mensagem`);
  process.exit(0);
}

const site = values.site;
if (!site) {
  console.error('[resolver-diff] --site é obrigatório');
  process.exit(2);
}

const tsPort = Number(values.port);
const rustPort = Number(values['rust-port'] ?? String(tsPort + 100));
const host = values.host;
const timeoutMs = Number(values['timeout-ms']);
const queriesArg = values.queries;

// ── Queries default por site (as mesmas usadas nos testes TS) ────────────────
const DEFAULT_QUERIES = {
  comandotorrents: ['deadpool', 'avatar 2', 'game of thrones'],
  torrentdosfilmes: ['deadpool', 'avatar 2', 'breaking bad'],
  vacatorrent: ['deadpool', 'avatar', 'the last of us'],
  nerdfilmes: ['deadpool', 'avatar', 'witcher'],
  bludv: ['deadpool', 'avatar', 'fundamental'],
  redetorrent: ['deadpool', 'avatar', 'game of thrones'],
  apachetorrent: ['deadpool', 'avatar', 'one piece'],
  hdrtorrents: ['deadpool', 'avatar', 'dune'],
};

const queries = queriesArg
  ? queriesArg.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_QUERIES[site] || [];

if (queries.length === 0) {
  console.error(`[resolver-diff] sem queries para "${site}" (use --queries=csv ou adicione a DEFAULT_QUERIES)`);
  process.exit(2);
}

// ── Helpers de HTTP ──────────────────────────────────────────────────────────
const controller = () => new AbortController();

/** Faz GET /search?q= e retorna o body texto; lança em erro de rede/HTTP. */
async function fetchSearch(port, query) {
  const url = `http://${host}:${port}/search?q=${encodeURIComponent(query)}`;
  const ctrl = controller();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} em ${url}: ${body.slice(0, 200)}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Extração de releases do HTML ─────────────────────────────────────────────
/**
 * Extrai releases do HTML retornado por /search.
 * Formato esperado:
 *   <div class="release">
 *     <div class="title"><a href="...">título</a></div>
 *     ...
 *   </div>
 *
 * Retorna array de { title, href, btih } onde:
 *   - title: texto do <a> dentro de .title
 *   - href: atributo href do <a> (pode ser /resolve?url=... ou magnet:...)
 *   - btih: infoHash extraído do magnet (btih=) ou null
 */
function extractReleases(html) {
  const releases = [];
  // Encontra cada bloco <div class="release">...</div>
  // Usa regex não-gulosa para capturar o bloco completo até o próximo </div> de .release
  const releaseRe = /<div class="release">([\s\S]*?)<\/div>/g;
  let releaseMatch;
  while ((releaseMatch = releaseRe.exec(html)) !== null) {
    const block = releaseMatch[1];
    // Extrai título e href do link dentro de <div class="title">
    const titleRe = /<div class="title">\s*<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
    const titleMatch = block.match(titleRe);
    if (!titleMatch) continue;
    const href = decodeHtmlEntities(titleMatch[1]);
    const title = decodeHtmlEntities(titleMatch[2].replace(/<[^>]+>/g, '').trim());

    // Extrai btih do magnet (se o href for magnet:)
    let btih = null;
    const magnetMatch = href.match(/btih=([a-fA-F0-9]{40})/i);
    if (magnetMatch) {
      btih = magnetMatch[1].toLowerCase();
    }

    releases.push({ title, href, btih });
  }
  return releases;
}

/**
 * Extrai URLs de botão /resolve do HTML.
 * São links <a href="/resolve?url=...&i=...&h=...&n=..."> dentro de .release.
 * Retorna array de { url, releaseTitle } normalizados.
 */
function extractButtons(html) {
  const buttons = [];
  const releaseRe = /<div class="release">([\s\S]*?)<\/div>/g;
  let releaseMatch;
  while ((releaseMatch = releaseRe.exec(html)) !== null) {
    const block = releaseMatch[1];
    // Título da release (para contexto)
    const titleRe = /<div class="title">\s*<a[^>]*>([\s\S]*?)<\/a>/;
    const titleMatch = block.match(titleRe);
    const relTitle = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : '(sem título)';

    // Todos os href que contêm /resolve? (incluindo o do título e eventuais botões extras)
    const resolveRe = /href="([^"]*\/resolve\?[^"]*)"/g;
    let resolveMatch;
    while ((resolveMatch = resolveRe.exec(block)) !== null) {
      buttons.push({
        url: decodeHtmlEntities(resolveMatch[1]),
        releaseTitle: relTitle,
      });
    }
  }
  return buttons;
}

// ── Decodificação de entidades HTML mínimas ──────────────────────────────────
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

// ── Comparação de conjuntos ──────────────────────────────────────────────────
/**
 * Compara releases TS vs Rust e retorna lista de divergências.
 * A comparação é por conjunto de (title, btih) — a ordem não importa.
 */
function compareReleases(tsItems, rustItems) {
  const diffs = [];

  // Chave de comparação: título normalizado + btih (ou href se sem btih)
  const keyOf = (item) => {
    const normTitle = item.title.toLowerCase().trim();
    return item.btih ? `${normTitle}|btih:${item.btih}` : `${normTitle}|href:${item.href}`;
  };

  const tsKeys = new Set(tsItems.map(keyOf));
  const rustKeys = new Set(rustItems.map(keyOf));

  // Releases que estão no TS mas não no Rust
  for (const item of tsItems) {
    const k = keyOf(item);
    if (!rustKeys.has(k)) {
      diffs.push(`TS tem, Rust não: "${item.title}" (${item.btih ? `btih=${item.btih}` : 'sem magnet'})`);
    }
  }

  // Releases que estão no Rust mas não no TS
  for (const item of rustItems) {
    const k = keyOf(item);
    if (!tsKeys.has(k)) {
      diffs.push(`Rust tem, TS não: "${item.title}" (${item.btih ? `btih=${item.btih}` : 'sem magnet'})`);
    }
  }

  return diffs;
}

/**
 * Compara botões /resolve TS vs Rust por conjunto de URLs normalizadas.
 */
function compareButtons(tsButtons, rustButtons) {
  const diffs = [];
  // Normaliza a URL extraindo os parâmetros relevantes (url, i, h, n)
  const normalizeResolve = (rawUrl) => {
    try {
      const u = new URL(rawUrl, `http://${host}`);
      const inner = u.searchParams.get('url') || '';
      const i = u.searchParams.get('i') || '';
      const h = u.searchParams.get('h') || '';
      return `${inner}|i=${i}|h=${h}`;
    } catch {
      return rawUrl;
    }
  };

  const tsKeys = new Set(tsButtons.map((b) => normalizeResolve(b.url)));
  const rustKeys = new Set(rustButtons.map((b) => normalizeResolve(b.url)));

  for (const b of tsButtons) {
    const k = normalizeResolve(b.url);
    if (!rustKeys.has(k)) {
      diffs.push(`Botão TS sem par no Rust: "${b.releaseTitle}" → ${b.url.slice(0, 120)}`);
    }
  }
  for (const b of rustButtons) {
    const k = normalizeResolve(b.url);
    if (!tsKeys.has(k)) {
      diffs.push(`Botão Rust sem par no TS: "${b.releaseTitle}" → ${b.url.slice(0, 120)}`);
    }
  }

  return diffs;
}

// ── Principal ────────────────────────────────────────────────────────────────
console.log(`rust.resolver.${site}.diff — comparando TS(:${tsPort}) vs Rust(:${rustPort})`);
console.log(`queries: ${queries.join(', ')}`);
console.log('');

let totalDiffs = 0;

for (const q of queries) {
  // Busca em paralelo nos dois resolvers
  let tsHtml, rustHtml;
  try {
    [tsHtml, rustHtml] = await Promise.all([
      fetchSearch(tsPort, q),
      fetchSearch(rustPort, q),
    ]);
  } catch (err) {
    console.error(`[diff] ${site} q="${q}": erro de rede — ${err.message}`);
    totalDiffs++;
    continue;
  }

  // Extrai releases e botões de cada lado
  const tsReleases = extractReleases(tsHtml);
  const rustReleases = extractReleases(rustHtml);
  const tsButtons = extractButtons(tsHtml);
  const rustButtons = extractButtons(rustHtml);

  // Compara releases
  const releaseDiffs = compareReleases(tsReleases, rustReleases);
  // Compara botões
  const buttonDiffs = compareButtons(tsButtons, rustButtons);

  const queryDiffs = releaseDiffs.length + buttonDiffs.length;
  if (queryDiffs === 0) {
    console.log(`[ok]   ${site} q="${q}": ${tsReleases.length} releases, ${tsButtons.length} botões — paridade ✓`);
  } else {
    totalDiffs += queryDiffs;
    console.log(`[diff] ${site} q="${q}": ${queryDiffs} divergência(s)`);
    for (const d of releaseDiffs) console.log(`  - ${d}`);
    for (const d of buttonDiffs) console.log(`  - ${d}`);
  }
}

console.log(`\n${totalDiffs} divergência(s) total(is)`);
process.exit(totalDiffs > 0 ? 1 : 0);
