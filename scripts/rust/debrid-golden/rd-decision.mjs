/**
 * Oráculo da Fase D3. Lê test/fixtures/debrid/rd/cases.json, roda as transições
 * puras exportadas do dist (rd-ledger / rd-gate) e grava o golden que o teste
 * Rust compara. Sem rede, sem cache e sem credencial.
 *
 *   node scripts/rust/debrid-golden/rd-decision.mjs
 *   node scripts/rust/debrid-golden/rd-decision.mjs --dist=dist
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CASES = path.join(ROOT, 'test/fixtures/debrid/rd/cases.json');
const OUT = path.join(ROOT, 'rust/crates/adom-core/tests/golden/debrid_rd_decision.json');

const flag = process.argv.find((arg) => arg.startsWith('--dist='));
const dist = flag ? path.resolve(flag.slice('--dist='.length)) : path.join(ROOT, 'dist');

const ledger = await import(pathToFileURL(path.join(dist, 'src/debrid/rd-ledger.js')).href);
const gate = await import(pathToFileURL(path.join(dist, 'src/debrid/rd-gate.js')).href);
const cases = JSON.parse(fs.readFileSync(CASES, 'utf8'));

function retryOf(input) {
  if (!Object.hasOwn(input, 'retryAfterMs') || input.retryAfterMs === null) return undefined;
  return input.retryAfterMs;
}

function runLedger(entry) {
  const input = entry.input;
  switch (entry.op) {
    case 'normalize_hash':
      return { hash: ledger.normalizeRdHash(input.hash) };
    case 'ledger_key':
      return { key: ledger.key(input.hash) };
    case 'peek_state':
      return { state: ledger.peekLedgerState(input.enabled, input.stored) };
    case 'next_on_hit':
      return { write: ledger.nextOnHit(input) };
    case 'next_on_miss':
      return { write: ledger.nextOnMiss({ ...input, prior: input.prior ?? null }) };
    case 'next_on_blocked':
      return { write: ledger.nextOnBlocked(input) };
    default:
      throw new Error(`op de ledger desconhecida: ${entry.op}`);
  }
}

function runGate(entry) {
  const input = entry.input;
  switch (entry.op) {
    case 'initial_state':
      return { state: gate.rdGateInitialState(input.minGapMs, input.maxGapMs) };
    case 'on_rate_limit': {
      const step = gate.rdGateOnRateLimit(input.state, {
        minGapMs: input.minGapMs,
        maxGapMs: input.maxGapMs,
        cooldownMs: input.cooldownMs,
        retryAfterMs: retryOf(input),
        now: input.now,
      });
      return {
        honoredRetryAfter: step.honoredRetryAfter,
        state: {
          ...input.state,
          gapMs: step.gapMs,
          successes: step.successes,
          nextAllowedAt: step.nextAllowedAt,
          cooldownUntil: step.cooldownUntil,
          rateLimits: step.rateLimits,
        },
      };
    }
    case 'on_success': {
      const step = gate.rdGateOnSuccess(
        input.state.gapMs,
        input.state.successes,
        input.successThreshold,
        input.minGapMs,
        input.maxGapMs,
      );
      return { state: { ...input.state, gapMs: step.gapMs, successes: step.successes } };
    }
    case 'on_finished':
      return {
        state: {
          ...input.state,
          busy: false,
          nextAllowedAt: gate.rdGateOnFinished(input.state.nextAllowedAt, input.state.gapMs, input.now),
        },
      };
    case 'admit':
      return gate.rdGateApplyAdmit(input.state, {
        enabled: input.enabled,
        priority: input.priority,
        now: input.now,
        playMaxWaitMs: input.playMaxWaitMs,
      });
    case 'next_grant':
      return gate.rdGateNextGrant(input.state, input.now, input.enabled);
    default:
      throw new Error(`op de gate desconhecida: ${entry.op}`);
  }
}

function withExpect(entry, expect) {
  return { id: entry.id, op: entry.op, input: entry.input, expect };
}

const golden = {
  generatedBy: 'scripts/rust/debrid-golden/rd-decision.mjs',
  ledger: cases.ledger.map((entry) => withExpect(entry, runLedger(entry))),
  gate: cases.gate.map((entry) => withExpect(entry, runGate(entry))),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(golden, null, 2)}\n`);
const total = golden.ledger.length + golden.gate.length;
console.log(`rd-decision: ${golden.ledger.length} ledger + ${golden.gate.length} gate = ${total} casos → ${path.relative(ROOT, OUT)}`);
