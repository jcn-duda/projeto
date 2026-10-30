// Webhook operacional: alertas proativos para incidentes do addon
// (credenciais debrid inválidas, estouro de quota, indexer BR offline, aviso de cota).
//
// Invariantes:
// 1. Best-effort: nunca lança exceção, nunca atrasa caminhos críticos da resposta.
// 2. Cooldown por evento com TTL configurável para evitar tempestades de alertas (spam).
// 3. Sanitização: NUNCA envia tokens de autenticação, segredos ou API keys.

import config from '../config.js';
import { prefix } from './cache-keys.js';
import { kvPeek, kvSet } from './native-kv.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';

export type NotifySeverity = 'info' | 'warning' | 'error';
export type NotifyData = Record<string, unknown>;

export interface NotifyPayload {
  event: string;
  severity: NotifySeverity;
  message: string;
  data: NotifyData;
  at: string;
}

function isNotifyData(value: unknown): value is NotifyData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Remove chaves ou propriedades que possam conter credenciais antes de enviar. */
function sanitizeData(data: NotifyData = {}): NotifyData {
  const safe: NotifyData = {};
  const forbidden = /api[_-]?key|secret|token|pass|auth/i;
  for (const [k, v] of Object.entries(data)) {
    if (forbidden.test(k)) continue;
    if (isNotifyData(v)) {
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
  data: NotifyData = {},
): Promise<boolean> {
  if (!config.notify.enabled || !config.notify.webhookUrl) return false;
  if (!event || !message) return false;

  const key = `${prefix('notify')}${event}`;
  // Cooldown no KV nativo (mesma tabela `cache` do cache.db): a chave e o TTL
  // continuam os mesmos. `kvPeek` é leitura sem efeito — o cooldown não é cache
  // de resposta, não deve contar hit/miss nem promover LRU.
  if (kvPeek(key)) {
    log.debug(`[notify] evento ${event} ignorado por cooldown (${config.notify.cooldownS}s)`);
    return false;
  }

  // Gate ttl>0: `kvSet` com TTL <= 0 gravaria PERMANENTE, e o L1 antigo
  // descartava essa escrita (padrão rd-ledger.ts) — cooldown sem validade
  // não existe.
  if (config.notify.cooldownS > 0) kvSet(key, 1, config.notify.cooldownS);
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
  } catch (err: unknown) {
    log.warn(`[notify] falha ao enviar webhook (${event}):`, log.errorMessage(err));
    return false;
  }
}

export { notify };
export default { notify };
