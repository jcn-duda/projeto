import { opts } from '../runtime.js';
import type { DebridAdapter } from '../../types/domain.js';
import config from '../config.js';
import { isAuthError, isQuotaError, isRateLimitError } from './common.js';
import { davailState } from '../utils/debrid-state-native.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import * as magnetdb from '../utils/magnetdb.js';
import { notify } from '../utils/notify.js';
import { cacheVerdict } from '../utils/rust-debrid-cache.js';
import { current } from './registry.js';

// O `checkCached` orquestrado (davail + coalescência não abortável + alive)
// saiu para o oráculo de teste (`test/helpers/pipeline-oracle/debrid-check.ts`):
// a checagem viva é a do gateway. Aqui fica o vocabulário que a produção usa —
// o veredito de conta inutilizável (painel/diagnóstico) e o davail do play.

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

/**
 * O recheck acabou de confirmar que o hash ficou pronto. Semeia o positivo para
 * a próxima lista marcar ⚡ sem repetir a consulta ao debrid.
 */
function noteAvailable(infoHash: string) {
  const adapter = current();
  const apiKey = opts().debridApiKey;
  if (!adapter || !apiKey || !infoHash) return;
  if (config.debrid.availPosTtl > 0) davailState().put(adapter.id, apiKey, infoHash, true, config.debrid.availPosTtl, Date.now());
  // Pronto de verdade é evidência durável: entra no banco de magnets além do
  // davail de TTL curto.
  magnetdb.markAlive(adapter.id, apiKey, [infoHash]);
}

/**
 * Leitura de SONDAGEM do davail, sem efeito algum: a ponte lê o store do núcleo
 * direto — não promove LRU, não conta cache.hit e não acorda o L2. Negativo
 * "fresco" aqui foi escrito NESTA instância, que é exatamente o que o consumidor
 * (DEBRID_ALIVE_AS_CACHE) quer para vetar o atalho do histórico; positivo
 * sozinho não pinta ⚡, só o negativo contradiz.
 *
 * @returns {0|1|null} veredito vivo do store, ou null (ausente/expirado).
 */
function peekDavail(adapterId: string, apiKey: string, hash: string): 0 | 1 | null {
  const value = davailState().get(adapterId, apiKey, hash, Date.now());
  if (value === null) return null;
  return value ? 1 : 0;
}

/**
 * Negativo MEDIDO pelo play: o /resolve acabou de constatar que o hash não
 * estava pronto no serviço. Grava davail=0 pela janela curta do availNegTtl
 * (a mesma do caminho da checagem) para o atalho do histórico não pintar ⚡
 * no que o play acabou de provar frio — o erro do atalho custa uma janela,
 * não os 7 dias do alive. Não toca no magnetdb: o alive de plays antigos
 * continua de pé, e um play futuro bem-sucedido o renova.
 */
function noteUnavailable(adapterId: string, apiKey: string, infoHash: string) {
  if (!adapterId || !apiKey || !infoHash) return;
  if (config.debrid.availNegTtl > 0) davailState().put(adapterId, apiKey, infoHash, false, config.debrid.availNegTtl, Date.now());
}

export { noteAvailable, peekDavail, noteUnavailable, UNUSABLE, unusable, failureReason, normalizeCacheResult, unusableReason };
export type { CacheCheckResult };
