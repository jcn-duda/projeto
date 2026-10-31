// Ponte de LEITURA do painel com o inventário NATIVO da conta AllDebrid
// (`GET /debrid/inventory` na admin 8711) — a foto do `knownBefore` que o
// gateway Rust guarda em memória (`adom_debrid::cleanup_inventory`), com o TTL
// (`ALLDEBRID_PREEXISTING_TTL_MS`) e o refresh em fundo DELE. O Node não volta
// a medir inventário: só espelha a CONTAGEM para o cartão da aba Limpeza.
//
// Hash nenhum atravessa a ponte: a rota responde só `enabled`/`reason`/`count`
// (a MESMA régua do `GET /sweeps` — escopo de conta e hash ficam no gateway).
//
// Fail-open, mesma régua de `streams-stats-native.ts`/`indexer-status-native.ts`:
// sem token, sem gateway, HTTP não-2xx, corpo estranho ou timeout devolve `null`
// sem lançar — o painel mostra "desconhecido" e mantém o comportamento atual.
// `count: null` é "não medido" (snapshot frio/vencido), NUNCA "conta vazia".
//
// TTL curto com dedupe in-flight: o /dashboard-status.json é lido a cada poucos
// segundos pelo painel e a rota é barata, mas não há razão para martelá-la a
// cada render — 30 s é o ritmo das outras pontes.
import config from '../config.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';

/** Shape da rota `GET /debrid/inventory` validado campo a campo. */
export interface NativeDebridInventory {
  ok: true;
  /** `false` = o gateway não tem conta do operador (`reason` explica). */
  enabled: boolean;
  /** Motivo cru do desligamento (`no_operator_account`); `null` quando ligada. */
  reason: string | null;
  /** Tamanho do acervo protegido; `null` = snapshot frio/vencido ("não sei"). */
  count: number | null;
  /** Relógio do gateway na hora da foto (ms). */
  at: number | null;
  /** Quando ESTA ponte tirou a foto (ISO). */
  pulledAt: string;
}

export interface DebridInventoryOptions {
  fetchImpl?: typeof fetch;
  /** Sobrepõe o prazo do fetch (teste). */
  timeoutMs?: number;
  /** Sobrepõe o TTL do cache local (teste; `0` força refetch). */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

let cache: NativeDebridInventory | null = null;
let cachedAt = 0;
let inFlight: Promise<NativeDebridInventory | null> | null = null;

function baseUrl(): string {
  return String(config.streamStore.url || '').trim().replace(/\/+$/, '');
}

// Mesma precedência das outras leituras da admin (`sweeps-native.ts`): token
// próprio → token de diagnóstico (`JACKETT_TEST_TOKEN`).
function token(): string {
  return config.streamStore.token || config.jackett.testToken || '';
}

/** Contagem finita ou nada: `NaN`/string/ausente não vira número (honestidade). */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Corpo da rota validado campo a campo; corpo sem o contrato lança (quem
 * chama converte em `null` e conta o erro da ponte). */
function parseInventory(body: unknown, pulledAt: string): NativeDebridInventory {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('corpo sem o contrato de inventário');
  }
  const raw = body as Record<string, unknown>;
  if (raw.ok !== true) throw new Error('gateway respondeu ok:false');
  return {
    ok: true,
    enabled: raw.enabled === true,
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason.slice(0, 60) : null,
    count: finiteOrNull(raw.count),
    at: finiteOrNull(raw.at),
    pulledAt,
  };
}

/**
 * Foto do inventário nativo; `null` = ponte fora (o painel mostra
 * "desconhecido"). Sem token nem vai à rede — não é falha, é configuração.
 */
export async function fetchNativeDebridInventory(options: DebridInventoryOptions = {}): Promise<NativeDebridInventory | null> {
  if (!token()) {
    metrics.count('debrid.inventory.bridge_no_token');
    return null;
  }
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (cache && Date.now() - cachedAt < ttlMs) return cache;
  if (inFlight) return inFlight;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? (Number(config.streamStore.timeoutMs) || 2000);
  inFlight = (async () => {
    try {
      const res = await fetchImpl(`${baseUrl()}/debrid/inventory`, {
        headers: { 'x-indexer-test-token': token(), accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const photo = parseInventory(await res.json(), new Date().toISOString());
      cache = photo;
      cachedAt = Date.now();
      return photo;
    } catch (err) {
      metrics.count('debrid.inventory.bridge_errors');
      log.debug(`[debrid] inventário nativo da conta indisponível: ${log.errorMessage(err)}`);
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Só testes: esquece cache e pedido em voo. */
export function resetDebridInventoryBridgeForTests(): void {
  cache = null;
  cachedAt = 0;
  inFlight = null;
}
