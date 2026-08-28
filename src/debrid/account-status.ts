import { opts } from '../runtime.js';
import type { DebridAdapter } from '../../types/domain.js';
import config from '../config.js';
import * as log from '../utils/logger.js';
import { BY_ID, current } from './registry.js';
import { UNUSABLE, failureReason } from './cache-check.js';

// Acima disto o verificador avisa: encher a conta derruba a checagem de cache
// inteira (ela é um upload), e o sintoma na tela — o ⚡ sumindo de TODOS os
// streams — não aponta para a causa.
//
// É um limiar nosso, não o limite do serviço: a AllDebrid tem dois tetos que
// não batem entre si (30 "ativos" na doc, 1000 na mensagem de erro real) e
// nenhum é consultável. 800 dá margem para limpar antes de quebrar; ajuste se
// a sua conta aguentar mais.
const ACCOUNT_WARN_TOTAL = config.debrid.accountWarnTotal;
// Fair-use do Premiumize (`limit_used` em [0, 1]). 0 desliga o aviso.
const ACCOUNT_WARN_LIMIT_USED = config.debrid.accountWarnLimitUsed;

/**
 * Saúde da conta do serviço corrente, para o endpoint de diagnóstico.
 *
 * Nunca lança: o verificador precisa responder justamente quando o serviço está
 * ruim. Os motivos vêm classificados igual ao da busca (`auth`/`quota`), então
 * a mesma linguagem serve para o log e para o JSON.
 */
async function accountStatusFor(adapter: DebridAdapter | null, apiKey: string) {
  if (!adapter) return { ok: false, reason: 'sem-debrid', service: null };
  if (typeof adapter.accountStatus !== 'function') {
    return { ok: true, service: adapter.id, label: adapter.label, supported: false };
  }

  try {
    const status = await adapter.accountStatus(apiKey);
    // O fair-use sai numa variável PRÓPRIA em vez de um booleano `byFairUse`
    // consultando `status.limitUsed` depois: `Number.isFinite` não estreita o
    // tipo através de um intermediário, e o campo é opcional (só o Premiumize
    // publica). Mesmo teste, mesmo resultado — agora verificável.
    const fairUse = Number.isFinite(status.limitUsed) ? Number(status.limitUsed) : null;
    const warn = fairUse !== null
      ? ACCOUNT_WARN_LIMIT_USED > 0 && fairUse >= ACCOUNT_WARN_LIMIT_USED
      : Number(status.magnets) >= ACCOUNT_WARN_TOTAL;
    const warnAt = fairUse !== null ? ACCOUNT_WARN_LIMIT_USED : ACCOUNT_WARN_TOTAL;
    const warnAtUnit = fairUse !== null ? 'fair-use' : 'magnets';
    if (warn) {
      if (fairUse !== null) {
        log.warn(
          `[${adapter.id}] fair-use ${Math.round(fairUse * 100)}% ` +
            `(aviso a partir de ${Math.round(ACCOUNT_WARN_LIMIT_USED * 100)}%); ` +
            'quando o serviço recusar (account_limit_reached) a lista degrada para P2P',
        );
      } else {
        log.warn(
          `[${adapter.id}] ${status.magnets} magnet(s) na conta (aviso a partir de ${ACCOUNT_WARN_TOTAL});` +
            ' quando o serviço recusar novos uploads a checagem de cache para e o ⚡ some da lista inteira' +
            ' — limpe com scripts/magnets.js',
        );
      }
    }
    return {
      ...status,
      ok: true,
      service: adapter.id,
      label: adapter.label,
      supported: true,
      warn,
      warnAt,
      warnAtUnit,
    };
  } catch (err) {
    const reason = failureReason(err);
    const fix = reason === 'auth'
      ? UNUSABLE.auth.fix(adapter)
      : reason === 'quota'
        ? UNUSABLE.quota.fix()
        : reason === 'rate'
          ? 'aguarde alguns minutos para o rate limit passar e consulte novamente'
          : null;
    return { ok: false, service: adapter.id, label: adapter.label, reason, error: err.message, fix };
  }
}

async function accountStatus() {
  const adapter = current();
  return accountStatusFor(adapter, opts().debridApiKey);
}

function withAccountTimeout(task: Promise<any>) {
  return Promise.race([
    task,
    new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, reason: 'timeout', error: 'timeout consultando o debrid' }),
        config.debrid.dashboardAccountTimeoutMs,
      );
      timer.unref?.();
    }),
  ]);
}

/**
 * Contas que a requisição realmente conhece. Não existe chave para os outros
 * adaptadores, então exibi-los como "offline" seria uma mentira operacional.
 */
async function dashboardAccounts(currentStatus: any) {
  const accounts: Record<string, any> = {};
  const active = current();
  if (active && currentStatus?.service) accounts[active.id] = currentStatus;

  const operator = config.debrid.service ? BY_ID.get(config.debrid.service) || null : null;
  if (
    operator &&
    operator.id !== active?.id &&
    config.debrid.apiKey &&
    config.debrid.allowEnvKey
  ) {
    accounts[operator.id] = await withAccountTimeout(accountStatusFor(operator, config.debrid.apiKey));
  }
  return accounts;
}

export { accountStatusFor, accountStatus, dashboardAccounts };
