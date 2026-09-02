import config from '../config.js';
import * as indexerStatus from './indexer-status.js';

// Circuit breaker: indexer offline em N amostras seguidas seguia recebendo o
// orçamento integral de busca (20s nos BR) para falhar de novo, a cada
// consulta. Com o circuito aberto — streak no limiar e última falha dentro do
// cooldown — a busca pula o indexer e devolve o prazo aos que entregam. O
// diagnóstico (test()) NÃO passa por aqui: é o caminho que conserta a fonte,
// e a meia-abertura pós-cooldown já deixa a busca reavaliar sozinha.
export function breakerTripped(indexer: string, now = Date.now()) {
  if (!config.jackett.breakerEnabled) return false;
  const status = indexerStatus.get(indexer, now);
  if (!status || (status.failStreak || 0) < config.jackett.breakerFailures) return false;
  const failedAt = Date.parse(status.checkedAt);
  return Number.isFinite(failedAt) && now - failedAt < config.jackett.breakerCooldown;
}

/** Estado serializável do breaker para o painel, sem disparar nova medição. */
export function breakerSnapshot(indexer: string, now = Date.now()) {
  const status = indexerStatus.get(indexer, now);
  const failedAt = Date.parse(String(status?.checkedAt || ''));
  const eligible = Boolean(
    config.jackett.breakerEnabled &&
      status &&
      (status.failStreak || 0) >= config.jackett.breakerFailures &&
      Number.isFinite(failedAt),
  );
  const cooldownRemainingMs = eligible
    ? Math.max(0, config.jackett.breakerCooldown - (now - failedAt))
    : 0;
  return {
    enabled: config.jackett.breakerEnabled,
    tripped: breakerTripped(indexer, now),
    failStreak: status?.failStreak || 0,
    failuresRequired: config.jackett.breakerFailures,
    cooldownMs: config.jackett.breakerCooldown,
    cooldownRemainingMs,
  };
}

// Quem já teve a abertura anunciada neste episódio — o aviso é UM por
// abertura, não por busca; sai do set quando o indexer volta a ser consultado.
export const breakerAnnounced = new Set();
