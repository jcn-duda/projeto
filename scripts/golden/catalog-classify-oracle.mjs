#!/usr/bin/env node
/**
 * Oráculo do golden de `src/utils/catalog-classify.ts`: `foreignProofLabel`,
 * `classifyByTitle` e `classifyWithEvidence`.
 *
 * Mede a saída REAL do `dist` — nunca uma reimplementação do TS. Roda no
 * staging descartável montado por `dump-catalog-classify.mjs` (CWD no staging,
 * env mínima, sem .env/data, `RUST_CORE=off`): lê o `job.json` (artefato
 * absoluto + casos), importa o artefato por caminho absoluto e devolve
 * `{ok:true, cases:[{id,out}]}` no stdout. As listas calibradas
 * (`ptMarkers`/`enGroups`) entram pelo ambiente (`AUDIO_AUDIT_*`), definido pelo
 * gerador a partir do corpus — o oráculo não as repete. Essas funções chamam
 * `audio-quality.ts` (foreignVerdict/audioBucket) por dentro.
 *
 * `input` de cada caso é um JSON com `op`:
 * - `label`    + `candidates`           → `cena`|`audio`|`sim`
 * - `title`    + `filename`             → `bucket|audio|foreignProof|ptProof`
 * - `evidence` + `filename`+`evidence`? → `bucket|audio|foreignProof|ptProof`
 *
 * O `Proof` é serializado como `bucket|audio|foreignProof|ptProof` (os valores
 * vêm de conjuntos fechados dos rótulos e nunca contêm `|`). `evidence` ausente
 * ou `null` vira `undefined` (o TS trata `''`/ausente como sem evidência).
 *
 * `fetch` é armado para explodir: o grafo é puro e não toca a rede.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };
const mod = await import(pathToFileURL(path.resolve(job.artifact)).href);

const encodeProof = (p) => `${p.bucket}|${p.audio}|${p.foreignProof}|${p.ptProof}`;

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  if (req.op === 'label') out = mod.foreignProofLabel(req.candidates);
  else if (req.op === 'title') out = encodeProof(mod.classifyByTitle(req.filename));
  else if (req.op === 'evidence') {
    // Ausência/null de evidência = caminho sem arquivos reais (paths vazio).
    const evidence = req.evidence === undefined || req.evidence === null ? undefined : req.evidence;
    out = encodeProof(mod.classifyWithEvidence(req.filename, evidence));
  } else throw new Error(`op desconhecida: ${req.op}`);
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});
process.stdout.write(JSON.stringify({ ok: true, cases }));
