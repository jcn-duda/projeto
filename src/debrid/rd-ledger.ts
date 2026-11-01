// Ledger durável de disponibilidade do Real-Debrid (`rdc:v2`) — LADO NODE:
// leitura e vocabulário; a escrita inteira é do GATEWAY (a DECISÃO também):
// o veredito combinado (ledger + miss nunca condena + kill-switches) é
// computado no Rust (`adom-debrid::verdict` → `verdict_ledger::rd_ledger_known`,
// chamado pela ponte 8710) e as escritas de produção são nativas — a
// renovação de hit é `rd_renew_hits`, o `blocked` do play é
// `play_effects_native_writes::note_rd_blocked` e os sinais do warmer são
// `rd_warmer_ledger`. A simulação de escrita dos testes mora no oráculo
// (`test/helpers/pipeline-oracle/rd-ledger.ts`).
//
// O CDN/cache do RD pertence ao SERVIÇO, não à conta que observou o
// resultado; por isso a chave deste ledger (`rdc:v2:<hash>`) deliberadamente
// não leva apiKey nem accountScope. Isto convive com `mag:alive`, que continua
// por conta e registra um play que funcionou naquela credencial. Falso
// negativo é pior que falso positivo: miss expira com backoff e nunca condena
// uma release sem nova medição.
import config from '../config.js';
import { prefix } from '../utils/cache-keys.js';
import { QUOTAS } from '../utils/cache-quotas.js';
import { kvKeys, kvPeek } from '../utils/native-kv.js';
import { rdNextBlocked, rdNextHit, rdNextMiss } from '../utils/rust-debrid-rd.js';

type LedgerState = 'hit' | 'miss' | 'blocked' | 'unknown';
type LedgerValue = { s: Exclude<LedgerState, 'unknown'>; at: number; n: number };

/** Próximo valor do ledger. `hash` só vem em miss/blocked (a chave lógica). */
type RdLedgerWrite = {
  s: Exclude<LedgerState, 'unknown'>;
  at: number;
  n: number;
  ttlSeconds: number;
  hash?: string;
};

/** 40 hex depois de lower; qualquer outra forma é vazio e a leitura é unknown. */
export function normalizeRdHash(hash: string): string {
  const value = String(hash || '').toLowerCase();
  return /^[a-f0-9]{40}$/.test(value) ? value : '';
}

function hashOf(hash: string) {
  return normalizeRdHash(hash);
}

/** Desligado, ausente ou `s` fora do trio → `unknown`. Não olha apiKey. */
export function peekLedgerState(
  enabled: boolean,
  stored: { s?: unknown } | null | undefined,
): LedgerState {
  if (!enabled || !stored) return 'unknown';
  const s = stored.s;
  if (s === 'hit' || s === 'miss' || s === 'blocked') return s;
  return 'unknown';
}

/**
 * Hit refresca `{s,at,n:0}`. Bloqueio legal não é apagado por inventário
 * atrasado: `current === 'blocked'` não escreve.
 */
export function nextOnHit(input: {
  enabled: boolean;
  hitTtl: number;
  now: number;
  current: LedgerState;
}): RdLedgerWrite | null {
  return rdNextHit(input);
}

/**
 * Miss só adia a próxima sonda. O degrau é `backoff[min(n, último)]` e o `n`
 * continua crescendo — nunca vira "uncached permanente". `blocked` não cede.
 * `ttlMs` 0/NaN não escreve; o resto vira segundos com teto mínimo de 1.
 */
export function nextOnMiss(input: {
  enabled: boolean;
  hash: string;
  backoffMs: readonly number[];
  now: number;
  current: LedgerState;
  prior: { s?: unknown; n?: number } | null;
}): RdLedgerWrite | null {
  return rdNextMiss(input);
}

/** Bloqueio cobre hit e miss. TTL não positivo ou hash inválido não escreve. */
export function nextOnBlocked(input: {
  enabled: boolean;
  hash: string;
  blockedTtl: number;
  now: number;
}): RdLedgerWrite | null {
  return rdNextBlocked(input);
}

function key(hash: string) {
  return `${prefix('rdc')}${hashOf(hash)}`;
}

// O ledger é lido pelo `adom-debrid` direto da tabela `cache`, então a verdade
// mora no KV nativo: o Node lê pela ponte e nunca por L1 (um L1 com a versão
// antiga da linha venceria a escrita do Rust).
function read(hash: string): LedgerValue | null {
  const normalized = hashOf(hash);
  if (!config.debrid.rdLedger.enabled || !normalized) return null;
  const value = kvPeek(key(normalized)) as LedgerValue | null;
  if (!value || !['hit', 'miss', 'blocked'].includes(value.s)) return null;
  return value;
}

function peek(hash: string): LedgerState {
  // `blocked` ocupa a mesma chave e não é sobrescrito por hit/miss; assim ele
  // vence mesmo quando uma evidência antiga ainda existe no processo.
  return peekLedgerState(config.debrid.rdLedger.enabled, read(hash));
}

/** Leitura para varreduras: não promove LRU nem incrementa hit/miss do cache. */
function peekQuiet(hash: string): LedgerState {
  const normalized = hashOf(hash);
  if (!config.debrid.rdLedger.enabled || !normalized) return 'unknown';
  return peekLedgerState(true, kvPeek(key(normalized)) as LedgerValue | null);
}

/**
 * Diagnóstico do painel. A amostra em processo morreu com as escritas: quem
 * grava o ledger é o gateway (`rd_renew_hits`, `note_rd_blocked`,
 * `rd_warmer_ledger`), então os contadores do Node são sempre 0 — o número
 * REAL de linhas vivas é a ocupação durável do namespace `rdc` no KV nativo
 * (`l1Entries`, com a cota `rdc`). Pode diferir da amostra: inclui linhas
 * escritas pelo gateway e de outros processos. Sem a cota, inventar um número
 * no painel é pior que zero.
 */
function status() {
  return {
    tracked: 0,
    hits: 0,
    misses: 0,
    blocked: 0,
    l1Entries: kvKeys(prefix('rdc')).length,
    l1Max: QUOTAS.rdc || 0,
    _origem: {
      tracked: 'amostra' as const,
      hits: 'amostra' as const,
      misses: 'amostra' as const,
      blocked: 'amostra' as const,
      l1Entries: 'duravel' as const,
      l1Max: 'duravel' as const,
    },
  };
}

export { key, peekQuiet, status };
