#!/usr/bin/env node
/**
 * Travamento FAIL-CLOSED de cobertura do corpus do golden `crawl-store-rules`
 * (exclusivo de `dump-crawl-store-rules.mjs`; não é compartilhado por outros
 * goldens). O dump já garantia a PERTINÊNCIA de cada `op` (`op ∈ OPS`), mas não
 * a PRESENÇA: um corpus que perdia TODOS os casos de uma função continuava
 * "válido". Aqui cada op tem piso explícito de casos; op ausente ou abaixo do
 * piso derruba a geração ANTES de medir/escrever — vale igual para `--check` e
 * para `--force`.
 *
 * Distribuição vigente (169 casos), na ordem de OPS:
 * 18 / 29 / 18 / 15 / 10 / 15 / 31 / 7 / 14 / 11 / 1. O piso de cada op é essa
 * contagem. Reduzir um piso é decisão consciente (atualize número e comentário);
 * derivar o piso do próprio corpus tornaria qualquer redução silenciosa.
 */

// Ordem canônica das 11 funções cobertas; também é a ordem de OPS do dump.
export const OPS = [
  'backoff', 'parseProgress', 'renderProgress', 'progressAdvanced', 'withDryFlag',
  'decideUpsert', 'applyResult', 'renderUrl', 'parseStatus', 'parseUrlRow', 'emptyCounters',
];

// Piso explícito por op (fail-closed): o total por op não pode cair abaixo disto.
export const OP_MIN_CASES = {
  backoff: 18,
  parseProgress: 29,
  renderProgress: 18,
  progressAdvanced: 15,
  withDryFlag: 10,
  decideUpsert: 15,
  applyResult: 31,
  renderUrl: 7,
  parseStatus: 14,
  parseUrlRow: 11,
  emptyCounters: 1,
};

/**
 * Conta os casos por op e devolve as violações de cobertura (vazio = ok).
 * Casos com `input` não-JSON ou op desconhecida são ignorados aqui: essa é a
 * validação de FORMA do dump, que roda antes. Aqui só se exige que toda op
 * canônica atinja seu piso.
 */
export function opCoverageViolations(cases) {
  const counts = new Map(OPS.map((op) => [op, 0]));
  for (const c of cases) {
    let op;
    try { op = JSON.parse(c?.input)?.op; } catch { continue; }
    if (counts.has(op)) counts.set(op, counts.get(op) + 1);
  }
  const violations = [];
  for (const op of OPS) {
    const min = OP_MIN_CASES[op];
    if (typeof min !== 'number') { violations.push(`op ${op} sem piso explícito`); continue; }
    const got = counts.get(op) ?? 0;
    if (got < min) violations.push(`op ${op}: ${got} caso(s) < piso ${min}`);
  }
  // Fail-closed no eixo oposto: piso órfão (op fora de OPS) é erro de edição.
  for (const op of Object.keys(OP_MIN_CASES)) {
    if (!OPS.includes(op)) violations.push(`piso definido para op ausente de OPS: ${op}`);
  }
  return violations;
}
