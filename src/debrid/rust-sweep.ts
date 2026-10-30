/**
 * Ponte da varredura de transferências mortas/paradas do Premiumize (e dos
 * demais serviços sem varredura AllDebrid) para o `adom-debrid` (8710).
 *
 * O corpo TS (`sweepDead` do Premiumize) saiu de `src/`; a régua vive no
 * Rust (`POST /debrid/sweep-dead`). 501 = serviço sem varredura nativa e
 * qualquer falha = `null`: o painel responde "indisponível", como antes.
 */
import * as metrics from '../utils/metrics.js';
import { post, remoteOptions } from './rust-remote.js';

export interface SweepDeadResult {
  varridos: number;
  falhas: number;
  observados: number;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A chave da conta vai no corpo, nunca no log. */
export async function sweepDeadNative(
  serviceId: string,
  apiKey: string,
  minAgeMs: number,
): Promise<SweepDeadResult | null> {
  const remote = await post(remoteOptions(), '/debrid/sweep-dead', {
    service: serviceId,
    apiKey,
    minAgeMs,
  });
  if (!remote.ok) {
    metrics.count('rust.debrid.sweep.unavailable');
    return null;
  }
  const body = (remote.json ?? {}) as Record<string, unknown>;
  return {
    varridos: count(body.varridos),
    falhas: count(body.falhas),
    observados: count(body.observados),
  };
}
