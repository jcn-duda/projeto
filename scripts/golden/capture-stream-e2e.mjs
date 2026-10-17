#!/usr/bin/env node
/**
 * Captura o corpus de PONTA A PONTA do `/stream`: faz requisições REAIS ao
 * addon rodando e grava, por caso, o request e a resposta em
 * `rust/golden/stream-e2e/cases/<id>/`.
 *
 * Por que existe: os goldens de função provam o núcleo isolado, mas não o que o
 * orquestrador Rust terá de reproduzir — o corpo JSON que o Stremio recebe,
 * com os cortes de debrid, o aviso de lista vazia e o host montado na resposta.
 * Este corpus é a MEDIÇÃO dessa ponta; o manifesto diz explicitamente o que ele
 * ainda NÃO cobre (metadados, itens crus por indexer, cache do debrid).
 *
 * REGRAS DE SEGURANÇA (o corpus é commitado):
 * - NUNCA grava chave de debrid, host real ou token: o segmento de config é
 *   substituído por `{{config}}` (o sha256 dele vai no request/manifesto), o
 *   token por `{{token}}`, a origem do addon por `{{base}}` e `sig` por
 *   `{{sig}}`;
 * - `Host` não é gravado; só headers de resposta relevantes e determinísticos
 *   (`content-type`, `cache-control`), nunca `Date`;
 * - `request.json`/`response.json` não têm timestamp: a data ISO fica SÓ no
 *   manifesto (provenance).
 *
 * Uso:
 *   node scripts/golden/capture-stream-e2e.mjs --dry-run --cases scripts/golden/casos.example.json
 *   node scripts/golden/capture-stream-e2e.mjs --base http://127.0.0.1:7000 \
 *     --token "$TOKEN" --user-config "$SEGMENTO" --cases scripts/golden/casos.example.json
 *
 * Sem dependência nova: só `node:fs`, `node:path`, `node:crypto`, `node:url`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(REPO, 'rust', 'golden', 'stream-e2e');
const CASES_DIR = path.join(OUT_DIR, 'cases');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');
const FORMAT_CASES = 'adom-stream-e2e-cases/1';
const FORMAT_MANIFEST = 'adom-stream-e2e/1';
const DEFAULT_UA = 'adom-stream-e2e/1';
const REQUEST_HEADERS = ['user-agent'];
const RESPONSE_HEADERS = ['content-type', 'cache-control'];

/** O que o corpus NÃO mede — vai no manifesto para não virar promessa implícita. */
const GAPS = [
  'metadados da obra (Cinemeta/TMDB): o /stream não os devolve; dependem de /internal/search/meta (F1.1)',
  'itens crus por indexer (antes de filtro/ranking/debrid) e o cache raw:v1: dependem das rotas internas de busca',
  'respostas de cache do debrid (⚡ por hash, arquivos do pack, tamanhos): dependem de rotas internas de debrid',
  'o segmento de config e a assinatura HMAC nunca são gravados (sig vira {{sig}}); replay exige --user-config e o segredo do operador',
  'relógio: Date/ETag/age e duração de cada requisição não entram no corpus',
  'estado do acervo (banco de magnets / índice de releases) no instante da captura não é versionado',
  'ordem de chaves do JSON e ordem da lista de streams são as do Node naquele instante; a comparação de sombra as mascara',
];

class CaptureError extends Error {}

function fail(message) {
  throw new CaptureError(String(message));
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseArgs(argv) {
  const args = {
    base: null, token: null, userConfig: null, cases: null, dryRun: false, userAgent: DEFAULT_UA,
  };
  const need = (flag, value) => {
    if (value === undefined || value.startsWith('--')) fail(`${flag} exige um valor`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--base') args.base = need(arg, argv[++i]);
    else if (arg === '--token') args.token = need(arg, argv[++i]);
    else if (arg === '--user-config') args.userConfig = need(arg, argv[++i]);
    else if (arg === '--cases') args.cases = need(arg, argv[++i]);
    else if (arg === '--user-agent') args.userAgent = need(arg, argv[++i]);
    else fail(`flag desconhecida: ${arg}`);
  }
  return args;
}

/** Caminho absoluto: `--cases` relativo é ancorado no repo, como nos goldens. */
function resolveCliPath(value, fallback) {
  if (!value) return fallback ? path.join(REPO, fallback) : null;
  return path.isAbsolute(value) ? value : path.join(REPO, value);
}

/**
 * Valida o arquivo de casos. `id` vira NOME DE DIRETÓRIO, então o formato é
 * fechado: minúsculas, dígitos, `.`, `_` e `-`. `type`/`id` são os do
 * protocolo Stremio; o caso pode trazer `label` só para leitura humana.
 */
function loadCases(casesPath) {
  let raw;
  try {
    raw = fs.readFileSync(casesPath, 'utf8');
  } catch {
    fail(`arquivo de casos ausente ou ilegível: ${path.relative(REPO, casesPath)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    fail(`arquivo de casos não é JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') fail('arquivo de casos precisa ser um objeto');
  if (parsed.format !== undefined && parsed.format !== FORMAT_CASES) {
    fail(`format desconhecido em casos: ${JSON.stringify(parsed.format)} (esperado ${FORMAT_CASES})`);
  }
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) fail('arquivo de casos sem "cases"');

  const seen = new Set();
  const cases = parsed.cases.map((item) => {
    if (!item || typeof item !== 'object') fail(`caso inválido: ${JSON.stringify(item)}`);
    const id = String(item.id ?? '');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) fail(`caso com id inseguro para diretório: ${JSON.stringify(id)}`);
    if (seen.has(id)) fail(`id duplicado no arquivo de casos: ${id}`);
    seen.add(id);
    const type = String(item.type ?? '');
    if (type !== 'movie' && type !== 'series') fail(`caso ${id}: type deve ser movie ou series`);
    const streamId = String(item.id_stream ?? item.stream_id ?? '');
    if (!/^tt\d+(?::\d{1,4}){0,2}$/.test(streamId)) {
      fail(`caso ${id}: stream_id deve ser tt<dígitos>[:temporada[:episódio]]`);
    }
    return { id, type, streamId, label: typeof item.label === 'string' ? item.label : '' };
  });
  return cases;
}

function normalizeBase(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`--base não é URL válida: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('--base precisa ser http(s)');
  if (parsed.search || parsed.hash) fail('--base não pode ter query nem fragmento');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed;
}

/** Contexto de mascaramento: tudo que é segredo/host sai do corpus. */
function maskingContext({ base, token, userConfig }) {
  return {
    baseOrigin: base ? base.origin + base.pathname : '',
    userConfig: userConfig || '',
    token: token || '',
  };
}

/**
 * Mascara texto livre (URLs dentro do corpo). Regras, nesta ordem: segmento de
 * config, token, origem do addon (inclusive quando o `PUBLIC_URL` do operador
 * difere do `--base`: aí o path `/resolve/`/`/configure` denuncia) e HMAC `sig`.
 */
function maskText(text, ctx) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  if (ctx.userConfig) out = out.split(`/${ctx.userConfig}`).join('/{{config}}');
  if (ctx.token) out = out.split(ctx.token).join('{{token}}');
  out = out.replace(/https?:\/\/[^\s"'<>)\]]+/g, (url) => {
    try {
      const parsed = new URL(url);
      const isAddon = (ctx.baseOrigin && `${parsed.origin}${parsed.pathname}`.startsWith(ctx.baseOrigin))
        || parsed.pathname.includes('/resolve/')
        || parsed.pathname.endsWith('/configure');
      return isAddon ? `{{base}}${url.slice(parsed.origin.length)}` : url;
    } catch {
      return url;
    }
  });
  return out.replace(/([?&]sig=)[^&\s"']+/g, '$1{{sig}}');
}

/** Mascara recursivamente o corpo JSON (valores string; objetos/arrays descem). */
function maskValue(value, ctx) {
  if (typeof value === 'string') return maskText(value, ctx);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = maskValue(item, ctx);
    return out;
  }
  return value;
}

/** JSON determinístico: 2 espaços + newline final (mesmo padrão dos goldens). */
function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return sha256(fs.readFileSync(absPath));
}

function streamPath(userConfig, target) {
  const prefix = userConfig ? `/${userConfig}` : '';
  // `:` do S/E é legal em segmento de path e é assim que o Stremio chama; não
  // percent-encodar mantém o corpus igual à requisição real.
  return `${prefix}/stream/${target.type}/${target.streamId}.json`;
}

/** Path para o CORPUS: a config nunca é gravada (pode conter a chave debrid). */
function maskedStreamPath(ctx, target) {
  return `${ctx.userConfig ? '/{{config}}' : ''}${streamPath('', target)}`;
}

function pickHeaders(headers, allow) {
  const out = {};
  for (const name of allow) {
    const value = headers.get(name);
    if (value != null) out[name] = String(value);
  }
  return out;
}

/**
 * Uma requisição REAL. Sem rede, a mensagem tem que dizer o que houve — não
 * pode parecer "corpus vazio".
 */
async function captureCase({ target, base, token, userAgent, ctx }) {
  const url = `${base.origin}${base.pathname}${streamPath(ctx.userConfig, target)}`;
  const headers = { 'user-agent': userAgent };
  if (token) headers['x-indexer-test-token'] = token;

  let response;
  try {
    response = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message || err;
    fail(
      `sem rede até ${base.origin}: ${cause}\n` +
      '  confira se o addon está no ar (npm run docker:up) e o --base (7000 local / 7100 conforme o painel)',
    );
  }
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const maskedBody = body === null ? null : maskValue(body, ctx);
  const cacheMaxAge = maskedBody && typeof maskedBody.cacheMaxAge === 'number' ? maskedBody.cacheMaxAge : null;

  const request = {
    method: 'GET',
    // O path guarda o FORMATO, não a credencial: a config vira {{config}}.
    path: maskedStreamPath(ctx, target),
    headers: pickHeaders(new Headers(headers), REQUEST_HEADERS),
    user_config_sha256: ctx.userConfig ? sha256(ctx.userConfig) : null,
  };
  const responseDoc = {
    status: response.status,
    headers: pickHeaders(response.headers, RESPONSE_HEADERS),
    cacheMaxAge,
    ...(maskedBody !== null ? { body: maskedBody } : { body_raw: maskText(text, ctx) }),
  };
  return { request, response: responseDoc };
}

function plan(cases, ctx) {
  return cases.map((target) => ({
    id: target.id,
    label: target.label,
    type: target.type,
    stream_id: target.streamId,
    path: maskedStreamPath(ctx, target),
    dir: `cases/${target.id}`,
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const casesPath = resolveCliPath(args.cases, null) || path.join(REPO, 'scripts', 'golden', 'casos.example.json');
  const cases = loadCases(casesPath).sort((a, b) => a.id.localeCompare(b.id));
  const base = args.base ? normalizeBase(args.base) : null;
  const ctx = maskingContext({ base, token: args.token, userConfig: args.userConfig });
  const planRows = plan(cases, ctx);

  if (args.dryRun) {
    // Modo seco: valida casos e imprime o plano, sem tocar a rede nem o disco.
    console.log(`[stream-e2e] dry-run — ${cases.length} caso(s) de ${path.relative(REPO, casesPath)}`);
    console.log(`[stream-e2e] saída: ${path.relative(REPO, CASES_DIR)}/`);
    for (const row of planRows) {
      console.log(`  - ${row.id} (${row.type}) ${row.stream_id} → ${row.path}`);
    }
    console.log('[stream-e2e] NÃO capturado (ver README/manifesto):');
    for (const gap of GAPS) console.log(`  · ${gap}`);
    return;
  }

  if (!base) fail('--base é obrigatório fora do --dry-run (ex.: http://127.0.0.1:7000)');
  if (!args.cases) fail('--cases é obrigatório (arquivo de casos validado antes de qualquer rede)');
  const startedAt = new Date().toISOString();
  const manifestCases = [];

  for (const target of cases) {
    const { request, response } = await captureCase({
      target, base, token: args.token, userAgent: args.userAgent, ctx,
    });
    const caseDir = path.join(CASES_DIR, target.id);
    const requestSha = writeJson(path.join(caseDir, 'request.json'), request);
    const responseSha = writeJson(path.join(caseDir, 'response.json'), response);
    manifestCases.push({
      id: target.id,
      label: target.label,
      type: target.type,
      stream_id: target.streamId,
      dir: `cases/${target.id}`,
      status: response.status,
      cacheMaxAge: response.cacheMaxAge,
      files: { 'request.json': requestSha, 'response.json': responseSha },
    });
    console.log(`[stream-e2e] ${target.id}: HTTP ${response.status} cacheMaxAge=${response.cacheMaxAge}`);
  }

  const manifest = {
    format: FORMAT_MANIFEST,
    capturedAt: startedAt,
    node: process.version,
    base: '{{base}}',
    user_config_sha256: ctx.userConfig ? sha256(ctx.userConfig) : null,
    cases_file: path.relative(REPO, casesPath).split(path.sep).join('/'),
    cases: manifestCases,
    notCaptured: GAPS,
  };
  // O manifesto NÃO entra no próprio hash: ele é o índice dos arquivos.
  writeJson(MANIFEST, manifest);
  console.log(`[stream-e2e] OK: ${manifestCases.length} caso(s) em ${path.relative(REPO, CASES_DIR)}; manifesto em ${path.relative(REPO, MANIFEST)}`);
}

main().catch((err) => {
  if (err instanceof CaptureError) {
    console.error(`[stream-e2e] erro: ${err.message}`);
    process.exit(1);
  }
  console.error('[stream-e2e] erro inesperado:', err);
  process.exit(2);
});
