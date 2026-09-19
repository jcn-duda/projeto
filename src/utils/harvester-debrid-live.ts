// Conta de debrid usada pelas operações de fundo do Colhedor (quota-warn e
// aquecimento do warmer RD), configurável pelo painel SEM editar o `.env`.
//
// Conceito separado do `cfg:v1:harvester` (overrides numéricos do
// harvester-live): aqui vive um SEGREDO, e a chave crua não pode entrar no
// mapa de overrides nem no snapshot. A persistência é própria
// (`cfg:v1:harvesterDebrid`) e guarda a chave cifrada com AES-256-GCM derivada
// do RESOLVE_SECRET (secret-box). Sem RESOLVE_SECRET a gravação é recusada —
// escrever chave em claro no SQLite seria regressão de segurança.
//
// Precedência: override do painel é FONTE ÚNICA do conceito "conta do
// Colhedor" para os dois consumidores; sem override, o comportamento atual
// (conta do `.env` com gate de operador). A conta é do OPERADOR e só roda em
// threads de fundo — nunca entra no registry.current() nem no play de
// instalação alguma. Não importa runtime.ts/opts() de propósito.
import config from '../config.js';
import * as cache from './cache.js';
import { prefix } from './cache-keys.js';
import * as log from './logger.js';
import * as secretBox from './secret-box.js';
import { accountScope } from './request-key.js';
import { BY_ID } from '../debrid/registry.js';
import type { DebridAdapter } from '../../types/domain.js';

const CONFIG_KEY = `${prefix('cfg')}harvesterDebrid`;
const INFINITE_TTL = 315_360_000; // 10 anos em segundos
const MAX_KEY_LENGTH = 512; // mesma régua do teste de conta do debrid

/** Adaptador com `accountStatus` garantido (o contrato que o quota-warn usa). */
type QuotaAdapter = DebridAdapter & { accountStatus: NonNullable<DebridAdapter['accountStatus']> };

type StoredAccount = {
  service: string;
  sealedKey: string;
  updatedAt: number;
};

let stored: StoredAccount | null = null;
let loaded = false;

function initIfNeeded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = cache.get(CONFIG_KEY);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const service = String((raw as Record<string, unknown>).service || '').toLowerCase();
      const sealedKey = String((raw as Record<string, unknown>).sealedKey || '');
      if (service && sealedKey) {
        stored = { service, sealedKey, updatedAt: Number((raw as Record<string, unknown>).updatedAt) || Date.now() };
        log.info(`[harvest-debrid] conta de fundo do colhedor carregada do disco: ${service}`);
      }
    }
  } catch (err: unknown) {
    log.warn('[harvest-debrid] falha ao carregar conta do cache:', log.errorMessage(err));
  }
}

function persist(): void {
  try {
    if (!stored) cache.forget(CONFIG_KEY);
    else cache.set(CONFIG_KEY, stored, INFINITE_TTL);
  } catch (err: unknown) {
    log.warn('[harvest-debrid] erro ao persistir conta no cache:', log.errorMessage(err));
  }
}

export interface HarvesterDebridCapabilities {
  /** Pode consultar a saúde da conta (checkQuotaWarning). */
  quotaWarn: boolean;
  /** Pode aquecer o cachê do Real-Debrid (warmer RD). */
  brWarm: boolean;
}

/**
 * Capacidades de UMA seleção de serviço — derivadas do adaptador, não uma
 * lista à mão (drift zero). O quota-warn é genérico (qualquer serviço com
 * `accountStatus`); o aquecimento RD é exclusivo do Real-Debrid porque a
 * sonda de instante dele é específica do serviço — escolher AllDebrid aqui
 * desliga o warm RD e a UI mostra essa capacidade como "não".
 */
export function deriveCapabilities(service: string): HarvesterDebridCapabilities {
  const adapter = service ? BY_ID.get(service) : undefined;
  return {
    quotaWarn: Boolean(adapter && typeof adapter.accountStatus === 'function'),
    brWarm: service === 'realdebrid',
  };
}

/** Conta salva pelo painel (nunca a chave aberta). */
export function get(): StoredAccount | null {
  initIfNeeded();
  return stored;
}

function openKey(sealed: string): string | null {
  const opened = secretBox.open(sealed);
  return typeof opened === 'string' && opened ? opened : null;
}

function operatorGateOpen(): boolean {
  return Boolean(config.debrid.envOperatorAccount);
}

/** Monta o par conta+chave com `accountStatus` já garantido pelo check. */
function asQuota(adapter: DebridAdapter | null | undefined, apiKey: string): { adapter: QuotaAdapter; apiKey: string } | null {
  if (!adapter || !apiKey || typeof adapter.accountStatus !== 'function') return null;
  return { adapter: { ...adapter, accountStatus: adapter.accountStatus }, apiKey };
}

/**
 * Conta de fundo para o quota-warn: painel > env (`.env` com gate de
 * operador). Ausência segura: sem gate, sem chave válida ou adaptador sem
 * `accountStatus`, devolve null — o aviso simplesmente não roda.
 */
export function resolveQuota(): { adapter: QuotaAdapter; apiKey: string } | null {
  const s = get();
  if (s) {
    const adapter = BY_ID.get(s.service);
    const apiKey = openKey(s.sealedKey);
    if (adapter && apiKey) return asQuota(adapter, apiKey);
    return null;
  }
  if (!operatorGateOpen()) return null;
  const adapter = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (adapter && config.debrid.apiKey) return asQuota(adapter, config.debrid.apiKey);
  return null;
}

/**
 * Resultado da resolução da conta de fundo para o warmer RD. Discriminado de
 * propósito: o consumidor precisa saber se o painel GRAVOU outra conta
 * (desligando o warm mesmo com `.env` RD) ou se simplesmente não há conta
 * utilizável (quando a credencial de sessão ainda pode destravar).
 *
 * - `panel`: override do painel é Real-Debrid com chave que abre — fonte única.
 * - `env`: sem override, conta do `.env` com gate de operador (comportamento atual).
 * - `off`: nada utilizável. `painel-desliga` = o painel gravou serviço não-RD
 *   (ou chave que não abre) — o aquecimento fica desligado DE PROPÓSITO e não
 *   pode cair no `.env` por baixo; `sem-conta` = sem conta de fundo alguma.
 */
export type WarmResolve =
  | { source: 'panel'; apiKey: string }
  | { source: 'env'; apiKey: string }
  | { source: 'off'; reason: 'painel-desliga' | 'sem-conta' };

/**
 * Conta de fundo para o warmer RD: SÓ Real-Debrid. O override do painel é
 * fonte única — gravar AllDebrid desliga o warm mesmo com `.env` RD (a UI
 * mostra `brWarm: false` para não prometer em silêncio). Sem override, cai na
 * conta do `.env` com o gate de operador (comportamento atual).
 */
export function resolveWarm(): WarmResolve {
  const s = get();
  if (s) {
    if (s.service !== 'realdebrid') return { source: 'off', reason: 'painel-desliga' };
    const adapter = BY_ID.get('realdebrid');
    const apiKey = openKey(s.sealedKey);
    // Painel RD com selo que não abre também desliga (fonte única): o `.env`
    // não volta por baixo de um override definido com chave inutilizável.
    if (adapter && apiKey) return { source: 'panel', apiKey };
    return { source: 'off', reason: 'painel-desliga' };
  }
  if (!operatorGateOpen()) return { source: 'off', reason: 'sem-conta' };
  if (config.debrid.service === 'realdebrid' && config.debrid.apiKey) {
    const adapter = BY_ID.get('realdebrid');
    if (adapter) return { source: 'env', apiKey: config.debrid.apiKey };
  }
  return { source: 'off', reason: 'sem-conta' };
}

export interface HarvesterDebridSnapshot {
  service: string | null;
  keySet: boolean;
  /** Override gravado no painel, mas a chave selada NÃO abre (RESOLVE_SECRET
   * rotacionado/alterado): as features de fundo estão mortas e a UI precisa
   * avisar, não só mostrar "chave não definida" com o serviço do painel. */
  sealBroken: boolean;
  last4: string;
  fingerprint: string;
  capabilities: HarvesterDebridCapabilities;
  /** Capacidades por serviço (mesma fonte do backend): o front NÃO duplica a
   * tabela — escolher AllDebrid/RD/Debrid-Link no seletor deriva daqui. */
  capabilitiesByService: Record<string, HarvesterDebridCapabilities>;
  source: 'panel' | 'env' | 'none';
  envService: string;
  sealed: boolean;
  updatedAt: number | null;
}

function identityOf(key: string): { last4: string; fingerprint: string } {
  if (!key) return { last4: '', fingerprint: '' };
  return { last4: key.slice(-4), fingerprint: accountScope(key).slice(0, 8) };
}

function capabilitiesByService(): Record<string, HarvesterDebridCapabilities> {
  const out: Record<string, HarvesterDebridCapabilities> = {};
  for (const service of BY_ID.keys()) out[service] = deriveCapabilities(service);
  return out;
}

/**
 * Estado seguro da conta — identidade (last4/fingerprint) e origem, NUNCA a
 * chave crua. Encaixa no bloco `harvest` do dashboard-status e na resposta
 * das ações do painel.
 */
export function snapshot(): HarvesterDebridSnapshot {
  const capsByService = capabilitiesByService();
  const s = get();
  if (s) {
    const key = openKey(s.sealedKey);
    const id = identityOf(key || '');
    return {
      service: s.service,
      keySet: Boolean(key),
      // Override gravado que não abre: o segredo mudou e o quota-warn/warm
      // estão desligados de propósito (fail-closed). A UI mostra o aviso.
      sealBroken: !key,
      last4: id.last4,
      fingerprint: id.fingerprint,
      capabilities: deriveCapabilities(s.service),
      capabilitiesByService: capsByService,
      source: 'panel',
      envService: config.debrid.service,
      sealed: true,
      updatedAt: s.updatedAt,
    };
  }
  const envKey = config.debrid.apiKey;
  const envService = config.debrid.service;
  // `source` descreve a conta que as features de fundo PODEM usar, não só a
  // presença de bytes no `.env`: gate fechado significa nenhuma conta ativa.
  if (envKey && envService && operatorGateOpen()) {
    const id = identityOf(envKey);
    return {
      service: envService,
      keySet: true,
      sealBroken: false,
      last4: id.last4,
      fingerprint: id.fingerprint,
      capabilities: deriveCapabilities(envService),
      capabilitiesByService: capsByService,
      source: 'env',
      envService,
      sealed: false,
      updatedAt: null,
    };
  }
  return {
    service: null,
    keySet: false,
    sealBroken: false,
    last4: '',
    fingerprint: '',
    capabilities: { quotaWarn: false, brWarm: false },
    capabilitiesByService: capsByService,
    source: 'none',
    // Mantém o serviço configurado como pista operacional, sem afirmar que a
    // conta está ativa nem expor identidade da chave com o gate fechado.
    envService,
    sealed: false,
    updatedAt: null,
  };
}

export type HarvesterDebridSetResult =
  | { ok: true }
  | { ok: false; reason: string; fix: string };

/**
 * Grava a conta do painel. `key` vazio restaura o `.env` (clear) — remoção
 * não grava nada, então não exige gate de operador nem RESOLVE_SECRET, e o
 * serviço informado é irrelevante (o front manda o serviço atual por hábito).
 * Com chave presente: exige o gate de operador (mesma linguagem do
 * catalog-env) e o RESOLVE_SECRET para cifrar — sem o segredo, recusa em vez
 * de gravar chave em claro.
 */
export function set(serviceRaw: string, keyRaw: string): HarvesterDebridSetResult {
  const service = String(serviceRaw || '').trim().toLowerCase();
  const key = String(keyRaw || '').trim();
  if (!key) {
    clear();
    return { ok: true };
  }
  const adapter = service ? BY_ID.get(service) : undefined;
  if (!adapter) {
    return { ok: false, reason: 'servico-desconhecido', fix: 'escolha um dos serviços suportados pelo addon' };
  }
  if (!operatorGateOpen()) {
    return {
      ok: false,
      reason: 'chave-operador-desativada',
      fix: 'ligue DEBRID_OPERATOR_ENV_ACCOUNT (ou DEBRID_ALLOW_ENV_KEY) no .env para usar a conta de operador do colhedor',
    };
  }
  if (key.length > MAX_KEY_LENGTH) {
    return {
      ok: false,
      reason: 'chave-invalida',
      fix: `chave acima de ${MAX_KEY_LENGTH} caracteres; confira se foi colada por inteiro, sem conteúdo extra`,
    };
  }
  if (!secretBox.enabled()) {
    return {
      ok: false,
      reason: 'resolve_secret_required',
      fix: 'defina RESOLVE_SECRET no .env para permitir salvar a chave cifrada (a chave crua nunca é gravada em claro)',
    };
  }
  initIfNeeded();
  stored = { service, sealedKey: secretBox.seal(key), updatedAt: Date.now() };
  persist();
  log.info(`[harvest-debrid] conta de fundo do colhedor salva pelo painel: ${service}`);
  return { ok: true };
}

/** Remove o override do painel e volta ao `.env` (ou a nenhuma conta). */
export function clear(): void {
  initIfNeeded();
  if (!stored) return;
  stored = null;
  persist();
  log.info('[harvest-debrid] conta de fundo do colhedor removida; usando .env');
}

/** Zera só a memória — a persistência continua no cache (simula restart). */
export function resetMemory(): void {
  stored = null;
  loaded = false;
}

/** Zera memória E persistência (uso em testes/limpeza). */
export function resetForTest(): void {
  resetMemory();
  try {
    cache.forget(CONFIG_KEY);
  } catch {
    /* cache derrubado em teste não impede reset */
  }
}

export default {
  get,
  snapshot,
  set,
  clear,
  resolveQuota,
  resolveWarm,
  deriveCapabilities,
  resetMemory,
  resetForTest,
};
