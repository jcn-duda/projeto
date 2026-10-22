/**
 * Métricas do gateway Rust para o painel (Fase 0.7 — "mais Rust, menos TS").
 *
 * Com o `/stream` respondendo no gateway, os contadores `search.*` do Node
 * congelam: ler deles é ler zero. As métricas reais estão em DUAS superfícies
 * (`src/config/native-metrics.ts`): a 7000 (`/metrics`, sem token — `account.*`,
 * `index.*`/`bank.*`, `debrid.al.*`) e a 8710 (API interna do debrid, token no
 * header — `rust.debrid.*` + limpeza da AllDebrid).
 *
 * Contrato de honestidade: contador AUSENTE não é zero. Uma fonte que não
 * respondeu simplesmente não contribui, e sem NENHUMA fonte o resultado é
 * `null` — quem consome (painel) omite `native` em vez de inventar números.
 * Fail-open: nada aqui lança, e o prazo é curto.
 */
import config from '../config.js';

export type NativeMetricsSource = 'gateway' | 'debrid';

export interface NativeMetrics {
  pulledAt: string;
  /** Quais superfícies responderam de fato neste ciclo. */
  sources: Record<NativeMetricsSource, boolean>;
  /** Contadores crus (`account.*`, `index.*`, `debrid.al.*`, `rust.debrid.*`). */
  counters: Record<string, number>;
}

export interface NativeMetricsOptions {
  fetchImpl?: typeof fetch;
  /** Sobrepõe o `GATEWAY_METRICS_TIMEOUT_MS` (teste). */
  timeoutMs?: number;
}

/** Campos de `releaseIndex` que o Rust já mede (`idx:v14` é dele desde a F3.1). */
export interface NativeReleaseIndexCounters {
  hits?: number;
  misses?: number;
  gaps?: number;
  servedReleases?: number;
  recordedReleases?: number;
}

const RELEASE_INDEX_FIELDS: ReadonlyArray<[keyof NativeReleaseIndexCounters, string]> = [
  ['hits', 'index.rust.hit'],
  ['misses', 'index.rust.miss'],
  ['gaps', 'index.rust.gap'],
  ['servedReleases', 'index.rust.served'],
  ['recordedReleases', 'index.rust.recorded'],
];

/**
 * Traduz os contadores nativos para os campos do bloco `releaseIndex`. Campo
 * sem chave correspondente fica AUSENTE (o Node decide) — nunca vira 0 por
 * omissão: zero do Rust é resposta, ausência é "não medido".
 */
export function nativeReleaseIndexCounters(
  counters: Record<string, number> | null | undefined,
): NativeReleaseIndexCounters {
  const out: NativeReleaseIndexCounters = {};
  if (!counters) return out;
  for (const [field, key] of RELEASE_INDEX_FIELDS) {
    const value = counters[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
  return out;
}

function base(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** Um GET curto; `null` = qualquer falha (rede, prazo, status, corpo estranho). */
async function readCounters(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Record<string, number> | null> {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Lê as duas superfícies em paralelo. `null` quando NENHUMA respondeu — é o
 * sinal para o painel omitir `metrics.native` (nada de zero inventado).
 * A 8710 só é tentada com token: sem ele a rota responde 503/401 e a leitura
 * seria só custo.
 */
export async function pullNativeMetrics(options: NativeMetricsOptions = {}): Promise<NativeMetrics | null> {
  const settings = config.nativeMetrics;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  // Mesma ordem do `adom-debrid`: token próprio e, sem ele, o do diagnóstico
  // (o sidecar aceita os dois).
  const token = settings.token || config.jackett.testToken || '';
  const gatewayUrl = base(settings.gatewayUrl);
  const debridUrl = base(settings.debridUrl);

  const [gateway, debrid] = await Promise.all([
    gatewayUrl
      ? readCounters(`${gatewayUrl}/metrics`, { accept: 'application/json' }, timeoutMs, fetchImpl)
      : Promise.resolve(null),
    token && debridUrl
      ? readCounters(
        `${debridUrl}/metrics`,
        { accept: 'application/json', 'X-Indexer-Test-Token': token },
        timeoutMs,
        fetchImpl,
      )
      : Promise.resolve(null),
  ]);

  if (!gateway && !debrid) return null;
  return {
    pulledAt: new Date().toISOString(),
    sources: { gateway: gateway != null, debrid: debrid != null },
    // A 8710 vence no desempate (namespace `rust.debrid.*` é dela); as chaves
    // das duas superfícies não se cruzam.
    counters: { ...(gateway || {}), ...(debrid || {}) },
  };
}
