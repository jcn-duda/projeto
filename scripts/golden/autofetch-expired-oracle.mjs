#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-expired`: decisão pura da guarda de posse.
 *
 * O TS `expiredRemovalAllowed` tem deps de IO (cache, held, inventory); o
 * oráculo implementa a MESMA lógica de decisão com os fatos do corpus.
 * Saída: "1" (remove) ou "0" (represa).
 */
import fs from 'node:fs';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

/** Réplica pura da lógica do TS (5 guardas sequenciais). */
function expiredRemovalAllowed(f) {
  if (f.hashEmpty) return false;
  if (f.isCleanupProtected) return false;
  if (!f.adapterIsAlldebrid) return true;
  if (!f.hasMarker && !f.hasAdsub) return false;
  if (!f.hasSnapshot) return false;
  return !f.inSnapshot;
}

const cases = job.cases.map((c) => {
  const facts = JSON.parse(c.input);
  const out = expiredRemovalAllowed(facts) ? '1' : '0';
  return { id: c.id, out };
});

fs.writeFileSync(process.argv[3], JSON.stringify({ ok: true, meta: null, cases }));
