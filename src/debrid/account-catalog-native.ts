// Ponte do Node com o CATÁLOGO DURÁVEL da conta do operador (AllDebrid), que
// saiu do TS: o gateway (`adom-server`, API administrativa em loopback, 8711)
// guarda o `catalog.db`, varre a conta, deduplica, audita e limpa. Ao Node sobra
// falar com as rotas `/account-catalog/*` e devolver o objeto que elas mandam —
// o MESMO formato que `catalog-env.ts` devolvia (o painel não mudou).
//
// Credenciais, como as varreduras nativas (`sweeps-native.ts`): as rotas que
// APAGAM magnet (`dedup-apply`, `manual-delete`, `cleanup-apply`) usam SÓ o token
// destrutivo (`STREAM_STORE_ADMIN_TOKEN`); as de leitura e a varredura aceitam o
// de diagnóstico (`JACKETT_TEST_TOKEN`). Sem o destrutivo a ponte nem vai à rede:
// token de diagnóstico não apaga magnet da conta.
//
// Contrato: NUNCA lança. Rede, timeout, 404 (gateway sem a rota) e 5xx viram
// `{ ok:false, reason:'native-unavailable' }`; 4xx com `error`/`reason` no corpo
// devolve esse motivo (ex.: `catalog_requires_admin_token`). Sem backoff: a
// indisponibilidade é de uma ação, e o painel já faz o próprio poll.
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';

/** Resposta do catálogo: o objeto que a rota devolve, ou um `{ ok:false, reason }`. */
export type AccountCatalogResult = { ok: boolean; reason?: string; [key: string]: any };

const UNAVAILABLE: AccountCatalogResult = { ok: false, reason: 'native-unavailable' };

type CallOptions = {
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
  query?: Record<string, string | number | undefined>;
  timeoutMs: number;
  /** Só as ações que apagam magnet: exige o token destrutivo. */
  destructive?: boolean;
};

function baseUrl(): string { return String(config.streamStore.url || '').replace(/\/+$/, ''); }

/** Token de diagnóstico ou o próprio — o mesmo fallback do `statusToken` das varreduras. */
function readToken(): string { return config.streamStore.token || config.jackett.testToken || ''; }

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 4xx da rota: o motivo que o gateway deu (`error` antes de `reason`), sem inventar nada. */
function guardOf(body: unknown, status: number): AccountCatalogResult {
  const e = isObject(body) ? body : {};
  const reason = String(e.error || e.reason || `http-${status}`);
  return { ok: false, reason };
}

async function call(path: string, opts: CallOptions): Promise<AccountCatalogResult> {
  const token = opts.destructive ? (config.streamStore.token || '') : readToken();
  if (opts.destructive && !token) {
    // Mesmo código que o gateway devolveria sem o token certo: nada de rede.
    metrics.count('account-catalog.bridge.no_admin_token');
    return { ok: false, reason: 'catalog_requires_admin_token' };
  }
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const url = `${baseUrl()}${path}${qs.size > 0 ? `?${qs.toString()}` : ''}`;
  try {
    const res = await fetch(url, {
      method: opts.method,
      headers: {
        'x-indexer-test-token': token,
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(Math.max(1, opts.timeoutMs)),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status >= 200 && res.status < 300) {
      if (isObject(body)) return body as AccountCatalogResult;
      metrics.count('account-catalog.bridge.unavailable');
      return UNAVAILABLE;
    }
    // 404 é gateway sem a rota (ainda não atualizado): indisponível, não recusa.
    if (res.status >= 400 && res.status < 500 && res.status !== 404) return guardOf(body, res.status);
    metrics.count('account-catalog.bridge.unavailable');
    log.warn(`[account-catalog] ${path} respondeu HTTP ${res.status}`);
    return UNAVAILABLE;
  } catch (err: unknown) {
    metrics.count('account-catalog.bridge.unavailable');
    log.warn(`[account-catalog] ${path} falhou: ${log.errorMessage(err)}`);
    return UNAVAILABLE;
  }
}

const READ = (): number => config.streamStore.catalogReadTimeoutMs;
const STATUS = (): number => config.streamStore.catalogStatusTimeoutMs;
const RUN = (): number => config.streamStore.catalogRunTimeoutMs;

/** Varre a conta do operador no gateway (longa: lista e classifica a conta inteira). */
export function catalogScanEnv(): Promise<AccountCatalogResult> {
  return call('/account-catalog/scan', { method: 'POST', body: {}, timeoutMs: RUN() });
}

/** Relatório do catálogo (leitura do banco do gateway). Polled pelo painel: prazo de status. */
export function catalogStatusEnv(): Promise<AccountCatalogResult> {
  return call('/account-catalog/status', { method: 'GET', timeoutMs: STATUS() });
}

/** Plano de deduplicação (leitura pura; nenhuma deleção). */
export function dedupPreviewEnv(): Promise<AccountCatalogResult> {
  return call('/account-catalog/dedup-preview', { method: 'GET', timeoutMs: READ() });
}

/** Aplica os kills do plano de dedup no gateway (teto `max` opcional). */
export function dedupApplyEnv(max?: number): Promise<AccountCatalogResult> {
  return call('/account-catalog/dedup-apply', {
    method: 'POST', body: { max, confirm: true }, timeoutMs: RUN(), destructive: true,
  });
}

/** Auditoria em fundo no gateway: prova os arquivos das linhas sem evidência. */
export function auditBackfillEnv(
  { max, concurrency }: { max?: number; concurrency?: number } = {},
): Promise<AccountCatalogResult> {
  return call('/account-catalog/audit', { method: 'POST', body: { max, concurrency }, timeoutMs: RUN() });
}

/** Linhas para o operador escolher na mão (leitura pura, maiores primeiro). */
export function catalogListEnv(
  { bucket, limit }: { bucket?: string; limit?: number } = {},
): Promise<AccountCatalogResult> {
  return call('/account-catalog/list', { method: 'GET', query: { bucket, limit }, timeoutMs: READ() });
}

/** Deleção MANUAL dos ids marcados. A rota exige `confirm`; a ponte sempre manda `true`. */
export function manualDeleteEnv(
  { serviceIds }: { serviceIds?: Array<string | number> } = {},
): Promise<AccountCatalogResult> {
  return call('/account-catalog/manual-delete', {
    method: 'POST', body: { serviceIds, confirm: true }, timeoutMs: RUN(), destructive: true,
  });
}

/** Devolve à fila as linhas com evidência expirada (sem rede no gateway: só limpa o carimbo). */
export function auditRequeueEnv({ max }: { max?: number } = {}): Promise<AccountCatalogResult> {
  return call('/account-catalog/audit-requeue', { method: 'POST', body: { max }, timeoutMs: READ() });
}

/** Plano da limpeza de estrangeiro provado (leitura pura). */
export function cleanupPreviewEnv(
  { includeKnown }: { includeKnown?: boolean } = {},
): Promise<AccountCatalogResult> {
  return call('/account-catalog/cleanup-preview', { method: 'POST', body: { includeKnown }, timeoutMs: RUN() });
}

/** Aplica a limpeza de estrangeiro provado no gateway (teto `max` opcional). */
export function cleanupApplyEnv(
  max?: number,
  { includeKnown }: { includeKnown?: boolean } = {},
): Promise<AccountCatalogResult> {
  return call('/account-catalog/cleanup-apply', {
    method: 'POST', body: { max, includeKnown, confirm: true }, timeoutMs: RUN(), destructive: true,
  });
}

/** Plano de versões da mesma obra (leitura pura; nenhuma deleção). */
export function catalogVersionsEnv(): Promise<AccountCatalogResult> {
  return call('/account-catalog/versions', { method: 'GET', timeoutMs: READ() });
}
