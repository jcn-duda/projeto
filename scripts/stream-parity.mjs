#!/usr/bin/env node
/**
 * scripts/stream-parity.mjs
 *
 * Portão operacional de paridade Node × Rust para o /stream (critério formal em
 * docs/rust-stream-contract.md §9.4; este script NÃO substitui o corpus e2e
 * byte a byte nem os contadores de 72 h — é o gate rápido e honesto).
 *
 * O que mudou em relação à versão anterior (e por quê):
 *   - Gate EXATO: mesmo conjunto de hashes + mesmo conjunto de hashes com
 *     rótulo BR + mesma contagem/total de streams por caso. O threshold antigo
 *     (matchPct >= 80, |ΔBR| <= 1) e o "matchPct = 100 com os dois lados
 *     vazios" mascaravam divergência; agora ambos vazios = INCONCLUSIVO,
 *     erro/estouro de prazo = ERRO, qualquer diferença = DIVERGENCIA. Só 100%
 *     PARIDADE fecha o gate.
 *   - Prova de que o endpoint --rust é o corte NATIVO: canário no /stream +
 *     delta de `stream.shadow.compared` no GET /metrics do gateway. Sombra
 *     (ROUTES_RUST=stream-shadow) responde com o CORPO DO NODE — nunca é
 *     evidência de paridade; X-Powered-By: Express na resposta delata Node.
 *     O lado --node também passa por canário e PRECISA provar Express; sem
 *     isso a comparação seria nativo×nativo (Node×Node proibido). Endpoints
 *     iguais ou invertidos recusam antes de qualquer medição.
 *   - Casos verificados contra o corpus e2e existente (nenhum ID inventado
 *     aqui): caso fora do corpus, duplicado ou com tipo divergente recusa.
 *   - Latência p50/p95 por perfil de cliente (o prazo acompanha o UA, como em
 *     `reply_deadline_ms`): Stremio (10s) e Dart/ (15s do app), amostras
 *     configuráveis, frio (1ª batida) reportado SEPARADO do quente — o quente
 *     (SWR) NUNCA é apresentado como medida de frio.
 *   - Saída sanitizada: todo URL impresso mascara o segmento de config
 *     ({{config}}) e descarta a query (onde mora o sig). Nada de .env, token
 *     ou segredo passa por aqui.
 *
 * Superfície permitida (guarda explícita, default é recusar): GET /metrics e
 * GET /{config}/stream/{type}/{id}.json. NUNCA /resolve (debrid), /internal/*
 * ou painel. O script não escreve estado e não altera config.
 *
 * Uso:
 *   node scripts/stream-parity.mjs [--rust http://127.0.0.1:7000]
 *        [--node http://127.0.0.1:7100] [--encoded e30] [--samples 3]
 *        [--settle-ms 400] [--shadow-wait-ms 12000]
 *        [--deadline-stremio 10000] [--deadline-dart 15000]
 *        [--corpus scripts/golden/casos-stream-e2e.json] [--self-test]
 *   node scripts/stream-parity.mjs --help
 *
 * Códigos de saída: 0 = 100% paridade com endpoint nativo; 1 = divergência,
 * erro ou inconclusivo; 2 = uso inválido (inclui endpoints iguais/invertidos);
 * 3 = endpoint não é o corte nativo ou --node não é o Express; 4 = corpus
 * inválido; 5 = self-test falhou.
 *
 * Limitações honestas: a paridade roda no prazo do perfil Stremio (mesmo prazo
 * dos dois lados; o Dart só entra na latência). BR é contado pelo RÓTULO da
 * resposta (mesmo critério do script antigo) — o campo `_br` é interno e não
 * vaza ao cliente. "Frio" aqui é a 1ª batida desta execução: pode achar SWR de
 * execução anterior; frio de verdade exige cache zerado no servidor. Sem
 * /metrics, a prova nativa fica só no cabeçalho (marcado como evidência mais
 * fraca). O aceite formal do corte segue §9.4 (corpus recapturado, 500 buscas,
 * 72 h, revisor humano).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

// --- CLI -------------------------------------------------------------------

const HELP_TEXT = `Uso:
  node scripts/stream-parity.mjs [opções]

Compara GET /{config}/stream/... do Node (Express) contra o corte nativo Rust
e só fecha o gate com 100% de paridade EXATA por caso (mesmos hashes, mesmo
conjunto BR e mesmo total). Não toca /resolve, /internal/* nem painel.

Opções:
  --rust <url>              gateway do corte nativo (default http://127.0.0.1:7000)
  --node <url>              Express direto do Node (default http://127.0.0.1:7100)
  --encoded <base64url>     segmento de config; só o TAMANHO é impresso
  --samples <n>             amostras quentes por perfil (default 3; 0 desliga)
  --settle-ms <ms>          pausa antes da 2ª batida de paridade (default 400)
  --shadow-wait-ms <ms>     janela para detectar a sombra (default 12000)
  --deadline-stremio <ms>   prazo do perfil Stremio/1.6 (default 10000)
  --deadline-dart <ms>      prazo do perfil Dart/ (default 15000)
  --corpus <arquivo>        corpus e2e (default scripts/golden/casos-stream-e2e.json)
  --self-test               sobe stubs node:http em loopback e testa o gate
  --help, -h                mostra esta ajuda e sai (não toca a rede)

Códigos de saída: 0 paridade; 1 divergência/erro/inconclusivo; 2 uso inválido;
3 endpoint não nativo ou --node não comprovado Express; 4 corpus inválido;
5 self-test falhou.
`;

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

function getArg(flag, def) {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
}

function normalizeBase(base) {
  return String(base || '').replace(/\/+$/, '');
}

// Base impressa em log: origem + caminho, sem query, credenciais ou config.
function sanitizeEndpoint(base) {
  return sanitizeUrl(base).replace(/\/+$/, '');
}

function assertHttpBase(flag, base) {
  let parsed;
  try {
    parsed = new URL(String(base));
  } catch {
    throw new Error(`${flag} não é uma URL válida`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${flag} precisa ser http(s), recebido ${parsed.protocol}`);
  }
}

function assertEncoded(value) {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(String(value))) {
    throw new Error('--encoded precisa ser um segmento base64url (A-Z a-z 0-9 _ -)');
  }
}

// Node×Node nunca é paridade: além de recusar a sombra no --rust, os dois
// lados precisam ser endpoints distintos. Comparar um servidor consigo mesmo
// (ou com o espelho do Node) produziria 100% falso.
function assertDistinctEndpoints(rustBase, nodeBase) {
  let rust;
  let node;
  try {
    rust = new URL(String(rustBase));
    node = new URL(String(nodeBase));
  } catch {
    return;
  }
  const key = (u) => `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  if (key(rust) === key(node)) {
    throw new Error('--rust e --node apontam para o mesmo endpoint; Node×Node não prova paridade');
  }
}

function numArg(flag, def, min) {
  const raw = getArg(flag, String(def));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    console.error(`[uso] ${flag} deve ser um número >= ${min} (recebido: ${JSON.stringify(raw)})`);
    process.exit(2);
  }
  return value;
}

function intArg(flag, def, min) {
  const value = numArg(flag, def, min);
  if (!Number.isInteger(value)) {
    console.error(`[uso] ${flag} deve ser inteiro (recebido: ${JSON.stringify(value)})`);
    process.exit(2);
  }
  return value;
}

const OPTS = {
  rust: normalizeBase(getArg('--rust', 'http://127.0.0.1:7000')),
  node: normalizeBase(getArg('--node', 'http://127.0.0.1:7100')),
  encoded: getArg('--encoded', 'e30'),
  corpus: getArg('--corpus', path.join(REPO, 'scripts', 'golden', 'casos-stream-e2e.json')),
  samples: intArg('--samples', 3, 0),
  settleMs: numArg('--settle-ms', 400, 0),
  shadowWaitMs: numArg('--shadow-wait-ms', 12000, 0),
  deadlineStremio: numArg('--deadline-stremio', 10000, 1000),
  deadlineDart: numArg('--deadline-dart', 15000, 1000),
};

// Perfis de cliente: o prazo acompanha o UA (adom-search::reply_deadline_ms —
// prefixo ASCII `Dart/` sem caixa recebe o prazo do app; todo o resto, o do
// Stremio). Prazos configuráveis porque o operador pode sobrescrevê-los.
const PROFILES = [
  { key: 'stremio', label: 'Stremio', ua: 'Stremio/1.6', deadlineMs: OPTS.deadlineStremio },
  { key: 'dart', label: 'Dart (app)', ua: 'Dart/3.4 (dart:io)', deadlineMs: OPTS.deadlineDart },
];

// Casos representativos — IDs VERIFICADOS contra o corpus e2e na inicialização
// (verifyCorpus). Não invente ID aqui: caso novo entra PRIMEIRO no corpus
// (scripts/golden/casos-stream-e2e.json + recaptura), depois neste seletor.
const TEST_CASES = [
  { id: 'cidade-de-deus', type: 'movie', streamId: 'tt0317248', label: 'Cidade de Deus (BR Nacional)' },
  { id: 'tropa-de-elite', type: 'movie', streamId: 'tt0861739', label: 'Tropa de Elite (BR Nacional)' },
  { id: 'central-do-brasil', type: 'movie', streamId: 'tt0140888', label: 'Central do Brasil (BR Nacional)' },
  { id: 'auto-compadecida', type: 'movie', streamId: 'tt0271383', label: 'O Auto da Compadecida (BR Nacional)' },
  { id: 'carandiru', type: 'movie', streamId: 'tt0293007', label: 'Carandiru (BR Nacional)' },
  { id: 'bacurau', type: 'movie', streamId: 'tt2762506', label: 'Bacurau (BR Nacional)' },
  { id: 'inception', type: 'movie', streamId: 'tt1375666', label: 'Inception (Dublado Global)' },
  { id: 'matrix', type: 'movie', streamId: 'tt0133093', label: 'Matrix (Global EN)' },
  { id: 'interstellar', type: 'movie', streamId: 'tt0816692', label: 'Interstellar (Global)' },
  { id: 'parasita', type: 'movie', streamId: 'tt6751668', label: 'Parasita (Dublado BR)' },
  { id: 'harry-potter-1', type: 'movie', streamId: 'tt0241527', label: 'Harry Potter 1 (Multiobra/Pack)' },
  { id: 'kung-fu-panda-4', type: 'movie', streamId: 'tt21692408', label: 'Kung Fu Panda 4 (Animação/Pack)' },
  { id: 'breaking-bad-s01e01', type: 'series', streamId: 'tt0903747:1:1', label: 'Breaking Bad S01E01 (Série)' },
  { id: 'got-s08e03', type: 'series', streamId: 'tt0944947:8:3', label: 'Game of Thrones S08E03 (Série)' },
  { id: '3-percent-s01e01', type: 'series', streamId: 'tt4922804:1:1', label: '3% S01E01 (Série BR Nacional)' },
  { id: 'naruto-s01e01', type: 'series', streamId: 'tt0409591:1:1', label: 'Naruto S01E01 (Anime Dublado)' },
];

// --- Sanitização de saída ----------------------------------------------------
// Nenhuma URL impressa carrega config, query ou sig: é a mesma máscara de
// identidade do §9.3 ({{config}}), aplicada como higiene de log.

const CONFIG_SEGMENT = /^\/([A-Za-z0-9_-]{1,8192})\/stream(?=\/|$)/;

function sanitizeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return '(url inválida)';
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
  const masked = pathname
    .replace(CONFIG_SEGMENT, '/{{config}}/stream')
    // Idempotência: uma segunda passada recebe o token já mascarado e o URL
    // percent-encoda as chaves; desfaz para o log não virar %7B%7Bconfig%7D%7D.
    .replace(/%7B%7Bconfig%7D%7D/gi, '{{config}}');
  return `${parsed.origin}${masked}`;
}

function sanitizeText(text) {
  return String(text ?? '')
    // Pontuação final (ex.: parêntese de "(http://…)") não é parte da URL.
    .replace(/https?:\/\/[^\s"'<>\\]+/g, (match) => {
      const url = match.replace(/[)\]}>,.;:!?'"]+$/, '');
      return sanitizeUrl(url) + match.slice(url.length);
    })
    // Caracteres de controle não são imprimíveis e só atrapalham o relatório.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// --- Guarda de superfície ----------------------------------------------------
// Este script só tem negócio em /metrics e no /stream. A expressão é estreita
// de propósito: rota nova precisa ser AUTORIZADA aqui — o default é recusar.
// /resolve toca debrid; /internal/* é superfície interna; painel é destrutivo.

const STREAM_PATH = /^\/(?:[A-Za-z0-9_-]{1,8192}\/)?stream\/(movie|series)\/(tt[0-9A-Za-z:_-]+)\.json$/;

function assertAllowedGet(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`url malformada recusada: ${sanitizeText(urlStr)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`protocolo não permitido: ${sanitizeUrl(urlStr)}`);
  }
  if (parsed.pathname === '/metrics') return;
  if (STREAM_PATH.test(parsed.pathname)) return;
  throw new Error(`rota fora da superfície do script: ${sanitizeUrl(urlStr)}`);
}

// --- HTTP --------------------------------------------------------------------

// GET do /stream com prazo do cliente (AbortController): o que o cliente real
// espera é o que medimos — resposta depois do prazo é ESTOURO, não amostra.
// `poweredBy` registra X-Powered-By: é a evidência de "quem montou o corpo"
// usada pelo classificador de endpoint.
async function getStreamTimed(base, type, streamId, { encoded, deadlineMs, ua }) {
  const url = `${base}/${encoded}/stream/${type}/${streamId}.json`;
  assertAllowedGet(url);
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': ua },
      signal: ac.signal,
      // Redirect manual: um 3xx vira falha visível em vez de seguir para
      // outro host sem passar pela guarda de superfície.
      redirect: 'manual',
    });
    const ms = Date.now() - started;
    const poweredBy = res.headers.get('x-powered-by');
    if (!res.ok) {
      return { ok: false, status: res.status, ms, streams: [], poweredBy, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return {
      ok: true,
      status: res.status,
      ms,
      streams: Array.isArray(data.streams) ? data.streams : [],
      poweredBy,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      streams: [],
      poweredBy: null,
      timedOut: ac.signal.aborted,
      error: sanitizeText(err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Snapshot dos contadores §9.2 do gateway (rota pública, sem token).
async function getMetrics(base) {
  const url = `${base}/metrics`;
  assertAllowedGet(url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, status: res.status, counters: null };
    const body = await res.json();
    const counters = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    return { ok: counters !== null, status: res.status, counters };
  } catch (err) {
    return { ok: false, status: 0, counters: null, error: sanitizeText(err?.message || String(err)) };
  }
}

// --- Gate de paridade (puro) ---------------------------------------------------

function extractHash(stream) {
  if (stream?.infoHash) return String(stream.infoHash).toLowerCase();
  const url = String(stream?.url || '');
  const match = /\/resolve\/([0-9a-fA-F]{40})/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

// O rótulo BR é o da RESPOSTA (mesmo critério do script antigo). O campo `_br`
// é interno e não vaza ao cliente; aqui só existe o que o cliente vê.
function isBrStream(stream) {
  const full = `${stream?.name || ''} ${stream?.title || ''}`;
  return full.includes('🇧🇷') ||
    full.includes('DUB BR') ||
    full.includes('NAC BR') ||
    /\b(bludv|mico|comando|nerd|tdf|vaca|redetorrent)\b/i.test(full);
}

function hashSetOf(streams) {
  return [...new Set(streams.map(extractHash).filter(Boolean))].sort();
}

// Gate EXATO por caso. Conjunto de hashes idêntico + BR igual + total igual.
// Ambos vazios (ou só aviso, cf. §0.5) não provam paridade: INCONCLUSIVO.
// Erro de rede/HTTP/prazo: ERRO. Qualquer diferença: DIVERGENCIA.
function parityVerdict(nodeRes, rustRes) {
  if (!nodeRes.ok || !rustRes.ok) {
    return {
      status: 'ERRO',
      node: { ok: nodeRes.ok, status: nodeRes.status, timedOut: Boolean(nodeRes.timedOut), error: nodeRes.error },
      rust: { ok: rustRes.ok, status: rustRes.status, timedOut: Boolean(rustRes.timedOut), error: rustRes.error },
    };
  }
  const nodeSet = hashSetOf(nodeRes.streams);
  const rustSet = hashSetOf(rustRes.streams);
  const nodeBrSet = hashSetOf(nodeRes.streams.filter(isBrStream));
  const rustBrSet = hashSetOf(rustRes.streams.filter(isBrStream));
  const nodeBr = nodeRes.streams.filter(isBrStream).length;
  const rustBr = rustRes.streams.filter(isBrStream).length;
  // Contagem igual não basta: o MESMO hash precisa carregar o rótulo BR nos
  // dois lados. Conjuntos de hashes BR diferentes = divergência.
  const brSetsDiffer = nodeBrSet.length !== rustBrSet.length
    || nodeBrSet.some((hash, i) => hash !== rustBrSet[i]);
  const base = { nodeSet, rustSet, nodeBrSet, rustBrSet, nodeBr, rustBr, nodeTotal: nodeRes.streams.length, rustTotal: rustRes.streams.length };
  if (nodeSet.length === 0 && rustSet.length === 0) {
    return { ...base, status: 'INCONCLUSIVO', reason: 'ambos sem stream com hash (vazio ou só aviso — cf. §0.5)' };
  }
  const missingInRust = nodeSet.filter((h) => !rustSet.includes(h));
  const missingInNode = rustSet.filter((h) => !nodeSet.includes(h));
  if (missingInRust.length || missingInNode.length || brSetsDiffer || nodeBr !== rustBr || nodeRes.streams.length !== rustRes.streams.length) {
    return {
      ...base,
      status: 'DIVERGENCIA',
      missingInRust,
      missingInNode,
      brSetsDiffer,
      totalDiff: nodeRes.streams.length - rustRes.streams.length,
    };
  }
  // Ordem é informativa, não gate: o Node não promete ordem estável (§2.4).
  const nodeSeq = nodeRes.streams.map(extractHash).filter(Boolean);
  const rustSeq = rustRes.streams.map(extractHash).filter(Boolean);
  const top3Same = [0, 1, 2].every((i) => (nodeSeq[i] ?? null) === (rustSeq[i] ?? null));
  return { ...base, status: 'PARIDADE', top3Same };
}

// nearest-rank: o ceil(p/100 × n)-ésimo da lista ordenada (nunca interpola).
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1;
  return sorted[idx];
}

// --- Corpus --------------------------------------------------------------------

// O corpus canônico dos casos é `scripts/golden/casos-stream-e2e.json` (o
// manifest de captura aponta para ele em `cases_file`). A verificação é por
// (type, stream_id) — o id curto do script é só rótulo local.
function loadCorpusIndex(casesFile) {
  const parsed = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  const cases = Array.isArray(parsed?.cases) ? parsed.cases : null;
  if (!cases) throw new Error(`corpus sem "cases": ${casesFile}`);
  const index = new Map();
  for (const entry of cases) {
    if (!entry || typeof entry.type !== 'string' || typeof entry.stream_id !== 'string') continue;
    index.set(`${entry.type}:${entry.stream_id}`, entry);
  }
  return index;
}

function verifyCorpus(cases, corpusIndex, casesFile) {
  const problemas = [];
  const seen = new Set();
  for (const c of cases) {
    const key = `${c.type}:${c.streamId}`;
    if (seen.has(key)) problemas.push(`caso duplicado no script: ${c.id} (${key})`);
    seen.add(key);
    const inCorpus = corpusIndex.get(key);
    if (!inCorpus) {
      problemas.push(`${c.id}: ${key} NÃO está no corpus (${path.basename(String(casesFile))}) — capture no corpus antes de medir`);
      continue;
    }
    c.corpusId = inCorpus.id;
  }
  if (problemas.length) {
    throw new Error(`lista de casos inválida contra o corpus:\n  - ${problemas.join('\n  - ')}`);
  }
}

// --- Classificação do endpoint ---------------------------------------------------

const SHADOW_COMPARED = 'stream.shadow.compared';
const CANARY_ID = 'tt0133093';
const CANARY_DEADLINE_MS = 20000;

function isExpressHeader(value) {
  return /express/i.test(String(value ?? ''));
}

// Prova de modo com DUAS evidências independentes:
//   a) GET /metrics do gateway: delta de stream.shadow.compared > 0 em torno do
//      canário ⇒ a rota passou pela SOMBRA (o Node respondeu; o Rust só
//      observa, fire-and-forget — a remontagem da busca acontece ANTES de
//      contar, então a janela de espera precisa caber uma busca inteira).
//      Sombra nunca é evidência do corte nativo.
//   b) Cabeçalho da resposta: X-Powered-By: Express ⇒ quem montou o corpo foi
//      o Node (proxy direto ou sombra sem remontagem — `compared` não conta
//      sem token). O handler nativo é axum e não produz esse cabeçalho; o
//      proxy repassa os headers não hop-by-hop do Node.
// Só (não-powered) + (métrica parada na janela inteira) é "nativo"; sem
// /metrics, a evidência fica só no cabeçalho e o modo é marcado como mais
// fraco. Métrica que some no meio da janela = INCONCLUSIVO, nunca "nativo".
async function classifyEndpoint(base, { encoded, shadowWaitMs }) {
  const before = await getMetrics(base);
  const canary = await getStreamTimed(base, 'movie', CANARY_ID, {
    encoded,
    deadlineMs: CANARY_DEADLINE_MS,
    ua: 'Stremio/1.6',
  });
  const powered = isExpressHeader(canary.poweredBy);

  let after = before;
  let samplingFailed = false;
  if (before.ok && shadowWaitMs > 0) {
    const start = Number(before.counters?.[SHADOW_COMPARED] ?? 0);
    const deadline = Date.now() + shadowWaitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, shadowWaitMs)));
      const sample = await getMetrics(base);
      if (!sample.ok) {
        samplingFailed = true;
        break;
      }
      after = sample;
      if (Number(after.counters?.[SHADOW_COMPARED] ?? 0) > start) break;
    }
  }
  const metricsOk = before.ok && after.ok && !samplingFailed;
  const comparedDelta = metricsOk
    ? Number(after.counters?.[SHADOW_COMPARED] ?? 0) - Number(before.counters?.[SHADOW_COMPARED] ?? 0)
    : null;

  if (comparedDelta !== null && comparedDelta > 0) {
    return {
      mode: 'sombra', powered, comparedDelta, metricsOk, canary,
      reason: 'stream.shadow.compared subiu em torno do canário: a rota passou pela sombra — quem respondeu foi o Node',
    };
  }
  if (powered) {
    return {
      mode: 'node', powered, comparedDelta, metricsOk, canary,
      reason: 'resposta com X-Powered-By: Express — corpo montado pelo Node (proxy direto ou sombra sem remontagem)',
    };
  }
  if (!canary.ok) {
    return {
      mode: 'inconclusivo', powered, comparedDelta, metricsOk, canary,
      reason: `canário falhou no endpoint: ${canary.error || `HTTP ${canary.status}`}`,
    };
  }
  if (!metricsOk && before.ok && shadowWaitMs > 0) {
    return {
      mode: 'inconclusivo', powered, comparedDelta, metricsOk, canary,
      reason: '/metrics deixou de responder durante a janela: não há como provar que a sombra ficou parada',
    };
  }
  return {
    mode: before.ok ? 'nativo' : 'nativo-sem-metrics',
    powered, comparedDelta, metricsOk, canary,
    reason: before.ok
      ? 'sem X-Powered-By e stream.shadow.compared parado na janela: o corte nativo respondeu'
      : 'sem X-Powered-By no canário, mas /metrics inacessível — evidência só do cabeçalho (mais fraca)',
  };
}

// O lado Node também é provado. Sem X-Powered-By: Express no canário, o
// --node pode ser o próprio gateway nativo e a comparação viraria
// nativo×nativo — recusa antes de medir qualquer caso.
async function classifyNodeEndpoint(base, { encoded }) {
  const canary = await getStreamTimed(base, 'movie', CANARY_ID, {
    encoded,
    deadlineMs: CANARY_DEADLINE_MS,
    ua: 'Stremio/1.6',
  });
  if (!canary.ok) {
    return {
      mode: 'inconclusivo', canary,
      reason: `canário falhou no --node: ${canary.error || `HTTP ${canary.status}`}`,
    };
  }
  if (!isExpressHeader(canary.poweredBy)) {
    return {
      mode: 'nao-node', canary,
      reason: canary.poweredBy
        ? `X-Powered-By inesperado no --node (${sanitizeText(canary.poweredBy)})`
        : 'sem X-Powered-By no --node: não há prova de que este lado é o Express',
    };
  }
  return { mode: 'node', canary, reason: 'X-Powered-By: Express no canário do --node' };
}

// --- Formatação ------------------------------------------------------------------

function formatCaseLine(verdict, nodeRes, rustRes) {
  if (verdict.status === 'ERRO') {
    const side = (label, r) => !r.ok
      ? `${label}: ${r.timedOut ? 'estouro de prazo' : r.error || `HTTP ${r.status}`}`
      : `${label}: ok`;
    return `[ERRO] ${side('Node', nodeRes)} | ${side('Rust', rustRes)}`;
  }
  const stats = (r) => `${r.ms}ms`;
  const head = `[${verdict.status}] Node: ${verdict.nodeSet.length} hashes (${verdict.nodeBr} BR) ${stats(nodeRes)} | Rust: ${verdict.rustSet.length} hashes (${verdict.rustBr} BR) ${stats(rustRes)}`;
  if (verdict.status === 'INCONCLUSIVO') return `${head} | ${verdict.reason}`;
  if (verdict.status === 'DIVERGENCIA') {
    const parts = [];
    if (verdict.missingInRust.length) parts.push(`faltam no Rust: ${verdict.missingInRust.slice(0, 3).join(',')}${verdict.missingInRust.length > 3 ? ',…' : ''}`);
    if (verdict.missingInNode.length) parts.push(`faltam no Node: ${verdict.missingInNode.slice(0, 3).join(',')}${verdict.missingInNode.length > 3 ? ',…' : ''}`);
    if (verdict.nodeBr !== verdict.rustBr) parts.push(`BR ${verdict.nodeBr}≠${verdict.rustBr}`);
    else if (verdict.brSetsDiffer) parts.push('BR: hashes diferentes');
    if (verdict.totalDiff !== 0) parts.push(`total ${verdict.nodeTotal}≠${verdict.rustTotal}`);
    return `${head} | ${parts.join(' | ')}`;
  }
  return `${head} | top3 ${verdict.top3Same ? 'igual' : 'diferente (informativo)'}`;
}

// --- Fases ---------------------------------------------------------------------

// 1ª batida = candidata a frio (cada servidor tem SWR próprio; ambas rodam em
// paralelo). 2ª batida = medida do gate, com SWR assentado (mesmo prazo dos
// dois lados: perfil Stremio). A 1ª batida NUNCA é somada às amostras quentes.
async function phaseParity(log, opts) {
  const profile = PROFILES[0];
  const results = [];
  for (const c of TEST_CASES) {
    log(`Avaliando: ${c.label.padEnd(44)} [corpus: ${c.corpusId}]`);
    const request = (base) => getStreamTimed(base, c.type, c.streamId, {
      encoded: opts.encoded, deadlineMs: profile.deadlineMs, ua: profile.ua,
    });
    const [nodeCold, rustCold] = await Promise.all([request(opts.node), request(opts.rust)]);
    if (opts.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
    const [nodeRes, rustRes] = await Promise.all([request(opts.node), request(opts.rust)]);
    const verdict = parityVerdict(nodeRes, rustRes);
    results.push({
      case: c,
      verdict,
      node: nodeRes,
      rust: rustRes,
      cold: {
        node: nodeCold.ok ? nodeCold.ms : null,
        rust: rustCold.ok ? rustCold.ms : null,
      },
    });
    log(`  ${formatCaseLine(verdict, nodeRes, rustRes)} | frio N/R: ${nodeCold.ok ? nodeCold.ms : 'erro'}/${rustCold.ok ? rustCold.ms : 'erro'}ms`);
  }
  return results;
}

// Amostras QUENTES (SWR já assentado pela fase de paridade). Estouro de prazo
// é contado à parte — não é amostra de latência. Quente NÃO mede busca a frio:
// o que esconde o custo aqui é o cache do servidor, não o cliente.
async function phaseLatency(log, opts) {
  const slots = new Map();
  const slotFor = (serverKey, profileKey) => {
    const key = `${serverKey}:${profileKey}`;
    if (!slots.has(key)) slots.set(key, { serverKey, profileKey, samples: [], estouros: 0, erros: 0 });
    return slots.get(key);
  };
  for (const c of TEST_CASES) {
    for (const server of [{ key: 'node', base: opts.node }, { key: 'rust', base: opts.rust }]) {
      for (const profile of PROFILES) {
        const slot = slotFor(server.key, profile.key);
        for (let i = 0; i < opts.samples; i += 1) {
          const r = await getStreamTimed(server.base, c.type, c.streamId, {
            encoded: opts.encoded, deadlineMs: profile.deadlineMs, ua: profile.ua,
          });
          if (r.ok) slot.samples.push(r.ms);
          else if (r.timedOut) slot.estouros += 1;
          else slot.erros += 1;
        }
      }
    }
  }
  const rows = [...slots.values()].map((slot) => ({
    ...slot,
    n: slot.samples.length,
    p50: percentile(slot.samples, 50),
    p95: percentile(slot.samples, 95),
  }));
  log('');
  log('Latência por perfil — amostras QUENTES (SWR); quente NÃO mede frio:');
  log('  servidor  perfil      n    p50    p95   estouros  erros');
  for (const row of rows.sort((a, b) => a.serverKey.localeCompare(b.serverKey) || a.profileKey.localeCompare(b.profileKey))) {
    const fmt = (v) => (v === null ? '-' : String(v));
    log(`  ${row.serverKey.padEnd(9)} ${row.profileKey.padEnd(11)} ${String(row.n).padStart(3)} ${fmt(row.p50).padStart(6)} ${fmt(row.p95).padStart(6)} ${String(row.estouros).padStart(9)} ${String(row.erros).padStart(7)}`);
  }
  return rows;
}

function printColdReport(log, parityResults) {
  log('');
  log('Frio — 1ª batida da fase de paridade, por servidor (pode achar SWR de execução');
  log('anterior; frio REAL exige cache zerado no servidor — não afirmado aqui):');
  for (const serverKey of ['node', 'rust']) {
    const values = parityResults.map((r) => r.cold[serverKey]).filter((v) => v !== null);
    const falhas = parityResults.length - values.length;
    const p50 = percentile(values, 50);
    const p95 = percentile(values, 95);
    const fmt = (v) => (v === null ? '-' : String(v));
    log(`  ${serverKey.padEnd(9)} n=${String(values.length).padStart(2)} p50=${fmt(p50).padStart(6)}ms p95=${fmt(p95).padStart(6)}ms${falhas ? ` (1ª batida falhou em ${falhas} caso(s) — frio ausente, não é amostra)` : ''}`);
  }
}

// --- Main ---------------------------------------------------------------------

async function main() {
  const log = (line) => console.log(sanitizeText(line));

  // 0. Bases válidas e distintas: Node×Node (ou o mesmo gateway duas vezes)
  // nunca vira prova de paridade.
  try {
    assertHttpBase('--rust', OPTS.rust);
    assertHttpBase('--node', OPTS.node);
    assertEncoded(OPTS.encoded);
    assertDistinctEndpoints(OPTS.rust, OPTS.node);
  } catch (err) {
    console.error(`[uso] ${sanitizeText(err.message)}`);
    process.exitCode = 2;
    return;
  }

  log('='.repeat(95));
  log(`Comparativo de Paridade: Node (${sanitizeEndpoint(OPTS.node)}) vs Rust (${sanitizeEndpoint(OPTS.rust)})`);
  log(`Configuração: {{config}} (${OPTS.encoded.length} caracteres) | Casos: ${TEST_CASES.length} | Amostras quentes/perfil: ${OPTS.samples}`);
  log('='.repeat(95));

  // 1. Corpus: nenhum ID fora do corpus, nenhum duplicado.
  let corpusIndex;
  try {
    corpusIndex = loadCorpusIndex(OPTS.corpus);
    verifyCorpus(TEST_CASES, corpusIndex, OPTS.corpus);
  } catch (err) {
    console.error(`[corpus] RECUSADO: ${sanitizeText(err.message)}`);
    process.exitCode = 4;
    return;
  }
  log(`[corpus] ${TEST_CASES.length} casos verificados contra ${path.basename(OPTS.corpus)} (${corpusIndex.size} casos no corpus).`);

  // 2. Endpoint: sombra/Node não é evidência — recusa antes de comparar.
  log(`[endpoint] classificando --rust ${sanitizeEndpoint(OPTS.rust)} (canário + /metrics, janela ${OPTS.shadowWaitMs}ms)...`);
  const endpoint = await classifyEndpoint(OPTS.rust, OPTS);
  log(`[endpoint] modo: ${endpoint.mode} — ${endpoint.reason}`);
  if (endpoint.mode !== 'nativo' && endpoint.mode !== 'nativo-sem-metrics') {
    console.error('[endpoint] RECUSADO: o endpoint --rust não é o corte nativo. Resposta de sombra/Node não é evidência de paridade.');
    console.error('[endpoint] Corrija com ROUTES_RUST=stream no override do gateway e --rust apontando para a porta do gateway.');
    process.exitCode = 3;
    return;
  }
  if (endpoint.mode === 'nativo-sem-metrics') {
    log('[endpoint] AVISO: /metrics inacessível — a prova nativa ficou só no cabeçalho da resposta.');
  }

  // 2b. O outro lado precisa provar Express: sem X-Powered-By, o --node pode
  // ser o próprio gateway nativo (nativo×nativo passaria como 100% falso).
  log(`[endpoint] classificando --node ${sanitizeEndpoint(OPTS.node)}...`);
  const nodeEndpoint = await classifyNodeEndpoint(OPTS.node, OPTS);
  log(`[endpoint] lado Node: ${nodeEndpoint.mode} — ${nodeEndpoint.reason}`);
  if (nodeEndpoint.mode !== 'node') {
    console.error('[endpoint] RECUSADO: --node não provou ser o Express. Use o Node direto (porta 7100), não o gateway nativo.');
    process.exitCode = 3;
    return;
  }

  // 3. Paridade (gate exato, prazo do perfil Stremio nos dois lados).
  const parity = await phaseParity(log, OPTS);

  // 4. Latência por perfil (opt-out com --samples 0).
  if (OPTS.samples > 0) {
    await phaseLatency(log, OPTS);
  }
  printColdReport(log, parity);

  // 5. Resumo + exit.
  log('');
  log('='.repeat(95));
  log('RESUMO:');
  const counts = { PARIDADE: 0, DIVERGENCIA: 0, INCONCLUSIVO: 0, ERRO: 0 };
  for (const r of parity) counts[r.verdict.status] += 1;
  log(`Paridade EXATA (mesmos hashes + BR + total): ${counts.PARIDADE}/${parity.length}.`);
  log(`  DIVERGENCIA=${counts.DIVERGENCIA} INCONCLUSIVO=${counts.INCONCLUSIVO} ERRO=${counts.ERRO}`);
  log(`Endpoint Rust: ${endpoint.mode} (delta sombra: ${endpoint.comparedDelta === null ? 'n/d' : endpoint.comparedDelta}) | lado Node: ${nodeEndpoint.mode}.`);
  log('Inconclusivo e erro TAMBÉM bloqueiam o gate: só 100% paridade fecha.');
  log('Limitações: paridade no prazo do perfil Stremio; BR contado pelo rótulo da resposta;');
  log('quente (SWR) não mede frio; o aceite formal do corte é o §9.4 (corpus e2e + 500 buscas/72h).');
  log('='.repeat(95));
  if (counts.PARIDADE < parity.length) {
    process.exitCode = 1;
  }
}

// --- Self-test (servidor stub local, zero dependências) -------------------------
// `node scripts/stream-parity.mjs --self-test` sobe stubs node:http nos modos
// que o classificador precisa distinguir e testa o gate puro, a sanitização, o
// corpus do repo e os prazos — sem tocar em servidor real.

function streamsForStub(id) {
  if (id.startsWith('tt9999')) return []; // ambos vazios
  if (id.startsWith('tt7777')) return [{ name: 'Aviso: procurando fontes' }]; // só aviso, sem hash
  return [
    { name: '🇧🇷 DUB BR BLUDV 1080p', infoHash: 'a'.repeat(40) },
    { name: 'EN torrent', infoHash: 'b'.repeat(40) },
  ];
}

function startStubServer(mode) {
  const counters = {
    [SHADOW_COMPARED]: 0,
    'stream.shadow.divergence': 0,
    'stream.shadow.error': 0,
  };
  const server = http.createServer((req, res) => {
    const pathOnly = (req.url || '').split('?')[0];
    if (pathOnly === '/metrics') {
      if (mode === 'node') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(counters));
      return;
    }
    // Só o modo NATIVO (axum) não produz X-Powered-By.
    if (mode !== 'native') res.setHeader('x-powered-by', 'Express');
    const match = STREAM_PATH.exec(pathOnly);
    if (!match) { res.writeHead(404); res.end(); return; }
    const id = match[2];
    if (id.startsWith('tt0000000')) { res.writeHead(500); res.end('boom'); return; }
    const body = JSON.stringify({ streams: streamsForStub(id) });
    if (mode === 'shadow') {
      // Como o observe fire-and-forget do gateway: responde PRIMEIRO,
      // incrementa o contador DEPOIS.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      setImmediate(() => { counters[SHADOW_COMPARED] += 1; });
      return;
    }
    if (id === 'tt0500500') {
      // Lento a propósito: exercita o estouro de prazo do cliente.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      }, 400);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        counters,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function runSelfTest() {
  const assert = (await import('node:assert/strict')).default;
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);
  const FAKE_ENCODED = 'QmFzZTY0X2NvbmZpZ19kZV90ZXN0ZV9sb25nX3NlZ3VlbnRl'; // nunca é um config real

  test('percentil nearest-rank', () => {
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile([10, 20, 30, 40], 95), 40);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
    assert.equal(percentile([], 50), null);
  });

  test('sanitização: config mascarada, query/sig descartada', () => {
    assert.equal(
      sanitizeUrl(`http://127.0.0.1:7000/${FAKE_ENCODED}/stream/movie/tt1.json?sig=segredo`),
      'http://127.0.0.1:7000/{{config}}/stream/movie/tt1.json',
    );
    assert.equal(sanitizeUrl('http://127.0.0.1:7100/stream/movie/tt1.json'), 'http://127.0.0.1:7100/stream/movie/tt1.json');
    assert.equal(sanitizeUrl('http://127.0.0.1:7100'), 'http://127.0.0.1:7100');
    const text = sanitizeText(`falha em http://host/${FAKE_ENCODED}/stream/series/tt2:1:1.json?token=x fim`);
    assert.ok(!text.includes(FAKE_ENCODED) && !text.includes('token=x'), `vazou: ${text}`);
    assert.ok(text.includes('{{config}}/stream/series/tt2:1:1.json'));
    // Pontuação em volta da URL (ex.: parêntese) permanece fora da máscara.
    const paren = sanitizeText(`erro em (http://host/${FAKE_ENCODED}/stream/movie/tt1.json) fim`);
    assert.equal(paren, 'erro em (http://host/{{config}}/stream/movie/tt1.json) fim');
    // Sanitizar de novo não percent-encoda o token já mascarado.
    assert.equal(sanitizeText(paren), paren);
    assert.ok(!sanitizeText(paren).includes('%7B%7B'));
  });

  test('help lista as flags e não exige rede', () => {
    for (const flag of [
      '--rust', '--node', '--encoded', '--samples', '--settle-ms',
      '--shadow-wait-ms', '--deadline-stremio', '--deadline-dart',
      '--corpus', '--self-test', '--help',
    ]) {
      assert.ok(HELP_TEXT.includes(flag), `help sem ${flag}`);
    }
    assert.ok(!HELP_TEXT.includes('process.env'), 'help não deve sugerir leitura de ambiente');
  });

  test('endpoints: URL inválida, protocolo errado e lados iguais recusam', () => {
    assert.doesNotThrow(() => assertHttpBase('--rust', 'http://127.0.0.1:7000'));
    assert.throws(() => assertHttpBase('--rust', 'nao-e-url'), /não é uma URL válida/);
    assert.throws(() => assertHttpBase('--rust', 'ftp://127.0.0.1:7000'), /http\(s\)/);
    assert.doesNotThrow(() => assertEncoded('e30'));
    assert.throws(() => assertEncoded('e30/../../etc'), /base64url/);
    assert.throws(() => assertEncoded(''), /base64url/);
    assert.throws(
      () => assertDistinctEndpoints('http://127.0.0.1:7000/', 'http://127.0.0.1:7000'),
      /mesmo endpoint/,
    );
    assert.doesNotThrow(() => assertDistinctEndpoints('http://127.0.0.1:7000', 'http://127.0.0.1:7100'));
  });

  test('guarda de superfície: só /metrics e /stream; resolve/internal/dashboard recusados', () => {
    assertAllowedGet('http://h/metrics');
    assertAllowedGet(`http://h/${FAKE_ENCODED}/stream/series/tt0903747:1:1.json`);
    assertAllowedGet('http://h/stream/movie/tt1.json');
    for (const bad of [
      'http://h/resolve/abc',
      `http://h/${FAKE_ENCODED}/resolve/abc`,
      'http://h/internal/search/meta',
      'http://h/dashboard-action.json',
      'ftp://h/stream/movie/tt1.json',
    ]) {
      assert.throws(() => assertAllowedGet(bad), undefined, `deveria recusar ${bad}`);
    }
  });

  test('gate exato: threshold 80% e delta-1 NÃO passam mais', () => {
    const mk = (streams) => ({ ok: true, status: 200, streams });
    const h = (c) => ({ infoHash: c.repeat(40) });
    const node = mk([h('1'), h('2'), h('3'), h('4'), h('5')]);
    // 4 de 5 = 80%: o gate antigo dava PARIDADE; o exato recusa.
    assert.equal(parityVerdict(node, mk([h('1'), h('2'), h('3'), h('4')])).status, 'DIVERGENCIA');
    // Mesmos hashes, BR com delta 1: o gate antigo aceitava; o exato recusa.
    const br = (name, c) => ({ name, infoHash: c.repeat(40) });
    assert.equal(
      parityVerdict(
        mk([br('🇧🇷 BR', '1'), h('2'), h('3')]),
        mk([br('EN', '1'), h('2'), h('3')]),
      ).status,
      'DIVERGENCIA',
    );
    // Mesmos hashes/contagens, mas o hash BR trocado entre os lados: recusa.
    assert.equal(
      parityVerdict(
        mk([br('🇧🇷 BR', '1'), br('EN', '2')]),
        mk([br('EN', '1'), br('🇧🇷 BR', '2')]),
      ).status,
      'DIVERGENCIA',
    );
    // Total diferente com mesmos hashes (aviso a mais de um lado): recusa.
    assert.equal(
      parityVerdict(mk([h('1'), h('2'), { name: 'Aviso' }]), mk([h('1'), h('2')])).status,
      'DIVERGENCIA',
    );
    // Igualdade exata fecha.
    const a = mk([br('🇧🇷 BR', '1'), h('2')]);
    assert.equal(parityVerdict(a, mk([br('🇧🇷 BR', '1'), h('2')])).status, 'PARIDADE');
  });

  test('gate: ambos vazios = INCONCLUSIVO; erros = ERRO', () => {
    const mk = (streams) => ({ ok: true, status: 200, streams });
    const err = (extra) => ({ ok: false, status: 0, streams: [], error: 'boom', ...extra });
    assert.equal(parityVerdict(mk([]), mk([])).status, 'INCONCLUSIVO');
    assert.equal(parityVerdict(mk([{ name: 'Aviso' }]), mk([{ name: 'Aviso' }])).status, 'INCONCLUSIVO');
    assert.equal(parityVerdict(mk([]), mk([{ infoHash: 'a'.repeat(40) }])).status, 'DIVERGENCIA');
    assert.equal(parityVerdict(err(), mk([])).status, 'ERRO');
    assert.equal(parityVerdict(err(), err({ timedOut: true })).status, 'ERRO');
  });

  test('corpus: os 16 casos do script batem no corpus do repo; fora/duplicado recusa', () => {
    const corpusPath = path.join(REPO, 'scripts', 'golden', 'casos-stream-e2e.json');
    const index = loadCorpusIndex(corpusPath);
    verifyCorpus(TEST_CASES, index, corpusPath);
    for (const c of TEST_CASES) assert.ok(c.corpusId, `${c.id} sem corpusId`);
    assert.throws(() => verifyCorpus(
      [...TEST_CASES, { id: 'x', type: 'movie', streamId: 'tt0000009', label: 'fora do corpus' }],
      index, corpusPath,
    ), /NÃO está no corpus/);
    assert.throws(() => verifyCorpus(
      [...TEST_CASES, { ...TEST_CASES[0] }],
      index, corpusPath,
    ), /duplicado/);
  });

  test('classificação de endpoint: nativo, sombra e node são distinguidos', async () => {
    const native = await startStubServer('native');
    try {
      const verdictNative = await classifyEndpoint(native.base, { encoded: 'e30', shadowWaitMs: 1200 });
      assert.equal(verdictNative.mode, 'nativo');
      assert.equal(verdictNative.powered, false);
    } finally { await native.close(); }

    const shadow = await startStubServer('shadow');
    try {
      const verdictShadow = await classifyEndpoint(shadow.base, { encoded: 'e30', shadowWaitMs: 3000 });
      assert.equal(verdictShadow.mode, 'sombra');
      assert.ok((verdictShadow.comparedDelta ?? 0) > 0, 'delta de compared deveria subir');
    } finally { await shadow.close(); }

    const node = await startStubServer('node');
    try {
      const verdictNode = await classifyEndpoint(node.base, { encoded: 'e30', shadowWaitMs: 300 });
      assert.equal(verdictNode.mode, 'node');
      assert.equal(verdictNode.powered, true);
    } finally { await node.close(); }
  });

  test('lado Node: exige X-Powered-By; nativo como --node recusa', async () => {
    const native = await startStubServer('native');
    try {
      const verdict = await classifyNodeEndpoint(native.base, { encoded: 'e30' });
      assert.equal(verdict.mode, 'nao-node');
    } finally { await native.close(); }

    const node = await startStubServer('node');
    try {
      const verdict = await classifyNodeEndpoint(node.base, { encoded: 'e30' });
      assert.equal(verdict.mode, 'node');
    } finally { await node.close(); }
  });

  test('endpoint impresso não carrega credenciais nem query', () => {
    assert.equal(
      sanitizeEndpoint('http://usuario:segredo@127.0.0.1:7100/base?token=segredo'),
      'http://127.0.0.1:7100/base',
    );
    assert.equal(sanitizeEndpoint('http://127.0.0.1:7000/'), 'http://127.0.0.1:7000');
  });

  test('prazo do cliente: resposta tardia é estouro, não amostra', async () => {
    const stub = await startStubServer('native');
    try {
      const slow = await getStreamTimed(stub.base, 'movie', 'tt0500500', { encoded: 'e30', deadlineMs: 100, ua: 'Stremio/1.6' });
      assert.equal(slow.ok, false);
      assert.equal(slow.timedOut, true);
      const fast = await getStreamTimed(stub.base, 'movie', 'tt0133093', { encoded: 'e30', deadlineMs: 5000, ua: 'Stremio/1.6' });
      assert.equal(fast.ok, true);
      assert.equal(fast.streams.length, 2);
    } finally { await stub.close(); }
  });

  test('saída da paridade não vaza o segmento de config', async () => {
    const stub = await startStubServer('native');
    const captured = [];
    const collect = (line) => captured.push(String(line));
    try {
      const request = (base) => getStreamTimed(base, 'movie', 'tt0133093', { encoded: FAKE_ENCODED, deadlineMs: 5000, ua: 'Stremio/1.6' });
      const [n, r] = await Promise.all([request(stub.base), request(stub.base)]);
      const verdict = parityVerdict(n, r);
      collect(formatCaseLine(verdict, n, r));
      const divergente = parityVerdict(n, { ...r, streams: [] });
      collect(formatCaseLine(divergente, n, { ...r, streams: [] }));
    } finally { await stub.close(); }
    for (const line of captured) assert.ok(!line.includes(FAKE_ENCODED), `vazou config: ${line}`);
  });

  test('temp dir do corpus inválido não é deixado para trás', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-corpus-'));
    try {
      const bad = path.join(dir, 'corpus.json');
      fs.writeFileSync(bad, JSON.stringify({ format: 'adom-stream-e2e-cases/1', cases: [] }));
      const index = loadCorpusIndex(bad);
      assert.throws(() => verifyCorpus(TEST_CASES, index, bad), /NÃO está no corpus/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  let failed = 0;
  console.log(`Self-test do stream-parity (${tests.length} testes, stub node:http local):`);
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok      ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FALHA   ${name}: ${sanitizeText(err?.message || String(err))}`);
    }
  }
  console.log(failed ? `Self-test: ${failed} falha(s).` : 'Self-test: tudo verde.');
  process.exitCode = failed ? 5 : 0;
}

if (args.includes('--self-test')) {
  runSelfTest().catch((err) => {
    console.error('Falha no self-test:', sanitizeText(err?.stack || err));
    process.exit(5);
  });
} else {
  main().catch((err) => {
    console.error('Falha na execução:', sanitizeText(err?.stack || err));
    process.exit(1);
  });
}
