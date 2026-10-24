#!/usr/bin/env node
/**
 * Oráculo do golden `pre-resolve` (G4) — o TS do branch `esm`, nunca uma
 * reimplementação do Rust.
 *
 * Roda no child isolado de `golden-kit.mjs` (CWD no repo, dotenv vazio,
 * `RUST_CORE=off`, `CACHE_PERSIST=false`, env mínima) e mede:
 *
 * - `score`: a função REAL `resolveCandidateScore` exportada por
 *   `dist/src/providers/jackett-resolve.js` (mesma chamada do laço TS:
 *   `resolveCandidateScore({title}, {season, episode})`);
 * - `rank`: a ORDEM do laço TS (`.sort((a,b) => b.score - a.score || a.order -
 *   b.order)`), aplicada sobre os scores reais;
 * - `season`: a regex de temporada do título do laço TS
 *   (`/(?:\bS(\d{1,2})\b|(\d{1,2})\s*[ªº]\s*Temporada)/i`). Ela é INLINE no
 *   `resolveCardigannDownloads`, dentro de um `.filter` assíncrono que fala
 *   rede — por isso o oráculo NÃO chama a função: ele exige que o literal
 *   exato exista no `src/providers/jackett-resolve.ts` do esm e constrói a
 *   RegExp a partir DELE. Se o TS mudar a regex, o oráculo falha alto — o
 *   golden nunca mede uma cópia desatualizada.
 *
 * Saída: UMA linha JSON `{ok, cases:[{id, out}]}` com `out` STRING (o
 * `JSON.stringify` do valor), contrato do `renderJsonl` do kit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => {
  process.stderr.write(`[golden-oracle] FALHA: ${msg}\n`);
  process.exit(1);
};

const [jobPath, outPath] = process.argv.slice(2);
if (!jobPath || !outPath) fail('uso: pre-resolve-oracle.mjs <job.json> <out.json>');
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
globalThis.fetch = () => {
  throw new Error('rede desabilitada no oráculo');
};

const REPO = job.repo;
const artifact = path.join(REPO, 'dist', 'src', 'providers', 'jackett-resolve.js');
const mod = await import(pathToFileURL(artifact).href).catch((e) =>
  fail(`import do oráculo falhou: ${e.message}`),
);
if (typeof mod.resolveCandidateScore !== 'function') {
  fail('o dist não exporta resolveCandidateScore');
}

// Corpo da regex de temporada do laço TS, e a prova de que ele é o do esm.
const SEASON_RE_BODY = '(?:\\bS(\\d{1,2})\\b|(\\d{1,2})\\s*[ªº]\\s*Temporada)';
const SEASON_RE_LITERAL = `/${SEASON_RE_BODY}/i`;
const jackettSrc = path.join(REPO, 'src', 'providers', 'jackett-resolve.ts');
const jackettText = fs.readFileSync(jackettSrc, 'utf8');
if (!jackettText.includes(`.match(${SEASON_RE_LITERAL})`)) {
  fail('a regex de temporada mudou no src/providers/jackett-resolve.ts do esm; revise o corpus e regenere');
}
const seasonRe = new RegExp(SEASON_RE_BODY, 'i');

/** `Number(titleSeason[1] || titleSeason[2])`, como no TS. */
function markerOf(title) {
  const m = String(title || '').match(seasonRe);
  return m ? Number(m[1] || m[2]) : null;
}

function render(req) {
  if (req.op === 'score') {
    return JSON.stringify(
      mod.resolveCandidateScore({ title: req.title }, { season: req.season ?? null, episode: req.episode ?? null }),
    );
  }
  if (req.op === 'rank') {
    const scored = req.titles.map((title, order) => ({
      order,
      score: mod.resolveCandidateScore({ title }, { season: null, episode: null }),
    }));
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return JSON.stringify(scored.map((s) => s.order));
  }
  if (req.op === 'season') {
    const marker = markerOf(req.title);
    // `!titleSeason || Number(...) === Number(requested)` do laço TS.
    const keep = marker === null || marker === Number(req.requested);
    return JSON.stringify({ marker, keep });
  }
  throw new Error(`op desconhecida: ${req.op}`);
}

const cases = job.cases.map((c) => {
  let out;
  try {
    out = render(JSON.parse(c.input));
  } catch (e) {
    fail(`oráculo lançou no caso ${c.id}: ${e.message}`);
  }
  return { id: c.id, out };
});
fs.writeFileSync(outPath, JSON.stringify({ ok: true, cases }));
