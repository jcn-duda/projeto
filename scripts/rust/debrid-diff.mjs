#!/usr/bin/env node
/**
 * Harness de diferença do debrid: saída e sequência HTTP (método, rota, corpo).
 *
 * Fase D0 entrega o comparador. Os adaptadores Rust ainda não existem, então
 * `--service` recusa em vez de fingir paridade. Cada serviço portado (D1 em
 * diante) passa a correr os dois lados contra o servidor falso.
 *
 *   node scripts/rust/debrid-diff.mjs --self-test
 *   node scripts/rust/debrid-diff.mjs --service=premiumize
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    service: { type: 'string' },
    'self-test': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const PORTED = new Set();

if (values.help) {
  console.log(`Uso:
  node scripts/rust/debrid-diff.mjs --self-test
  node scripts/rust/debrid-diff.mjs --service=<premiumize|debridlink|torbox|realdebrid|alldebrid>`);
  process.exit(0);
}

export function stable(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

/** Compara a sequência de chamadas. Corpo entra na igualdade: escrita igual é o critério. */
export function diffCalls(left, right) {
  const diffs = [];
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) {
      diffs.push({ i, reason: 'tamanho' });
      continue;
    }
    if (a.method !== b.method || a.path !== b.path || stable(a.body) !== stable(b.body)) {
      diffs.push({ i, reason: 'chamada', left: a, right: b });
    }
  }
  return diffs;
}

function selfTest() {
  const same = diffCalls(
    [{ method: 'POST', path: '/magnet/upload', body: { magnets: ['aa'] } }],
    [{ method: 'POST', path: '/magnet/upload', body: { magnets: ['aa'] } }],
  );
  if (same.length !== 0) {
    console.error('[debrid-diff] comparador aceitou diferença inexistente');
    process.exit(1);
  }
  const changed = diffCalls(
    [{ method: 'POST', path: '/magnet/upload', body: { magnets: ['aa'] } }],
    [{ method: 'POST', path: '/magnet/upload', body: { magnets: ['bb'] } }],
  );
  if (changed.length !== 1) {
    console.error('[debrid-diff] comparador não viu corpo diferente');
    process.exit(1);
  }
  console.log('rust.debrid.diff.self_test=0');
}

if (values['self-test']) {
  selfTest();
  process.exit(0);
}

const service = values.service;
if (!service) {
  console.error('[debrid-diff] use --self-test ou --service=<id>');
  process.exit(2);
}
if (!PORTED.has(service)) {
  console.error(`[debrid-diff] ${service}: adaptador Rust ainda não portado; sem medição de paridade`);
  process.exit(2);
}
