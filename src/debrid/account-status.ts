import { opts } from '../runtime.js';
import type { AccountStatus, DebridAdapter } from '../../types/domain.js';
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
 * Limiares de aviso da ocupação, calculados SEM efeito colateral: o caminho do
 * verificador loga o aviso, o teste de conta (`testAccount`) só o reporta — a
 * chave testada pode nem ser a de ninguém ainda, e não é ela que deve virar
 * log do processo.
 */
function accountWarnFlags(status: AccountStatus) {
  // O fair-use sai numa variável PRÓPRIA em vez de um booleano `byFairUse`
  // consultando `status.limitUsed` depois: `Number.isFinite` não estreita o
  // tipo através de um intermediário, e o campo é opcional (só o Premiumize
  // publica). Mesmo teste, mesmo resultado — agora verificável.
  const fairUse = Number.isFinite(status.limitUsed) ? Number(status.limitUsed) : null;
  const warn = fairUse !== null
    ? ACCOUNT_WARN_LIMIT_USED > 0 && fairUse >= ACCOUNT_WARN_LIMIT_USED
    : Number(status.magnets) >= ACCOUNT_WARN_TOTAL;
  return {
    fairUse,
    warn,
    warnAt: fairUse !== null ? ACCOUNT_WARN_LIMIT_USED : ACCOUNT_WARN_TOTAL,
    warnAtUnit: fairUse !== null ? 'fair-use' : 'magnets',
  };
}

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
    const { fairUse, warn, warnAt, warnAtUnit } = accountWarnFlags(status);
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

function withAccountTimeout(task: Promise<any>, adapter: DebridAdapter | null = null) {
  return Promise.race([
    task,
    new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({
          ok: false,
          reason: 'timeout',
          error: 'timeout consultando o debrid',
          // Sem service o gate de dashboardAccounts descarta e o espelho some.
          ...(adapter ? {
            service: adapter.id,
            label: adapter.label,
            fix: TIMEOUT_FIX,
          } : {}),
        }),
        config.debrid.dashboardAccountTimeoutMs,
      );
      timer.unref?.();
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Teste de conta sob demanda (action `debrid-account-test` do painel — Fase 1
// do debrid configurável). É o único caminho que consulta a saúde de uma
// chave que AINDA NÃO está salva em lugar nenhum: sem memo (o memo curto
// acima serve só às contas já configuradas — credencial em teste não pode
// poluí-lo nem herdar leitura velha dela mesma), sem persistência (davail/
// magnetdb/ledger intocados) e sem ler opts()/runtime — adapter e chave chegam
// explícitos da rota. O teste NÃO salva, NÃO aplica e NÃO troca config.
// ---------------------------------------------------------------------------

type AccountTestCapabilities = {
  cacheCheck: boolean;
  abortSafeCacheCheck: boolean;
  accountStatus: boolean;
  inventory: boolean;
  autofetch: boolean;
  torrentStatus: boolean;
  catalogCleanup: boolean;
};

export type AccountTestOutcome =
  | {
      ok: true;
      service: string;
      label: string;
      keySet: true;
      last4: string;
      fingerprint: string;
      account: Record<string, unknown>;
      capabilities: AccountTestCapabilities;
    }
  | {
      ok: false;
      service: string;
      label: string;
      keySet: true;
      last4: string;
      fingerprint: string;
      reason: string;
      fix: string | null;
      error?: string;
      capabilities: AccountTestCapabilities;
    };

// Campos do AccountStatus que podem ecoar ao painel. Allowlist FECHADA de
// propósito: o status vem de resposta de terceiro, e campo novo que apareça
// lá não vaza por padrão — entra aqui depois de revisado.
const SAFE_ACCOUNT_FIELDS = [
  'magnets', 'ready', 'active', 'error', 'limitUsed', 'premiumUntil', 'oldestAt',
] as const;

function safeAccount(status: AccountStatus): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SAFE_ACCOUNT_FIELDS) {
    const value = status[field];
    if (value !== undefined && value !== null) out[field] = value;
  }
  return out;
}

// Capacidades derivadas SÓ do adaptador bruto do registry (mesma semântica do
// SERVICES da /configure): o cacheCheck dinâmico do RD (ledger+oráculo) é
// decisão do current() em runtime e não é recalculado aqui — o painel mostra o
// que o adaptador DECLARA, não o que a config corrente habilita.
function accountCapabilities(adapter: DebridAdapter): AccountTestCapabilities {
  const base: AccountTestCapabilities = {
    cacheCheck: adapter.cacheCheck === true,
    // Campo opcional: ausente = consulta abortável (só a AllDebrid declara false).
    abortSafeCacheCheck: adapter.abortSafeCacheCheck !== false,
    accountStatus: typeof adapter.accountStatus === 'function',
    inventory: typeof adapter.inventory === 'function',
    // Mesmo critério do canAutoFetchBr: cacheCheck confiável OU fonte por inventário.
    autofetch: Boolean(typeof adapter.enqueue === 'function' && (adapter.cacheCheck || adapter.autofetchSource)),
    torrentStatus: typeof adapter.torrentStatus === 'function',
    // Só quem lista magnets da conta entra no catálogo/limpador do painel.
    catalogCleanup: typeof adapter.magnetList === 'function',
  };
  // RD declara cacheCheck:false cru, mas o capability `true` aqui NÃO mente:
  // a checagem dinâmica é decisão do runtime (ledger+oráculo habilitados) e o
  // painel sem esse ajuste mostraria "consulta de cache: não" para o serviço
  // que mais investe nela. É o mesmo contrato do clone de `current()`.
  if (adapter.id === 'realdebrid') base.cacheCheck = true;
  return base;
}

// Identidade SEGURA da chave testada: nunca a chave, nunca o accountScope
// inteiro. `last4` orienta o olho humano; 8 chars do sha256 bastam para
// correlacionar dois testes da mesma chave sem viabilizar inversão.
function keyIdentity(apiKey: string) {
  return { keySet: true as const, last4: apiKey.slice(-4), fingerprint: accountScope(apiKey).slice(0, 8) };
}

// Mensagem de erro de terceiro pode ecoar a credencial (URL em falha de rede,
// corpo de resposta). A máscara cobre a chave crua e a forma URL-encoded, que
// é como ela viaja em query string. split/join em vez de regex: chave com
// metacaractere não pode virar padrão.
function scrubKey(text: string, apiKey: string): string {
  let out = text;
  for (const form of new Set([apiKey, encodeURIComponent(apiKey)])) {
    if (form && form !== '***') out = out.split(form).join('***');
  }
  return out;
}

const TIMEOUT_FIX =
  'o serviço não respondeu dentro do prazo do painel; tente de novo — persistindo, o serviço está instável ou a rede está lenta';

/**
 * Consulta a saúde da chave INFORMADA, sem memo e sem efeito colateral, e
 * devolve um payload que NUNCA contém a chave nem o accountScope completo.
 * Nunca lança: o resultado do teste é o próprio corpo (auth/quota/rate/falha/
 * timeout/nao-suportado), no mesmo vocabulário do verificador de conta.
 */
async function testAccount(adapter: DebridAdapter, apiKey: string): Promise<AccountTestOutcome> {
  const base = {
    service: adapter.id,
    label: adapter.label,
    ...keyIdentity(apiKey),
    capabilities: accountCapabilities(adapter),
  };
  if (typeof adapter.accountStatus !== 'function') {
    return {
      ...base,
      ok: false,
      reason: 'nao-suportado',
      fix: `${adapter.label} não publica ocupação de conta na API; o addon não consegue validar a chave sem um play real`,
    };
  }
  const task = adapter.accountStatus(apiKey);
  // A corrida com o timeout pode desistir da consulta; rejeição tardia sem
  // observador viraria unhandledRejection no processo.
  task.catch(() => {});
  try {
  const outcome: any = await withAccountTimeout(task, adapter);
    if (outcome && outcome.ok === false && outcome.reason === 'timeout') {
      return { ...base, ok: false, reason: 'timeout', error: outcome.error, fix: TIMEOUT_FIX };
    }
    const status: AccountStatus = outcome;
    // Sem `accountWarnFlags` de propósito: warn/warnAt são os LIMIARES do
    // operador (.env) e esta conta pode ser de outra pessoa — ocupação crua
    // no payload, sem semântica emprestada.
    return { ...base, ok: true, account: safeAccount(status) };
  } catch (err) {
    const reason = failureReason(err);
    const fix = reason === 'auth'
      ? UNUSABLE.auth.fix(adapter)
      : reason === 'quota'
        ? UNUSABLE.quota.fix()
        : reason === 'rate'
          ? 'aguarde alguns minutos para o rate limit passar e teste novamente'
          : null;
    return {
      ...base,
      ok: false,
      reason,
      fix,
      error: scrubKey(log.errorMessage(err), apiKey).slice(0, 300),
    };
  }
}

/**
 * Contas que a requisição realmente conhece. Não existe chave para os outros
 * adaptadores, então exibi-los como "offline" seria uma mentira operacional.
 */
async function dashboardAccounts(currentStatus: any) {
  const accounts: Record<string, any> = {};
  const active = current();
  // Timeout enriquecido traz service; se ainda faltar, completa do adaptador
  // ativo para o espelho não zerar (gate antigo descartava sem service).
  if (active && currentStatus?.service) accounts[active.id] = currentStatus;
  else if (active && currentStatus?.reason === 'timeout') {
    accounts[active.id] = { ...currentStatus, service: active.id, label: active.label, fix: TIMEOUT_FIX };
  }

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
      operator,
    );
  }
  return accounts;
}

export { accountStatusFor, accountStatus, dashboardAccounts, testAccount, resetAccountStatusMemo };
