#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-obra`: mede a saída REAL do `dist`.
 * Roda em processo filho isolado (sem rede, sem config real).
 *
 * `input` de cada caso é JSON com `op` + campos do ObraIdentityInput; a saída
 * é SEMPRE string:
 * - `obraIdentity` → identidade canônica da obra
 * - `obraKey`      → chave de cache completa (prefixo + sha256)
 * - `obraDigest`   → sha256 hex completo da identidade
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
for (const name of ['obraIdentity', 'obraKey', 'obraDigest']) {
  if (typeof mod[name] !== 'function') throw new Error(`autofetch-obra não exporta ${name}`);
}

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  const input = {
    adapterId: req.adapterId ?? '',
    account: req.account ?? '',
    type: req.type ?? null,
    imdbId: req.imdbId ?? null,
    season: req.season ?? null,
    episode: req.episode ?? null,
    isPack: req.isPack ?? false,
    searchKey: req.searchKey ?? null,
  };
  let out;
  switch (req.op) {
    case 'obraIdentity':
      out = mod.obraIdentity(input);
      break;
    case 'obraKey':
      out = mod.obraKey(input);
      break;
    case 'obraDigest':
      out = mod.obraDigest(input);
      break;
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

fs.writeFileSync(process.argv[3], JSON.stringify({ ok: true, meta: null, cases }));
