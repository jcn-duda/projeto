#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-marker`: mede a saída REAL do `dist`.
 * Roda em processo filho isolado (sem rede, sem config real, sem persistência).
 *
 * `input` de cada caso é JSON com `op`; a saída é SEMPRE string:
 * - `markerKey`         → a chave `autofetch:v3:m:<adapter>:<conta>:<hash>`
 * - `markerValue`       → `JSON.stringify` do valor gravado (paridade byte a byte)
 * - `markerTransferId`  → id da transferência lido do marker, ou "null"
 * - `markerObra`        → digest da obra lido do marker, ou "null"
 *
 * `markerTransferId`/`markerObra` no fonte LÊEM do cache. Para medir a parte
 * pura (a interpretação do valor) sem depender de estado externo, o oráculo
 * SEMEIA o cache com o `value` do caso sob identificadores fixos e então chama
 * o leitor — o que importa é o valor, não a chave.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
const cache = await import(pathToFileURL(path.resolve(job.repo, job.cacheArtifact)).href);
for (const name of ['markerKey', 'markerValue', 'markerTransferId', 'markerObra']) {
  if (typeof mod[name] !== 'function') throw new Error(`autofetch-marker não exporta ${name}`);
}

// Identificadores fixos do seed: a chave é determinística, o valor é o que varia.
const SEED_ADAPTER = 'seedadapter';
const SEED_ACCOUNT = 'seedaccount';
const SEED_HASH = '0000000000000000000000000000000000000000';
const SEED_KEY = mod.markerKey(SEED_ADAPTER, SEED_ACCOUNT, SEED_HASH);

const reason = (v) => (v == null ? 'null' : String(v));

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  switch (req.op) {
    case 'markerKey':
      out = String(mod.markerKey(req.adapterId, req.account, req.infoHash));
      break;
    case 'markerValue':
      out = JSON.stringify(mod.markerValue(req.accepted, req.meta));
      break;
    case 'markerTransferId':
      cache.set(SEED_KEY, req.value, 60);
      out = reason(mod.markerTransferId(SEED_ADAPTER, SEED_ACCOUNT, SEED_HASH));
      break;
    case 'markerObra':
      cache.set(SEED_KEY, req.value, 60);
      out = reason(mod.markerObra(SEED_ADAPTER, SEED_ACCOUNT, SEED_HASH));
      break;
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

fs.writeFileSync(process.argv[3], JSON.stringify({ ok: true, meta: null, cases }));
