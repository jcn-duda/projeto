#!/usr/bin/env node
/**
 * Travamento FAIL-CLOSED de cobertura do corpus do golden `crawl-policy`.
 * Exclusivo de `dump-crawl-policy.mjs`. A pertinência (`op ∈ OPS`) é forma; aqui
 * se exige PRESENÇA: cada op tem piso explícito de casos e um corpus que perde
 * todos os casos de uma op reprova ANTES de medir/escrever (vale em `--check` e
 * em `--force`). Reduzir um piso é decisão consciente (atualize o número).
 *
 * Pisos vigentes (146 casos): freshCycle 1, clamp 44, siteConfigOf 13,
 * knownSites 2, cadenceDelayMs 2, withCadenceDelay 1, seriesLimits 1,
 * neutralProbe 1, legacyView 3, isSiteLevelError 15, maxLastmod 7,
 * observePages 6, observeSite 2, hourCounter 5, costMeter 3, dueClass 7,
 * hasDuePage 3, assessSites 10, selectNext 6, pickBatch 5, byFairness 2,
 * skipReasonFor 4, applySkipReasons 1, isOwnPace 2.
 */

export const OPS = [
  'freshCycle', 'clamp', 'siteConfigOf', 'knownSites', 'cadenceDelayMs', 'withCadenceDelay',
  'seriesLimits', 'neutralProbe', 'legacyView', 'isSiteLevelError', 'maxLastmod', 'observePages',
  'observeSite', 'hourCounter', 'costMeter', 'dueClass', 'hasDuePage', 'assessSites', 'selectNext',
  'pickBatch', 'byFairness', 'skipReasonFor', 'applySkipReasons', 'isOwnPace',
];

export const OP_MIN_CASES = {
  freshCycle: 1,
  clamp: 44,
  siteConfigOf: 13,
  knownSites: 2,
  cadenceDelayMs: 2,
  withCadenceDelay: 1,
  seriesLimits: 1,
  neutralProbe: 1,
  legacyView: 3,
  isSiteLevelError: 15,
  maxLastmod: 7,
  observePages: 6,
  observeSite: 2,
  hourCounter: 5,
  costMeter: 3,
  dueClass: 7,
  hasDuePage: 3,
  assessSites: 10,
  selectNext: 6,
  pickBatch: 5,
  byFairness: 2,
  skipReasonFor: 4,
  applySkipReasons: 1,
  isOwnPace: 2,
};

/** Violações de cobertura (vazio = ok). Ignora forma (o dump valida antes). */
export function opCoverageViolations(cases) {
  const counts = new Map(OPS.map((op) => [op, 0]));
  for (const c of cases) {
    let op;
    try { op = JSON.parse(c?.input)?.op; } catch { continue; }
    if (counts.has(op)) counts.set(op, counts.get(op) + 1);
    else if (typeof op === 'string') counts.set(op, (counts.get(op) ?? 0) + 1);
  }
  const violations = [];
  for (const op of OPS) {
    const min = OP_MIN_CASES[op];
    if (typeof min !== 'number') { violations.push(`op ${op} sem piso explícito`); continue; }
    const got = counts.get(op) ?? 0;
    if (got < min) violations.push(`op ${op}: ${got} caso(s) < piso ${min}`);
  }
  for (const op of Object.keys(OP_MIN_CASES)) {
    if (!OPS.includes(op)) violations.push(`piso definido para op ausente de OPS: ${op}`);
  }
  for (const op of counts.keys()) {
    if (!OPS.includes(op) && counts.get(op) > 0) violations.push(`op desconhecida no corpus: ${op}`);
  }
  return violations;
}
