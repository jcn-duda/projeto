#!/usr/bin/env node
/**
 * Captura o corpus de PONTA A PONTA do `/stream`: faz requisições REAIS ao
 * addon rodando e grava, por caso, o request e a resposta em
 * `rust/golden/stream-e2e/cases/<id>/`.
 *
 * F4.4: o `/stream` do Node está aposentado (410/503) — a captura só funciona
 * contra uma IMAGEM/COMMIT anterior ao F4.4 (com `GATEWAY=off`), que é também
 * de onde saiu o corpus atual. O gate do corte não captura: ele REPLAIA o
 * corpus (`stream_e2e_parity` 51/51, `stream_frozen_parity` 16/16).
 *
 * Por que existe: os goldens de função provam o núcleo isolado, mas não o que o
 * orquestrador Rust terá de reproduzir — o corpo JSON que o Stremio recebe,
 * com os cortes de debrid, o aviso de lista vazia e o host montado na resposta.
 * Este corpus é a MEDIÇÃO dessa ponta; o manifesto diz explicitamente o que ele
 * ainda NÃO cobre (metadados, itens crus por indexer, cache do debrid).
 *
 * Com `--with-internal` o MESMO caso ganha também as entradas internas que o
 * orquestrador Rust consome (`inputs/`): meta, config, collect e o
 * índice/banco instantâneo. O `/stream` continua sendo a resposta normal do
 * Node; as rotas internas falam com o MESMO processo (loopback, 7100), então a
 * captura precisa rodar DENTRO da rede do container:
 *
 *   docker run --rm --network container:stremio-adom \
 *     -v "$PWD:/repo:ro" -v "$PWD/.tmp-e2e-pilot:/out" \
 *     --env-file .env --entrypoint node stremioadom-adom:latest \
 *     /repo/scripts/golden/capture-stream-e2e.mjs --out /out \
 *     --base http://127.0.0.1:7100 --with-internal \
 *     --user-config e30 --cases scripts/golden/casos-stream-e2e.json
 *
 * `--shadow-dir <dir>` faz o `/stream` com `X-Adom-Shadow-Id: <caso>` +
 * `X-Adom-Shadow-Frozen: 1` e copia do record do shadow (MESMO run) o que só ele
 * grava: `proven-quality.json`, `apply-debrid.json`, `files.json`,
 * `instant.json`, `fallback.json` e as versões EXATAS de `index.json`/`debrid.json`.
 * Sem esses arquivos o replay Rust trata item provado como "sem resolução" e a
 * cota de qualidade deixa passar um stream que o Node cortou (Cidade de Deus:
 * apachetorrent 15 seeders → 720p).
 *
 * O token (`--token` ou `JACKETT_TEST_TOKEN`) NUNCA é impresso nem gravado.
 *
 * REGRAS DE SEGURANÇA (o corpus é commitado):
 * - NUNCA grava chave de debrid, host real ou token: o segmento de config é
 *   substituído por `{{config}}` (o sha256 dele vai no request/manifesto), o
 *   token por `{{token}}`, a origem do addon por `{{base}}` e `sig` por
 *   `{{sig}}`;
 * - `Host` não é gravado; só headers de resposta relevantes e determinísticos
 *   (`content-type`, `cache-control`), nunca `Date`;
 * - itens crus perdem `downloadUrl` (carrega o `jackett_apikey`);
 * - `request.json`/`response.json`/`inputs/*` não têm timestamp: a data ISO
 *   fica SÓ no manifesto (provenance, por caso quando há merge).
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
const DEFAULT_OUT = path.join(REPO, 'rust', 'golden', 'stream-e2e');
const FORMAT_CASES = 'adom-stream-e2e-cases/1';
const FORMAT_MANIFEST = 'adom-stream-e2e/1';
const DEFAULT_UA = 'adom-stream-e2e/1';
const REQUEST_HEADERS = ['user-agent'];
const RESPONSE_HEADERS = ['content-type', 'cache-control'];
/** Rotas internas (mesmo alvo do `/stream`: o Node, 7100 no gateway). */
const INTERNAL_PATHS = {
  meta: '/internal/search/meta',
  config: '/internal/search/config',
  index: '/internal/search/index',
  collect: '/internal/search/collect',
};
/** Prazos das rotas internas (o `deadline_at` absoluto é recalculado por chamada). */
const META_DEADLINE_MS = 60_000;
const INDEX_DEADLINE_MS = 20_000;
const CONFIG_DEADLINE_MS = 15_000;
const DEFAULT_INTERNAL_DEADLINE_MS = 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/**
 * Fixtures que SÓ o record do shadow grava e que o build do Rust consome:
 * a qualidade PROVADA pelo arquivo (`proven-quality`/`apply-debrid`), os
 * tamanhos de arquivo do debrid e o conjunto `instant` real do sort. O `index`
 * do shadow é o lote EXATO que o build usou (o derivado da rota é uma re-leitura).
 */
const SHADOW_INPUTS = [
  'index.json',
  'debrid.json',
  'proven-quality.json',
  'apply-debrid.json',
  'files.json',
  'instant.json',
  'fallback.json',
];

// Lacunas que o corpus declara. As duas primeiras são FECHADAS por
// `--with-internal` (para os casos capturados nesse modo); as demais seguem.
const GAP_META = 'metadados da obra (Cinemeta/TMDB): o /stream não os devolve; capturados por /internal/search/meta com --with-internal';
const GAP_COLLECT = 'itens crus por indexer (antes de filtro/ranking/debrid) e o cache raw:v1: capturados por /internal/search/collect com --with-internal';
// A rota Node da checagem de debrid saiu na R3 (checagem nativa incondicional):
// o corpus novo só ganha debrid pelo record do shadow ou pelo corpus congelado.
const GAP_DEBRID = 'respostas de cache do debrid (⚡ por hash, arquivos do pack, tamanhos): a rota interna saiu na R3; inputs/debrid.json só vem do record do shadow (--shadow-dir) ou do corpus já congelado';
const GAPS_BASE = [
  GAP_DEBRID,
  'o segmento de config e a assinatura HMAC nunca são gravados (sig vira {{sig}}); replay exige --user-config (e30 decodifica {}) e o segredo do operador',
  'relógio: Date/ETag/age e duração de cada requisição não entram no corpus',
  'estado do acervo (banco de magnets / índice de releases) no instante da captura não é versionado',
  'ordem de chaves do JSON e ordem da lista de streams são as do Node naquele instante; a comparação de sombra as mascara',
];
/** Lacunas que o modo interno ACRESCENTA (o que ele ainda não fecha). */
const GAPS_INTERNAL = [
  'inputs internos só existem para casos capturados com --with-internal; os demais seguem com request/response apenas',
  '--shadow-dir copia proven-quality/apply-debrid/files/instant/fallback e as versões exatas de index/debrid do record; sem ele, inputs/index.json é derivado de /internal/search/index e a qualidade provada NÃO é capturável (o item provado volta como "sem resolução" no replay)',
  'o record do shadow não grava config.json (o gateway o hidrata): inputs/config.json continua vindo de /internal/search/config',
  'as fixtures internas vêm de chamadas próprias DEPOIS do /stream: dependem do cache raw:v1/davail quente para descrever a mesma lista (sem ele o diff acusa ruído de coleta, não pipeline)',
];

class CaptureError extends Error {}

function fail(message) {
  throw new CaptureError(String(message));
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseArgs(argv) {
  const args = {
    base: null,
    token: process.env.JACKETT_TEST_TOKEN || null,
    userConfig: null,
    cases: null,
    out: null,
    dryRun: false,
    userAgent: DEFAULT_UA,
    withInternal: false,
    internalBase: null,
    internalDeadlineMs: DEFAULT_INTERNAL_DEADLINE_MS,
    shadowDir: null,
    merge: false,
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
    else if (arg === '--out') args.out = need(arg, argv[++i]);
    else if (arg === '--merge') args.merge = true;
    else if (arg === '--with-internal') args.withInternal = true;
    else if (arg === '--internal-base') args.internalBase = need(arg, argv[++i]);
    else if (arg === '--shadow-dir') args.shadowDir = need(arg, argv[++i]);
    else if (arg === '--internal-deadline-ms') {
      const raw = need(arg, argv[++i]);
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) fail('--internal-deadline-ms precisa ser inteiro positivo (ms)');
      args.internalDeadlineMs = value;
    } else fail(`flag desconhecida: ${arg}`);
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
  // `URL.pathname` não aceita string vazia (atribuir '' devolve '/'): guardo o
  // prefixo numa propriedade própria para não montar `//stream/...`.
  parsed.prefix = parsed.pathname.replace(/\/+$/, '');
  return parsed;
}

/** As rotas internas só existem em loopback: host fora daí é erro de uso. */
function assertInternalLoopback(base) {
  if (!LOOPBACK_HOSTS.has(base.hostname)) {
    fail(
      `--internal-base precisa ser loopback (127.0.0.1/localhost), veio ${base.hostname}\n` +
      '  as rotas /internal/* só respondem ao próprio processo; rode a captura na rede do container\n' +
      '  (docker run --network container:stremio-adom) e use http://127.0.0.1:7100',
    );
  }
}

/** Contexto de mascaramento: tudo que é segredo/host sai do corpus. */
function maskingContext({ base, token, userConfig, internalBase }) {
  const originOf = (parsed) => (parsed ? parsed.origin + parsed.prefix : '');
  return {
    baseOrigin: originOf(base),
    internalOrigin: internalBase && internalBase.origin !== base?.origin ? originOf(internalBase) : '',
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
        || (ctx.internalOrigin && `${parsed.origin}${parsed.pathname}`.startsWith(ctx.internalOrigin))
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

/**
 * Remove transporte com credencial antes de gravar fixture interna. O
 * `downloadUrl` do Jackett carrega `jackett_apikey`; o build não o usa (o magnet
 * já veio resolvido), então gravá-lo só vazaria segredo — mesma regra de
 * `stripSecrets` do antigo store do corpus congelado.
 */
function stripTransportSecrets(value) {
  if (Array.isArray(value)) return value.map(stripTransportSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'downloadUrl') continue;
    out[key] = stripTransportSecrets(item);
  }
  return out;
}

/** JSON determinístico: 2 espaços + newline final (mesmo padrão dos goldens). */
function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return sha256(fs.readFileSync(absPath));
}

/**
 * Copia VERBATIM um fixture gravado pelo próprio addon no dir do shadow. O
 * record do shadow já mascara encoded/origem/sig e remove `downloadUrl`;
 * a varredura de credencial é o último portão antes de gravar no corpus.
 *
 * O que NÃO condena: `passkey`/`apikey=` DENTRO de `magnet:` de tracker público
 * — é dado público do torrent (o corpus congelado também os carrega). O
 * que condena é o parâmetro do Jackett (`jackett_apikey`) ou o valor de um
 * segredo do operador presente no ambiente.
 */
function copyShadowInput(absPath, source) {
  const bytes = fs.readFileSync(source);
  const text = bytes.toString('utf8');
  const operatorSecrets = ['JACKETT_TEST_TOKEN', 'JACKETT_API_KEY', 'DEBRID_API_KEY', 'RESOLVE_SECRET']
    .map((name) => process.env[name])
    .filter((value) => typeof value === 'string' && value.length >= 8);
  if (/jackett_apikey/i.test(text) || operatorSecrets.some((secret) => text.includes(secret))) {
    fail(`credencial em claro em ${source}; recusando copiar para o corpus`);
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, bytes);
  return sha256(bytes);
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
 * Uma requisição REAL ao `/stream`. Sem rede, a mensagem tem que dizer o que
 * houve — não pode parecer "corpus vazio".
 */
async function captureCase({ target, base, token, userAgent, ctx, shadowId }) {
  const url = `${base.origin}${base.prefix}${streamPath(ctx.userConfig, target)}`;
  const headers = { 'user-agent': userAgent };
  if (token) headers['x-indexer-test-token'] = token;
  // `--shadow-dir`: a MESMA resposta de produção, mas o addon grava o caso
  // congelado completo (proven-quality/apply-debrid/files/instant) no dir do
  // shadow. Só o request 2 (`Frozen: 1`) roda sem SWR, que é o que queremos medir.
  if (shadowId) {
    headers['x-adom-shadow-id'] = shadowId;
    headers['x-adom-shadow-frozen'] = '1';
  }

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

// ── rotas internas (--with-internal) ───────────────────────────────────────

/**
 * POST numa rota interna. Falha de rede/serviço é ERRO da captura (não grava
 * caso pela metade): o corpus não pode parecer completo sem as entradas.
 * O token vai só no header e nunca entra em mensagem/log.
 */
async function postInternal({ base, token, route, body, timeoutMs, label }) {
  const url = `${base.origin}${base.prefix}${INTERNAL_PATHS[route]}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': DEFAULT_UA,
        ...(token ? { 'x-indexer-test-token': token } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message || err;
    fail(
      `${label}: sem rede até ${base.origin}: ${cause}\n` +
      '  /internal/* só existe em loopback + token; rode a captura na rede do container (--network container:stremio-adom)',
    );
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${label}: HTTP ${response.status} sem JSON: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    fail(`${label}: HTTP ${response.status} ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  if (parsed?.ok !== true) fail(`${label}: ok!=true ${JSON.stringify(parsed).slice(0, 400)}`);
  return parsed;
}

/** `catalogYearOf` do `search-names.ts`: divergência > 2 anos troca pelo TMDB. */
function catalogYearOf(metaYear, tmdbYear) {
  const meta = Number(String(metaYear ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  const tmdb = Number(String(tmdbYear ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (meta && tmdb && Math.abs(meta - tmdb) > 2) return tmdbYear ?? null;
  return metaYear || tmdbYear || null;
}

/** `buildSearchQuery` do `search-names.ts` (nome + ano, ou nome + SxxEyy). */
function buildSearchQuery(meta, { season, episode }) {
  const name = meta?.name || meta?.title || '';
  const year = meta?.year ? String(meta.year).slice(0, 4) : '';
  if (season != null && episode != null) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `${name} S${s}E${e}`.trim();
  }
  return [name, year].filter(Boolean).join(' ').trim();
}

/** Aproximação do `normalizeTitle` só para decidir se o degrau original existe. */
function comparableTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `resolveOriginalStepName`: degrau só quando o original difere do primário. */
function originalStepName(original, primary) {
  if (!original || !primary) return null;
  return comparableTitle(original) !== comparableTitle(primary) ? original : null;
}

/**
 * `dedupeNames` do núcleo sem o `normalizeTitle` completo: dedupe por caixa e
 * espaço. Aproximação consciente — `names` só decide degraus de cascata na
 * coleta; o diff da lista pega qualquer diferença que importe.
 */
function dedupeNames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * `ptSweepQueryFor` (raiz pt-BR da varredura) sem o núcleo: mesmo gate estrito
 * (`pt === original` → sem varredura) e o corte de subtítulo mais comum
 * (`:`/` - `) quando a cabeça tem 2+ palavras. Aproximação: `franchise_root`
 * também remove marcador de sequência no fim, o que não é replicado aqui.
 */
function sweepQueryFor(titles) {
  const pt = typeof titles?.pt === 'string' ? titles.pt.trim() : '';
  if (!pt || pt === titles?.original) return null;
  const head = pt.split(/\s*[:：]\s*|\s+-\s+/)[0].trim();
  return (head.split(/\s+/).length >= 2 ? head : pt) || null;
}

/** Corpo do collect: os MESMOS campos que o orquestrador Rust manda. */
function collectBody({ encoded, target, queries, names, year, deadlineAt }) {
  const [, seasonRaw, episodeRaw] = target.streamId.split(':');
  const season = seasonRaw != null ? Number(seasonRaw) : null;
  const episode = episodeRaw != null ? Number(episodeRaw) : null;
  return {
    encoded,
    task_scope: 'all',
    query: queries.query,
    ...(queries.ptQuery ? { pt_query: queries.ptQuery } : {}),
    type: target.type,
    imdb: target.streamId.split(':')[0],
    ...(season != null ? { season } : {}),
    ...(episode != null ? { episode } : {}),
    ...(year != null ? { year } : {}),
    ...(names.length > 0 ? { names } : {}),
    ...(queries.sweepQuery ? { sweep_query: queries.sweepQuery } : {}),
    ...(queries.originalQuery ? { original_query: queries.originalQuery } : {}),
    deadline_at: deadlineAt,
  };
}

/**
 * Captura as entradas internas de UM caso: meta → config → índice (index/banco
 * instantâneo) → collect. Devolve os arquivos já no formato que o
 * `FrozenCase` do gate lê (`inputs/*.json`), sem tocar no disco.
 *
 * O debrid NÃO é capturado aqui: a rota Node da checagem saiu na R3 (checagem
 * nativa incondicional). `inputs/debrid.json` só chega pelo record do shadow
 * (`--shadow-dir`) ou pelo corpus já congelado.
 */
async function captureInternal({ base, token, encoded, target, ctx, deadlineMs }) {
  const metaResponse = await postInternal({
    base, token, route: 'meta', timeoutMs: META_DEADLINE_MS,
    label: `[internal] meta ${target.streamId}`,
    body: {
      encoded,
      type: target.type,
      id: target.streamId,
      include_multiwork: true,
      include_home_release: true,
    },
  });
  const meta = metaResponse.meta || {};
  const titles = metaResponse.titles || {};
  const [, seasonRaw, episodeRaw] = target.streamId.split(':');
  const season = seasonRaw != null ? Number(seasonRaw) : null;
  const episode = episodeRaw != null ? Number(episodeRaw) : null;
  const primaryName = meta?.name || titles.en || titles.original || titles.pt || metaResponse.imdb_id;
  const year = catalogYearOf(meta?.year, titles.year);
  const names = dedupeNames([meta?.name, titles.en, titles.pt, titles.original, ...(titles.br || [])]);
  const queries = {
    query: buildSearchQuery({ name: primaryName, year }, { season, episode }),
    ptQuery: titles.pt && titles.pt !== titles.original
      ? buildSearchQuery({ name: titles.pt, year: titles.year }, { season, episode })
      : null,
    originalQuery: originalStepName(titles.original, primaryName),
    sweepQuery: sweepQueryFor(titles),
  };
  if (!queries.query) fail(`[internal] meta ${target.streamId}: sem título para montar a query`);

  const config = await postInternal({
    base, token, route: 'config', timeoutMs: CONFIG_DEADLINE_MS,
    label: `[internal] config ${target.streamId}`,
    body: { encoded },
  });

  const released = typeof meta?.released === 'string' ? meta.released : null;
  const firstAired = typeof meta?.firstAired === 'string'
    ? meta.firstAired
    : (season != null && episode != null ? meta?.episodeAired?.[`${season}:${episode}`] ?? null : null);
  const indexResponse = await postInternal({
    base, token, route: 'index', timeoutMs: INDEX_DEADLINE_MS,
    label: `[internal] index ${target.streamId}`,
    body: {
      encoded,
      type: target.type,
      imdb: metaResponse.imdb_id,
      ...(season != null ? { season } : {}),
      ...(episode != null ? { episode } : {}),
      ...(names.length > 0 ? { names } : {}),
      ...(year != null ? { year } : {}),
      ...(released ? { released } : {}),
      ...(firstAired ? { first_aired: firstAired } : {}),
    },
  });
  const indexItems = Array.isArray(indexResponse.index_items) ? indexResponse.index_items : [];
  const instantItems = Array.isArray(indexResponse.instant_items) ? indexResponse.instant_items : [];

  const collectResponse = await postInternal({
    base, token, route: 'collect', timeoutMs: deadlineMs,
    label: `[internal] collect ${target.streamId}`,
    body: collectBody({
      encoded, target, queries, names, year,
      deadlineAt: Date.now() + deadlineMs,
    }),
  });
  const collectItems = Array.isArray(collectResponse.items) ? collectResponse.items : [];

  const files = {
    'inputs/meta.json': {
      key: `${target.type}:${target.streamId}`,
      meta: metaResponse.meta ?? null,
      titles: metaResponse.titles ?? null,
      collection: metaResponse.multiWork ?? null,
      homeReleaseAt: metaResponse.homeReleaseAt ?? null,
    },
    'inputs/config.json': config,
    // O gate lê `value.{servedFromIndex,instant,raw}`; o Node registra o lote
    // mesclado (índice + banco) em `raw.items`, e o Rust marca cada item de
    // `raw.items` como foto (`fromSnapshot`) na via rápida.
    'inputs/index.json': {
      key: `index:${target.type}:${metaResponse.imdb_id}`,
      value: {
        servedFromIndex: indexResponse.index_covered === true,
        instant: indexResponse.instant_eligible === true,
        raw: {
          items: [
            ...indexItems,
            ...instantItems.map((item) => (
              item && typeof item === 'object' && item.fromFallback === undefined
                ? { ...item, fromFallback: true }
                : item
            )),
          ],
          partial: indexResponse.is_partial === true,
          sweepInline: false,
          instant: indexResponse.instant_eligible === true,
          live: null,
        },
      },
    },
    'inputs/collect.json': [{
      key: {
        imdb: metaResponse.imdb_id,
        type: target.type,
        season,
        episode,
        scope: 'all',
        query: queries.query,
        pt_query: queries.ptQuery,
      },
      response: {
        items: stripTransportSecrets(collectItems),
        partial: collectResponse.partial === true,
        live: collectResponse.live ?? null,
      },
    }],
  };
  // O `_debugFind` do strip não existe: os objetos acima são JSON puro. O
  // mascaramento do que saiu do addon fecha a última porta (host/token).
  for (const key of Object.keys(files)) files[key] = maskValue(files[key], ctx);
  return { files, meta: metaResponse, collect: collectResponse, index: indexResponse };
}

// ── manifesto ──────────────────────────────────────────────────────────────

function loadExistingManifest(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.format !== FORMAT_MANIFEST || !Array.isArray(parsed.cases)) return null;
  return parsed;
}

/**
 * Manifesto do corpus. Com `--merge` (e um manifesto anterior válido), os casos
 * que NÃO foram recapturados são preservados e cada caso guarda a própria data
 * (`capturedAt`) — um recaptura parcial não pode reescrever a proveniência dos
 * outros nem apagar 50 casos.
 */
function buildManifest({ manifestPath, capturedCases, casesPath, ctx, startedAt, withInternal, merge }) {
  const previous = merge ? loadExistingManifest(manifestPath) : null;
  const byId = new Map();
  if (previous) {
    for (const item of previous.cases) {
      if (!item || typeof item.id !== 'string') continue;
      byId.set(item.id, { ...item, capturedAt: item.capturedAt || previous.capturedAt || null });
    }
  }
  for (const item of capturedCases) byId.set(item.id, item);
  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const notCaptured = [
    ...(withInternal ? [] : [GAP_META, GAP_COLLECT]),
    ...GAPS_BASE,
    ...(withInternal ? GAPS_INTERNAL : []),
  ];
  return {
    format: FORMAT_MANIFEST,
    // Data DESTA execução; a de cada caso está em `cases[].capturedAt`.
    capturedAt: startedAt,
    node: process.version,
    base: '{{base}}',
    user_config_sha256: ctx.userConfig ? sha256(ctx.userConfig) : (previous?.user_config_sha256 ?? null),
    // O arquivo de casos do corpus inteiro não pode virar o do recorte corrente.
    cases_file: previous?.cases_file || path.relative(REPO, casesPath).split(path.sep).join('/'),
    cases: merged,
    notCaptured,
  };
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
  const internalBaseRaw = args.internalBase || args.base;
  const internalBase = internalBaseRaw ? normalizeBase(internalBaseRaw) : null;
  if (internalBase) assertInternalLoopback(internalBase);
  const ctx = maskingContext({ base, token: args.token, userConfig: args.userConfig, internalBase });
  const planRows = plan(cases, ctx);
  const outDir = resolveCliPath(args.out, 'rust/golden/stream-e2e');
  const casesDir = path.join(outDir, 'cases');
  const manifestPath = path.join(outDir, 'manifest.json');

  if (args.withInternal && !args.dryRun) {
    if (!args.userConfig) fail('--with-internal exige --user-config (as rotas internas recebem o encoded no corpo)');
    if (!args.token) {
      fail('--with-internal exige token: passe --token ou exporte JACKETT_TEST_TOKEN (o valor nunca é impresso)');
    }
    if (!base) {
      fail('--with-internal exige --base apontando para o Node em loopback (ex.: http://127.0.0.1:7100)');
    }
  }

  if (args.dryRun) {
    // Modo seco: valida casos e imprime o plano, sem tocar a rede nem o disco.
    console.log(`[stream-e2e] dry-run — ${cases.length} caso(s) de ${path.relative(REPO, casesPath)}`);
    console.log(`[stream-e2e] saída: ${path.relative(REPO, outDir)}/`);
    if (args.withInternal) {
      console.log(`[stream-e2e] --with-internal: rotas ${Object.values(INTERNAL_PATHS).join(', ')}`
        + (internalBase ? ` em ${internalBase.origin}${internalBase.prefix}` : ' (sem --base no dry-run)'));
    }
    if (args.shadowDir) {
      console.log(`[stream-e2e] --shadow-dir: fixtures exatas de ${args.shadowDir}/<caso>/inputs`);
    }
    for (const row of planRows) {
      console.log(`  - ${row.id} (${row.type}) ${row.stream_id} → ${row.path}`);
    }
    console.log('[stream-e2e] NÃO capturado (ver README/manifesto):');
    for (const gap of (args.withInternal ? [...GAPS_BASE, ...GAPS_INTERNAL] : [GAP_META, GAP_COLLECT, ...GAPS_BASE])) {
      console.log(`  · ${gap}`);
    }
    return;
  }

  if (!base) fail('--base é obrigatório fora do --dry-run (ex.: http://127.0.0.1:7000)');
  if (!args.cases) fail('--cases é obrigatório (arquivo de casos validado antes de qualquer rede)');
  const startedAt = new Date().toISOString();
  const manifestCases = [];

  for (const target of cases) {
    // O `/stream` é o artefato principal: sai ANTES das rotas internas, que
    // leem o mesmo estado (cache raw/davail quente na sequência).
    const { request, response } = await captureCase({
      target, base, token: args.token, userAgent: args.userAgent, ctx,
      shadowId: args.shadowDir ? target.id : null,
    });
    const caseDir = path.join(casesDir, target.id);
    const files = {};
    files['request.json'] = writeJson(path.join(caseDir, 'request.json'), request);
    files['response.json'] = writeJson(path.join(caseDir, 'response.json'), response);
    let internal = null;
    if (args.withInternal) {
      const captured = await captureInternal({
        base: internalBase,
        token: args.token,
        encoded: args.userConfig,
        target,
        ctx,
        deadlineMs: args.internalDeadlineMs,
      });
      for (const [name, value] of Object.entries(captured.files)) {
        files[name] = writeJson(path.join(caseDir, name), value);
      }
      internal = Object.keys(captured.files);
    }
    // Fixtures que só o record do shadow tem (proven-quality, apply-debrid,
    // files, instant, fallback) e as versões EXATAS do índice/debrid do build.
    let shadowFiles = [];
    if (args.shadowDir) {
      const shadowInputs = path.join(args.shadowDir, target.id, 'inputs');
      if (!fs.existsSync(shadowInputs)) {
        fail(
          `shadow sem captura em ${shadowInputs}\n` +
          '  o addon precisa rodar uma imagem anterior ao F4.4 com o record do shadow ligado',
        );
      }
      for (const name of SHADOW_INPUTS) {
        const source = path.join(shadowInputs, name);
        if (!fs.existsSync(source)) continue;
        files[`inputs/${name}`] = copyShadowInput(path.join(caseDir, 'inputs', name), source);
        shadowFiles.push(`inputs/${name}`);
      }
      if (shadowFiles.length === 0) {
        fail(`shadow sem nenhum de ${SHADOW_INPUTS.join(', ')} em ${shadowInputs}`);
      }
    }
    manifestCases.push({
      id: target.id,
      label: target.label,
      type: target.type,
      stream_id: target.streamId,
      dir: `cases/${target.id}`,
      status: response.status,
      cacheMaxAge: response.cacheMaxAge,
      capturedAt: startedAt,
      files,
      ...(internal ? { internal } : {}),
      ...(shadowFiles.length > 0 ? { shadow: shadowFiles } : {}),
    });
    console.log(
      `[stream-e2e] ${target.id}: HTTP ${response.status} cacheMaxAge=${response.cacheMaxAge}`
      + (internal ? ` + ${internal.length} fixture(s) interna(s)` : ''),
    );
  }

  const manifest = buildManifest({
    manifestPath,
    capturedCases: manifestCases,
    casesPath,
    ctx,
    startedAt,
    withInternal: args.withInternal,
    merge: args.merge,
  });
  // O manifesto NÃO entra no próprio hash: ele é o índice dos arquivos.
  writeJson(manifestPath, manifest);
  console.log(
    `[stream-e2e] OK: ${manifestCases.length} caso(s) em ${path.relative(REPO, casesDir)}; `
    + `${manifest.cases.length} no manifesto ${path.relative(REPO, manifestPath)}`,
  );
}

main().catch((err) => {
  if (err instanceof CaptureError) {
    console.error(`[stream-e2e] erro: ${err.message}`);
    process.exit(1);
  }
  console.error('[stream-e2e] erro inesperado:', err);
  process.exit(2);
});
