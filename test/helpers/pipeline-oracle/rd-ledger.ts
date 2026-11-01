// Simulação do ledger RD (`rdc:v2`) para o oráculo de pipeline — a metade de
// ESCRITA que em produção é do GATEWAY: a renovação de hit da checagem é
// `adom-debrid::verdict_ledger::rd_renew_hits`, o `blocked` do play é
// `play_effects_native_writes::note_rd_blocked` e os sinais do warmer são
// `adom-server::rd_warmer_ledger`. Aqui essas observações são refeitas sobre o
// MESMO KV nativo (`rdc:v2`, chave global sem apiKey — o CDN/cache do RD é do
// serviço, não da conta) para os testes de paridade exercitarem a pipeline TS
// como o gateway a alimentaria.
//
// A RÉGUA (próximo estado, TTL e backoff) NÃO é duplicada: vem do vocabulário
// TS que delega ao núcleo (`src/debrid/rd-ledger.js` → napi →
// `adom-core::debrid_rd_ledger`). As escritas inteiras moram aqui — sem
// consumidor de produção no Node, o `noteHit` migrou do `src/` para esta
// fachada como as demais.
//
// Falso negativo é pior que falso positivo: miss expira com backoff e nunca
// condena, `blocked` (recusa legal) vence hit e miss, e nada é gravado sem
// validade.
import config from '../../../src/config.js';
import * as metrics from '../../../src/utils/metrics.js';
import { kvPeek, kvRemaining, kvSet } from '../../../src/utils/native-kv.js';
import {
  key,
  nextOnBlocked,
  nextOnHit,
  nextOnMiss,
  normalizeRdHash,
  peekLedgerState,
} from '../../../src/debrid/rd-ledger.js';
import { assertSafeTestDb } from '../db-guard.js';

assertSafeTestDb('pipeline-oracle/rd-ledger');

type LedgerState = 'hit' | 'miss' | 'blocked' | 'unknown';
type LedgerValue = { s: Exclude<LedgerState, 'unknown'>; at: number; n: number };

function read(hash: string): LedgerValue | null {
  const normalized = normalizeRdHash(hash);
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

function isHit(hash: string) {
  return peek(hash) === 'hit';
}

// `kvSet` com TTL <= 0 gravaria PERMANENTE; o filtro fica aqui para o ledger
// nunca criar linha sem validade.
function writeOne(hash: string, value: LedgerValue, ttlSeconds: number) {
  if (ttlSeconds > 0) kvSet(key(hash), value, ttlSeconds);
}

// Escala do `at` = SEGUNDOS, igual ao gateway: a renovação de hit converte
// now_ms()/1000 antes de montar o `{s, at, n}` (rust/crates/adom-debrid/src/
// verdict_ledger.rs:88, passado ao next_on_hit na :98 e gravado na :103) e o
// warmer repete a conversão (rust/crates/adom-server/src/rd_warmer_ledger.rs:96;
// cabeçalho do arquivo, :5-6: "A unidade de `at` é SEGUNDOS"). Só o payload
// muda: o TTL da LINHA segue em segundos no `kvSet` (e a ponte napi é
// pass-through do `at`, src/utils/rust-debrid-rd.ts:51).
function nowSeconds(): number {
  return Date.now() / 1000;
}

function noteMiss(hash: string) {
  if (!config.debrid.rdLedger.enabled) return;
  const normalized = normalizeRdHash(hash);
  const backoff = config.debrid.rdLedger.missBackoffMs;
  if (!normalized || backoff.length === 0 || peek(normalized) === 'blocked') return;
  const prior = read(normalized);
  const write = nextOnMiss({
    enabled: true,
    hash: normalized,
    backoffMs: backoff,
    now: nowSeconds(),
    current: peekLedgerState(true, prior),
    prior,
  });
  if (!write?.hash) return;
  writeOne(write.hash, { s: 'miss', at: write.at, n: write.n }, write.ttlSeconds);
  metrics.count('debrid.rd.ledger.miss');
  metrics.count('debrid.rd.ledger.noted');
}

function noteBlocked(hash: string) {
  const ttl = config.debrid.rdLedger.blockedTtl;
  const normalized = normalizeRdHash(hash);
  const write = nextOnBlocked({
    enabled: config.debrid.rdLedger.enabled,
    hash: normalized,
    blockedTtl: ttl,
    now: nowSeconds(),
  });
  if (!write?.hash) return;
  writeOne(write.hash, { s: 'blocked', at: write.at, n: write.n }, write.ttlSeconds);
  metrics.count('debrid.rd.ledger.blocked');
  metrics.count('debrid.rd.ledger.noted');
}

/** Renova confirmação já conhecida só na segunda metade do TTL, como magnetdb. */
function renewHits(hashes: string[]) {
  const ttl = config.debrid.rdLedger.hitTtl;
  if (!config.debrid.rdLedger.enabled || ttl <= 0) return;
  const stale = [...new Set(hashes.map(normalizeRdHash))].filter((hash) => {
    if (!hash || peek(hash) !== 'hit') return false;
    const remaining = kvRemaining(key(hash));
    return remaining == null || remaining < ttl / 2;
  });
  noteHit(stale);
}

/**
 * Anota hit (⚡ confirmado). Régua do núcleo (`nextOnHit`): bloqueio legal não
 * é apagado por um caminho atrasado de inventário/recheck. `writeOne` já
 * filtra TTL <= 0 (gravaria PERMANENTE no KV nativo).
 */
function noteHit(hashes: string[]) {
  const ttl = config.debrid.rdLedger.hitTtl;
  if (!config.debrid.rdLedger.enabled || ttl <= 0) return;
  const unique = [...new Set(hashes.map(normalizeRdHash))].filter(Boolean);
  const now = nowSeconds();
  for (const hash of unique) {
    const write = nextOnHit({ enabled: true, hitTtl: ttl, now, current: peek(hash) });
    if (!write) continue;
    writeOne(hash, { s: 'hit', at: write.at, n: write.n }, write.ttlSeconds);
    metrics.count('debrid.rd.ledger.hit');
    metrics.count('debrid.rd.ledger.noted');
  }
}

export { peek, isHit, noteMiss, noteBlocked, renewHits, noteHit };
