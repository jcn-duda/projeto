// Oráculo do seletor de arquivo: lê os INPUTS estáticos, chama o TS do dist/
// e grava o golden que o teste Rust compara. Não lê .env e não chama rede.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distImport } from '../resolver-golden/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CASES = path.join(ROOT, 'test/fixtures/debrid/file-select/cases.json');
const OUT = path.join(ROOT, 'rust/crates/adom-core/tests/golden/file_select.json');

const {
  pickFile, pickWorkFile, workCoverage, looksMultiWorkFiles, isSiteAd, baseName,
} = await distImport('src/debrid/file-selector.js');

function evidenceOf(raw) {
  if (raw == null) return null;
  const out = {
    wantedSeason: raw.wantedSeason,
    wantedEpisode: raw.wantedEpisode,
    declaredSeasons: raw.declaredSeasons,
    declaredEpisodes: raw.declaredEpisodes,
  };
  if (raw.sample !== undefined) out.sample = raw.sample;
  return out;
}

function callOf(fn) {
  try {
    const file = fn();
    if (file == null) return { kind: 'null' };
    return { kind: 'file', path: String(file.path || ''), size: Number(file.size || 0) };
  } catch (err) {
    return {
      kind: 'error',
      code: err.code,
      evidence: evidenceOf(err.evidence),
      context: err.context === undefined ? null : err.context,
    };
  }
}

function run(entry) {
  if (entry.op === 'pickFile') return callOf(() => pickFile(entry.files, entry.hint || {}));
  if (entry.op === 'pickWorkFile') return callOf(() => pickWorkFile(entry.files, { names: entry.names, year: entry.year }));
  if (entry.op === 'workCoverage') return { kind: 'number', value: workCoverage(entry.fileName, entry.name) };
  if (entry.op === 'looksMultiWorkFiles') return { kind: 'bool', value: looksMultiWorkFiles(entry.files) };
  if (entry.op === 'isSiteAd') return { kind: 'bool', value: isSiteAd(entry.path) };
  if (entry.op === 'baseName') return { kind: 'string', value: baseName(entry.path) };
  throw new Error(`op desconhecida: ${entry.op}`);
}

const fixture = JSON.parse(fs.readFileSync(CASES, 'utf8'));
const cases = fixture.cases.map((entry) => ({ ...entry, out: run(entry) }));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify({ cases }, null, 2)}\n`);
console.log(`file-select golden: ${cases.length} casos`);
