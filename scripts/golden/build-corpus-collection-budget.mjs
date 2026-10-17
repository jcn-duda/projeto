#!/usr/bin/env node
/**
 * Construtor do corpus do golden `collection-budget` (orçamento da coleta).
 *
 * Cada `input` é uma STRING JSON: `{op, deadlineAt, now, config:{...}}`, com
 * `op` ∈ `budget` | `grace`. O oráculo é o TS do branch `esm`
 * (`dist/src/providers/collection-budget.js`): ele APLICA `config.*` com os
 * valores declarados aqui antes de chamar a função real — são os mesmos números
 * que o teste Rust passa por parâmetro. Assim o golden cobre vários combos de
 * config, não só o default.
 *
 * Bordas cobertas: piso 1000 (sem deadline) e 500 (com deadline), reserva zero,
 * reserva maior que o prazo, prazo vencido e graça sem janela (reserva ≤ piso).
 *
 * Uso: node scripts/golden/build-corpus-collection-budget.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts', 'golden', 'corpus-collection-budget.json');

const cases = [];
const add = (id, req) => {
  cases.push({ id, input: JSON.stringify(req) });
};

const DEFAULTS = {
  replyDeadline: 9200,
  debridReserve: 4500,
  brPartialGrace: 1500,
  debridCheckFloor: 1500,
};
const cfg = (over = {}) => ({ ...DEFAULTS, ...over });

// --- computeCollectionBudget (sem deadline: piso 1000) ---------------------
add('budget-sem-deadline-default', { op: 'budget', deadlineAt: null, now: 0, config: cfg() });
add('budget-sem-deadline-piso-1000', {
  op: 'budget', deadlineAt: null, now: 0, config: cfg({ replyDeadline: 3000 }),
});
add('budget-sem-deadline-piso-exato', {
  op: 'budget', deadlineAt: null, now: 0, config: cfg({ replyDeadline: 5500 }),
});
add('budget-sem-deadline-um-acima-do-piso', {
  op: 'budget', deadlineAt: null, now: 0, config: cfg({ replyDeadline: 5501 }),
});
add('budget-sem-deadline-reserva-zero', {
  op: 'budget', deadlineAt: null, now: 0, config: cfg({ debridReserve: 0 }),
});
add('budget-sem-deadline-reserva-maior-que-reply', {
  op: 'budget', deadlineAt: null, now: 0, config: cfg({ debridReserve: 9000 }),
});
add('budget-sem-deadline-zero-zero', {
  op: 'budget', deadlineAt: null, now: 0, config: cfg({ replyDeadline: 0, debridReserve: 0 }),
});
add('budget-sem-deadline-reply-grande', {
  op: 'budget', deadlineAt: null, now: 0, config: cfg({ replyDeadline: 60000 }),
});

// --- computeCollectionBudget (com deadline: piso 500) ----------------------
add('budget-deadline-folga', {
  op: 'budget', deadlineAt: 20000, now: 1000, config: cfg(),
});
add('budget-deadline-no-limite-do-piso', {
  op: 'budget', deadlineAt: 6000, now: 1000, config: cfg(),
});
add('budget-deadline-negativo-vira-piso', {
  op: 'budget', deadlineAt: 5000, now: 1000, config: cfg(),
});
add('budget-deadline-vencido', {
  op: 'budget', deadlineAt: 1000, now: 2000, config: cfg(),
});
add('budget-deadline-igual-now', {
  op: 'budget', deadlineAt: 2000, now: 2000, config: cfg(),
});
add('budget-deadline-um-ms-acima-do-piso', {
  op: 'budget', deadlineAt: 6001, now: 1000, config: cfg(),
});
add('budget-deadline-reserva-zero', {
  op: 'budget', deadlineAt: 10000, now: 1000, config: cfg({ debridReserve: 0 }),
});
add('budget-deadline-reserva-config-diferente', {
  op: 'budget',
  deadlineAt: 30000,
  now: 5000,
  config: cfg({ replyDeadline: 15000, debridReserve: 8000 }),
});
add('budget-deadline-relogio-real', {
  op: 'budget', deadlineAt: 1_700_000_005_000, now: 1_700_000_000_000, config: cfg(),
});
add('budget-deadline-relogio-real-folga', {
  op: 'budget', deadlineAt: 1_700_000_100_000, now: 1_700_000_000_000, config: cfg(),
});
add('budget-deadline-reserva-gigante', {
  op: 'budget', deadlineAt: 10000, now: 1000, config: cfg({ debridReserve: 999999 }),
});
add('budget-deadline-zero', { op: 'budget', deadlineAt: 0, now: 0, config: cfg() });

// --- computePriorityGrace --------------------------------------------------
add('grace-default', { op: 'grace', config: cfg() });
add('grace-reserva-menor-que-piso', {
  op: 'grace', config: cfg({ debridReserve: 1000 }),
});
add('grace-reserva-igual-piso', {
  op: 'grace', config: cfg({ debridReserve: 1500 }),
});
add('grace-janela-de-100', { op: 'grace', config: cfg({ debridReserve: 1600 }) });
add('grace-piso-zero', { op: 'grace', config: cfg({ debridCheckFloor: 0 }) });
add('grace-parcial-menor', { op: 'grace', config: cfg({ brPartialGrace: 200 }) });
add('grace-parcial-zero', { op: 'grace', config: cfg({ brPartialGrace: 0 }) });
add('grace-tudo-zero', {
  op: 'grace',
  config: cfg({ brPartialGrace: 0, debridReserve: 0, debridCheckFloor: 0 }),
});
add('grace-janela-maior-que-parcial', {
  op: 'grace', config: cfg({ brPartialGrace: 500, debridReserve: 9000 }),
});
add('grace-parcial-negativa-sem-clamp', {
  op: 'grace', config: cfg({ brPartialGrace: -500 }),
});
add('grace-piso-maior-que-reserva', {
  op: 'grace', config: cfg({ debridReserve: 1000, debridCheckFloor: 3000 }),
});

const doc = {
  _doc:
    'Corpus do golden `collection-budget` (F-1). Cada input é uma STRING JSON: '
    + '{op: "budget"|"grace", deadlineAt, now, config:{replyDeadline, '
    + 'debridReserve, brPartialGrace, debridCheckFloor}}. O oráculo aplica o '
    + '`config` declarado no config real do TS do branch `esm` e mede a função '
    + 'original; o teste Rust passa os MESMOS números por parâmetro.',
  cases,
};
fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`[corpus] ${path.relative(REPO, OUT)}: ${cases.length} casos`);
