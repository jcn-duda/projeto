#!/usr/bin/env node
/**
 * Oráculo do golden `episode-annotate`: mede os NÚCLEOS puros de
 * `src/providers/episode-size.ts` no dist vivo, caso a caso. Roda em processo
 * filho isolado (sem rede, sem config real); o memo `fsz`/`tsz` é populado por
 * caso com `recordFileSizes`/`recordTorrentTotal` — o IO fica no oráculo, a
 * decisão medida é a das funções.
 *
 * Saída SEMPRE string:
 * - `covered` → contagem de episódios ("96", "0" quando não há média honesta)
 * - `exact`   → bytes do episódio ("0" quando o seletor não decide)
 * - `pack`/`movie`/`fill`/`totals` → JSON canônico (chaves ordenadas) da
 *   projeção dos streams: `_indexer`, `_multiWork`, `_multiWorkAdmitted`,
 *   `_packBytes`, `_size`, `name`, `title` — só chaves presentes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(
  pathToFileURL(path.resolve(job.repo, job.artifact ?? 'dist/src/providers/episode-size.js')).href
);
const sizes = await import(
  pathToFileURL(path.resolve(job.repo, 'dist/src/debrid/file-sizes.js')).href
);

// JSON canônico: chaves ordenadas recursivamente, números do JSON.stringify —
// o mesmo contrato do lado Rust do golden.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const project = (streams) => canon(streams.map((s) => ({
  _indexer: s._indexer,
  _multiWork: s._multiWork,
  _multiWorkAdmitted: s._multiWorkAdmitted,
  _packBytes: s._packBytes,
  _size: s._size,
  name: s.name,
  title: s.title,
})));

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  sizes.clearFileSizes();
  if (req.op === 'exact') {
    // `exact` mede um hash só: `files` é a lista dele, não um mapa por hash.
    sizes.recordFileSizes(req.infoHash, req.files);
  }
  for (const [hash, files] of Object.entries(req.files ?? {})) {
    if (Array.isArray(files)) sizes.recordFileSizes(hash, files);
  }
  for (const [hash, bytes] of Object.entries(req.totals ?? {})) {
    sizes.recordTorrentTotal(hash, bytes);
  }
  const meta = req.meta ? { episodes: req.meta } : null;
  const work = req.work ? { n: req.work.n ?? [], y: req.work.y ?? null } : null;
  let out;
  switch (req.op) {
    case 'covered':
      out = String(mod.episodesCovered(req.title, req.season, meta));
      break;
    case 'exact':
      out = String(mod.exactEpisodeBytes(req.infoHash, req.season, req.episode));
      break;
    case 'pack':
      out = project(mod.annotatePackSizes(req.streams, {
        season: req.season, episode: req.episode, meta,
      }));
      break;
    case 'movie':
      out = project(mod.annotateMovieSizes(req.streams, work, null));
      break;
    case 'fill':
      out = project(mod.fillMissingSizes(req.streams, {
        season: req.season ?? null, episode: req.episode ?? null, work,
      }));
      break;
    case 'totals':
      out = project(mod.fillTorrentTotals(req.streams, null));
      break;
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  sizes.clearFileSizes();
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

const outPath = process.argv[3];
fs.writeFileSync(outPath, JSON.stringify({ ok: true, meta: null, cases }));
