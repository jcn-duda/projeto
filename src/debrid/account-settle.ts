import type { DebridAdapter } from '../../types/domain.js';
import config from '../config.js';
import * as log from '../utils/logger.js';

/**
 * Teto duro da consulta EM VOO. O `AbortSignal.timeout` do fetch não basta:
 * medido em produção (2026-10-07), uma consulta à AllDebrid ficou pendente
 * horas sem socket aberto, e como todo poll do painel se pendura na mesma
 * promessa do `inFlight`, a conta do operador virou "timeout" permanente até
 * reiniciar o processo — com a API respondendo em 0,3s. Estourado o teto, a
 * falha entra no memo (vale o TTL) e o slot é liberado.
 */
export function settleWithin(task: Promise<any>, adapter: DebridAdapter, fix: string) {
  const ceilingMs = 2 * Math.max(config.debrid.timeout, config.debrid.dashboardAccountTimeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise((resolve) => {
    timer = setTimeout(() => {
      log.warn(`[${adapter.id}] consulta de conta sem resposta em ${ceilingMs}ms; liberando a fila em voo`);
      resolve({
        ok: false,
        service: adapter.id,
        label: adapter.label,
        reason: 'timeout',
        error: `sem resposta em ${ceilingMs}ms`,
        fix,
      });
    }, ceilingMs);
    timer.unref?.();
  });
  return Promise.race([task, ceiling]).finally(() => clearTimeout(timer));
}
