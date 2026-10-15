#!/usr/bin/env node
/**
 * Oráculo do golden `duplicate-pack`: mede a saída REAL do `dist` para cada
 * caso do corpus. Roda em processo filho isolado (sem rede, sem config real —
 * o dotenv vazio e `RUST_CORE=off` vêm do gerador).
 *
 * O input de cada caso é `{ season, episode, work, cached, files, streams }`;
 * os arquivos são gravados com o `recordFileSizes` REAL (a caixa do Node
 * filtra tamanho 0, não-vídeo, sample e propaganda, e baixa o hash) e a saída
 * é SEMPRE string: JSON canônico (chaves ordenadas) de `{ streams, drops }`,
 * onde `drops` é o que `dropDuplicatePackFiles` registrou no trace real
 * (`trace.items` sem o `id` posicional).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
const sizes = await import(pathToFileURL(path.resolve(job.repo, job.fileSizesArtifact)).href);
const traceMod = await import(pathToFileURL(path.resolve(job.repo, job.traceArtifact)).href);

const canon = (v) => Array.isArray(v)
  ? v.map(canon)
  : (v && typeof v === 'object')
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v;

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  sizes.clearFileSizes();
  for (const { hash, files } of req.files ?? []) sizes.recordFileSizes(hash, files);
  const trace = traceMod.createStreamTrace();
  const streams = mod.dropDuplicatePackFiles(req.streams ?? [], {
    season: req.season ?? null,
    episode: req.episode ?? null,
    work: req.work ?? null,
    cached: new Set(req.cached ?? []),
    trace,
  });
  const drops = (trace.items ?? []).map(({ id, ...rest }) => rest);
  return { id: c.id, out: JSON.stringify(canon({ streams, drops })) };
});

const outPath = process.argv[3];
fs.writeFileSync(outPath, JSON.stringify({ ok: true, meta: null, cases }));
