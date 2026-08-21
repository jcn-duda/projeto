// Webhook operacional: alertas proativos para incidentes do addon
// (credenciais debrid inválidas, estouro de quota, indexer BR offline, aviso de cota).
//
// Invariantes:
// 1. Best-effort: nunca lança exceção, nunca atrasa caminhos críticos da resposta.
// 2. Cooldown por evento com TTL configurável para evitar tempestades de alertas (spam).
// 3. Sanitização: NUNCA envia tokens de autenticação, segredos ou API keys.

import config from '../config.js';
import * as cache from './cache.js';
import { prefix } from './cache-keys.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';

export type NotifySeverity = 'info' | 'warning' | 'error';

export interface NotifyPayload {
  event: string;
  severity: NotifySeverity;
  message: string;
  data: Record<string, any>;
  at: string;
}

/** Remove chaves ou propriedades que possam conter credenciais antes de enviar. */
function sanitizeData(data: Record<string, any> = {}): Record<string, any> {
  const safe: Record<string, any> = {};
  const forbidden = /api[_-]?key|secret|token|pass|auth/i;
  for (const [k, v] of Object.entries(data)) {
    if (forbidden.test(k)) continue;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      safe[k] = sanitizeData(v);
    } else {
      safe[k] = v;
    }
  }
  return safe;
}

async function notify(
  event: string,
  severity: NotifySeverity,
  message: string,
  data: Record<string, any> = {},
): Promise<boolean> {
  if (!config.notify.enabled || !config.notify.webhookUrl) return false;
  if (!event || !message) return false;

  const key = `${prefix('notify')}${event}`;
  if (cache.get(key)) {
    log.debug(`[notify] evento ${event} ignorado por cooldown (${config.notify.cooldownS}s)`);
    return false;
  }

  cache.set(key, 1, config.notify.cooldownS);
  metrics.count(`notify.${event}`);

  const payload: NotifyPayload = {
    event,
    severity,
    message,
    data: sanitizeData(data),
    at: new Date().toISOString(),
  };

  try {
    const res = await fetch(config.notify.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'stremio-adom-notify/1.0',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn(`[notify] webhook retornou status ${res.status} para ${event}`);
      return false;
    }
    return true;
  } catch (err: any) {
    log.warn(`[notify] falha ao enviar webhook (${event}):`, err?.message || err);
    return false;
  }
}

export { notify };
export default { notify };
