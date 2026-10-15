#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-fallback`: mede a saída REAL do dist para
 * `composeQueueEntries` e `toQueueCandidate`.
 *
 * Saída: JSON stringificado do resultado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
for (const name of ['composeQueueEntries', 'toQueueCandidate']) {
  if (typeof mod[name] !== 'function') throw new Error(`autofetch-fallback não exporta ${name}`);
}

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  switch (req.op) {
    case 'composeQueueEntries': {
      // O TS recebe QueueEntry[] e FallbackPick[]; simplificamos para o golden:
      // primary = [{stream:{infoHash}, pool}], fallbacks = [{stream:{infoHash}, pool}]
      const primary = (req.primary ?? []).map((e) => ({ stream: { infoHash: e.infoHash }, pool: e.pool }));
      const fallbacks = (req.fallbacks ?? []).map((e) => ({ stream: { infoHash: e.infoHash }, pool: e.pool }));
      const result = mod.composeQueueEntries(primary, fallbacks, req.depth ?? 0);
      out = JSON.stringify(result.map((r) => ({ infoHash: String(r.stream?.infoHash || r.infoHash || '').toLowerCase(), pool: r.pool })));
      break;
    }
    case 'toQueueCandidate': {
      const stream = req.stream ?? {};
      const opts = req.opts ?? {};
      const result = mod.toQueueCandidate(stream, req.pool ?? 'seeds', {
        imdbId: opts.imdbId ?? undefined,
        season: opts.season ?? null,
        episode: opts.episode ?? null,
        seasonFill: opts.seasonFill ?? false,
        rare: opts.rare ?? false,
        slotLimit: opts.slotLimit ?? undefined,
      });
      out = JSON.stringify({
        infoHash: result.infoHash,
        pool: result.pool,
        quality: result.quality ?? null,
        seeders: result.seeders ?? null,
        br: !!result.br,
        dubbed: !!result.dubbed,
        bankDub: !!result.bankDub,
        lied: !!result.lied,
        season: result.season ?? null,
        episode: result.episode ?? null,
        isPack: !!result.isPack,
        rare: !!result.rare,
        slotLimit: result.slotLimit ?? null,
      });
      break;
    }
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

fs.writeFileSync(process.argv[3], JSON.stringify({ ok: true, meta: null, cases }));
