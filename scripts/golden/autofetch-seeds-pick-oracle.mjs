#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-seeds-pick`: mede a saída REAL do
 * `pickSeedsPool` no dist. O `viable` é construído a partir do array de
 * hashes viáveis do corpus (HYB: fatos injetados).
 *
 * Saída: JSON stringificado `{candidates:[hashes],immediateLimit,rareUsed}`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
if (typeof mod.pickSeedsPool !== 'function') throw new Error('pickSeedsPool não exportado');

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  const viableSet = new Set((req.viable ?? []).map((h) => String(h).toLowerCase()));
  const viable = (s) => viableSet.has(String(s.infoHash || '').toLowerCase());
  const result = mod.pickSeedsPool(
    req.streams ?? [],
    {
      autoFetchMinSeeders: req.live.minSeeders,
      autoFetchTopSeedsMax: req.live.topSeedsMax,
      autoFetchSeedsPtFirst: req.live.ptFirst,
    },
    {
      season: req.opts.season ?? null,
      queueDepth: req.opts.queueDepth ?? 0,
      viable,
      rare: req.opts.rare ?? { max: 0, threshold: 0, maxSeeders: 0 },
    },
  );
  const out = JSON.stringify({
    candidates: result.candidates.map((s) => String(s.infoHash || '').toLowerCase()),
    immediateLimit: result.immediateLimit,
    rareUsed: result.rareUsed,
  });
  return { id: c.id, out };
});

fs.writeFileSync(process.argv[3], JSON.stringify({ ok: true, meta: null, cases }));
