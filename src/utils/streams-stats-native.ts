// Estatísticas do store NATIVO de `streams:v21` (`GET /streams/stats`) — a
// ponte de LEITURA do painel (C4).
//
// A admin do gateway (`127.0.0.1:8711`, `adom-server::store_admin`) publica
// `{ok, entries, quota, hit, staleServed, miss, writes, hitRate, degraded,
// staleGraceSeconds}` da ocupação e da eficiência do `data/streams.db`. Este
// módulo SÓ lê: quem escreve/invalida é o `streams-store-native.ts`.
//
// Fail-open, mesma régua de `catalog-native.ts`: falha de rede, HTTP não-2xx,
// corpo estranho ou timeout devolve `null` sem lançar — o painel segue com o
// L1 local e o campo `native` é OMITIDO (ausente ≠ zero). Um 404 de stats num
// gateway velho NÃO alimenta backoff nenhum: esta leitura é stateless e não
// pode congelar a invalidação por obra, cujo backoff mora no módulo de
// escrita (propósito: este arquivo não o importa).
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';

/** Shape da rota `GET /streams/stats`. TODOS os campos são opcionais: campo
 * ausente no gateway fica ausente aqui — o consumidor mostra '—', nunca 0. */
export interface NativeStreamsStats {
  entries?: number;
  quota?: number;
  hit?: number;
  /** Resposta do gateway: `null` = sem consulta no período (não é ausência). */
  hitRate?: number | null;
  staleServed?: number;
  miss?: number;
  writes?: number;
  degraded?: boolean;
  staleGraceSeconds?: number;
}

export interface StreamsStatsOptions {
  fetchImpl?: typeof fetch;
  /** Sobrepõe o `STREAM_STORE_ADMIN_TIMEOUT_MS` (teste). */
  timeoutMs?: number;
}

function baseUrl(): string {
  return String(config.streamStore.url || '').trim().replace(/\/+$/, '');
}

// Mesma precedência da superfície de leitura (doc de `migracao-stream-rust.md`):
// token próprio → token de diagnóstico.
function token(): string {
  return config.streamStore.token || config.jackett.testToken || '';
}

/** Número finito ou nada: `NaN`/string/ausente não vira 0 (honestidade). */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Corpo da rota validado campo a campo; corpo sem o contrato lança (quem
 * chama converte em `null` e conta o erro da ponte). */
function parseStats(body: unknown): NativeStreamsStats {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('corpo sem o contrato de stats');
  }
  const raw = body as Record<string, unknown>;
  if (raw.ok !== true) throw new Error('gateway respondeu ok:false');
  const out: NativeStreamsStats = {};
  for (const field of ['entries', 'quota', 'hit', 'staleServed', 'miss', 'writes', 'staleGraceSeconds'] as const) {
    const value = finite(raw[field]);
    if (value !== undefined) out[field] = value;
  }
  // `hitRate: null` do gateway é RESPOSTA (sem consulta no período) e viaja
  // como null; valor não-numérico vale como campo ausente.
  if (raw.hitRate === null) out.hitRate = null;
  else {
    const rate = finite(raw.hitRate);
    if (rate !== undefined) out.hitRate = rate;
  }
  if (typeof raw.degraded === 'boolean') out.degraded = raw.degraded;
  return out;
}

/** Stats do `streams.db` nativo; `null` = ponte fora (o painel omite `native`). */
export async function fetchNativeStreamsStats(options: StreamsStatsOptions = {}): Promise<NativeStreamsStats | null> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? (Number(config.streamStore.timeoutMs) || 2000);
  try {
    const res = await fetchImpl(`${baseUrl()}/streams/stats`, {
      headers: { 'x-indexer-test-token': token(), accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseStats(await res.json());
  } catch (err) {
    metrics.count('stream.stats.bridge_errors');
    log.debug(`[stream-store] stats do streams.db indisponíveis: ${log.errorMessage(err)}`);
    return null;
  }
}
