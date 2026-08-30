import { opts } from '../runtime.js';
import type { DebridAdapter } from '../../types/domain.js';
import config from '../config.js';
import * as log from '../utils/logger.js';
import { accountScope } from '../utils/request-key.js';
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

// Memo curto da consulta (em memória, por processo): abas concorrentes do
// dashboard disparavam a mesma consulta em rajada — e na AllDebrid consultar
// saúde É um upload, então N abas viravam N uploads na conta. A chave é
// adapter + accountScope(apiKey): a credencial nunca entra na chave (mesma
// convenção do magnetdb/davail). O crescimento do Map tem teto duro abaixo
// (estourou, a entrada mais antiga sai) — o TTL limita staleness, não tamanho.
const memo = new Map<string, { value: any; fetchedAt: number }>();
// Coalescing: quem chega DURANTE a consulta espera a mesma promessa em vez de
// abrir a segunda chamada.
const inFlight = new Map<string, Promise<any>>();

/**
 * Consulta de saúde com memo curto + coalescing, por adapter + conta.
 *
 * Falha transiente (rate/timeout/rede) TAMBÉM entra no memo — não memoizá-la
 * seria pior: cada aba aberta durante a instabilidade martelaria a API já
 * doente. O teto do congelamento é o próprio TTL: expirou, a leitura
 * seguinte reconsulta (default 60s; 0 desliga o memo e restaura o
 * comportamento anterior). `fetchedAt`/`cached` viajam no corpo para o
 * painel mostrar a idade da leitura; `cached:false` também cobre quem
 * participou da consulta em voo (dado novo, não servido do memo).
 *
 * Resultados que não tocam a rede (`sem-debrid`, adaptador sem accountStatus)
 * ficam FORA do memo: são determinísticos, custam nada e seguem com o corpo
 * antigo, sem campos novos.
 */
async function memoizedAccountStatus(adapter: DebridAdapter | null, apiKey: string) {
  if (!adapter || typeof adapter.accountStatus !== 'function') {
    return accountStatusFor(adapter, apiKey);
  }
  const ttlMs = Math.max(0, config.debrid.dashboardAccountTtlMs);
  const key = `${adapter.id}:${accountScope(apiKey)}`;
  if (ttlMs === 0) {
    const value = await accountStatusFor(adapter, apiKey);
    return { ...value, cached: false, fetchedAt: Date.now() };
  }
  const hit = memo.get(key);
  if (hit && Date.now() - hit.fetchedAt < ttlMs) {
    return { ...hit.value, cached: true };
  }
  const pending = inFlight.get(key);
  if (pending) {
    return { ...(await pending), cached: false };
  }
  const fetchedAt = Date.now();
  // Teto defensivo do mapa: TTL limita a STALENESS do valor, não o tamanho —
  // numa instância pública cada install distinta que abrir o painel criaria
  // uma entrada viva pelo processo inteiro. 64 contas é domínio sobrando;
  // estourou, a entrada mais antiga (ordem de inserção do Map) cede lugar.
  if (memo.size >= 64 && !memo.has(key)) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  // `finally` no lugar do delete pós-await: o seguidor nunca encontra a
  // promessa morta na fila, mesmo se esta corrida rejeitar (accountStatusFor
  // não lança, mas o custo da garantia é uma linha).
  const task = (async () => {
    const value = { ...(await accountStatusFor(adapter, apiKey)), cached: false, fetchedAt };
    memo.set(key, { value, fetchedAt });
    return value;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  // Cópia rasa em TODA saída: o objeto do memo nunca vaza mutável para o
  // chamador (rotas serializam para JSON, mas o contrato não depende disso).
  return { ...(await task) };
}

/** Testes: esvazia memo e fila em voo (cada teste remonta os dublês de fetch). */
function resetAccountStatusMemo() {
  memo.clear();
  inFlight.clear();
}

async function accountStatus() {
  const adapter = current();
  return memoizedAccountStatus(adapter, opts().debridApiKey);
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
    config.debrid.envOperatorAccount
  ) {
    // Mesmo memo da conta ativa: abas concorrentes dividem a leitura do
    // operador também. O timeout continua por fora — memo hit resolve na
    // hora; fresh que estoura o prazo segue em fundo e alimenta o memo para
    // o próximo poll.
    accounts[operator.id] = await withAccountTimeout(
      memoizedAccountStatus(operator, config.debrid.apiKey),
    );
  }
  return accounts;
}

export { accountStatusFor, accountStatus, dashboardAccounts, resetAccountStatusMemo };
