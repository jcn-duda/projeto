import type { DebridAdapter } from '../../types/domain.js';
import { isAuthError, isQuotaError, isRateLimitError } from './common.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { notify } from '../utils/notify.js';
import { cacheVerdict } from '../utils/rust-debrid-cache.js';

// O `checkCached` orquestrado (davail + coalescência não abortável + alive)
// saiu para o oráculo de teste (`test/helpers/pipeline-oracle/debrid-check.ts`):
// a checagem viva é a do gateway. Aqui fica o vocabulário que a produção usa —
// o veredito de conta inutilizável (painel/diagnóstico). O davail do play
// (`noteAvailable`/`peekDavail`/`noteUnavailable`) foi para o oráculo
// (`test/helpers/pipeline-oracle/play/davail.ts`).

type CacheCheckResult = {
  cached: Set<string>;
  known: boolean;
  unusable?: { reason: string; message: string };
};
type AdapterCacheResponse = Set<string> | {
  cached: Set<string>;
  complete?: boolean;
  /** 200 da checagem nativa: conta recusada/no teto — veredito, não exceção. */
  unusable?: { reason?: string; message?: string } | null;
};

/**
 * Serviço inutilizável AGORA, por um motivo que só o usuário conserta —
 * estado próprio, não "não sei".
 *
 * `known:false` sozinho manda a lista inteira pelo debrid, o que faz sentido
 * quando o serviço só não respondeu a tempo. Nestes dois casos não: a checagem
 * é um upload, e o play também é — se o upload é recusado, nenhum link vai
 * resolver e a lista precisa voltar como P2P. Os dois chegam à tela do mesmo
 * jeito (o ⚡ some de todos os streams) e só o log distingue a causa, então
 * cada motivo carrega o próprio conserto.
 */
const UNUSABLE = {
  auth: {
    metric: 'debrid.auth.invalid',
    label: 'credencial recusada',
    fix: (adapter: DebridAdapter) =>
      `gere uma chave nova em ${adapter.keyUrl || 'sua conta'} e atualize DEBRID_API_KEY` +
      ' ou refaça a URL de instalação em /configure',
  },
  quota: {
    metric: 'debrid.quota.exceeded',
    label: 'conta no limite de magnets',
    fix: () =>
      'apague magnets antigos no painel do serviço; a checagem de cache é um upload' +
      ' e não cabe mais nenhum enquanto a conta estiver cheia',
  },
};

/** Efeitos da conta inutilizável (métrica, log, aviso); o veredito vem do Rust. */
function unusable(adapter: DebridAdapter, reason: keyof typeof UNUSABLE, err: unknown): CacheCheckResult {
  const kind = UNUSABLE[reason];
  const message = log.errorMessage(err);
  metrics.count(kind.metric);
  log.warn(`[${adapter.id}] ${kind.label} (${message}); a lista volta como P2P — ${kind.fix(adapter)}`);
  notify(`debrid_${reason}`, 'error', `${kind.label} (${message})`, {
    adapter: adapter.id,
    fix: kind.fix(adapter),
  }).catch(() => {});
  return cacheVerdict({ form: 'object', cached: [], complete: null, failure: reason, message });
}

/** Classifica o que impede o serviço de funcionar, ou null se for transitório. */
function unusableReason(err: unknown): keyof typeof UNUSABLE | null {
  if (isAuthError(err)) return 'auth';
  if (isQuotaError(err)) return 'quota';
  return null;
}

/** Rate limit é transitório: não entra em unusable. Só classifica o diagnóstico. */
function failureReason(err: unknown) {
  return unusableReason(err) || (isRateLimitError(err) ? 'rate' : 'falha');
}

function normalizeCacheResult(adapter: DebridAdapter, result: AdapterCacheResponse): CacheCheckResult {
  // 200 nativo com `unusable` (auth/quota) é conta recusada, não "não sei" mudo.
  const refused = result instanceof Set ? undefined : result?.unusable;
  if (refused) {
    const reason = refused.reason === 'quota' ? 'quota' : 'auth';
    return unusable(adapter, reason, new Error(refused.message || refused.reason));
  }
  const cached = new Set<string>(result instanceof Set ? result : result.cached);
  const complete = result instanceof Set ? true : result?.complete !== false;
  if (!complete) {
    log.warn(
      `[${adapter.id}] checagem de cache incompleta; tratando como "não sei" em vez de "não tem"`,
    );
  }
  return cacheVerdict({
    form: result instanceof Set ? 'set' : 'object',
    cached: [...cached],
    complete: result instanceof Set ? null : (result?.complete ?? null),
    failure: null,
    message: '',
  });
}

export { UNUSABLE, unusable, failureReason, normalizeCacheResult, unusableReason };
export type { CacheCheckResult };
