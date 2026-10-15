#!/usr/bin/env node
/**
 * Oráculo do golden `pack-text-totals`: mede a saída REAL do `dist` para cada
 * caso do corpus. Roda em processo filho isolado (sem rede, sem config real —
 * o dotenv vazio e `RUST_CORE=off` vêm do gerador).
 *
 * `input` de cada caso é JSON com `op`; a saída é SEMPRE string:
 * - `namesMultipleEpisodes` → "true"/"false"
 * - `looksPackByFiles`      → "true"/"false" (grava os arquivos do caso com o
 *   `recordFileSizes` REAL antes: a caixa do Node filtra tamanho 0, não-vídeo,
 *   sample e propaganda, e baixa o hash)
 * - `dropPackTextTotals`    → JSON canônico (chaves ordenadas) de
 *   `{ streams, packTextDropped }`, onde `packTextDropped` é o estágio
 *   `episodeSize.packTextDropped` de um trace REAL.
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

const record = (entries) => {
  sizes.clearFileSizes();
  for (const { hash, files } of entries ?? []) sizes.recordFileSizes(hash, files);
};

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  switch (req.op) {
    case 'namesMultipleEpisodes':
      out = String(mod.namesMultipleEpisodes(req.title));
      break;
    case 'looksPackByFiles':
      record([{ hash: req.hash, files: req.files }]);
      out = String(mod.looksPackByFiles(req.hash));
      break;
    case 'dropPackTextTotals': {
      record(req.files);
      const trace = traceMod.createStreamTrace();
      const streams = mod.dropPackTextTotals(req.streams ?? [], {
        season: req.season ?? null,
        episode: req.episode ?? null,
        trace,
      });
      out = JSON.stringify(canon({
        streams,
        packTextDropped: trace.stages['episodeSize.packTextDropped'] || 0,
      }));
      break;
    }
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

const outPath = process.argv[3];
fs.writeFileSync(outPath, JSON.stringify({ ok: true, meta: null, cases }));
