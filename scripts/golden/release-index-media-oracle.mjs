#!/usr/bin/env node
/**
 * Oráculo do golden de `src/utils/release-index-media.ts`:
 * `bankRowsForMediaSource` e `mergeMediaSource`, medidos no `dist` real.
 *
 * Roda no staging descartável de `dump-release-index-media.mjs`, com
 * `MAGNET_BANK=false`: sem engine aberto, `readEngine()` devolve null (o caso
 * `engine:"none"`). Para o caso `engine:"seeded"`, o oráculo reabre o engine
 * de MEMÓRIA (`open(undefined, {forceMemory:true})`) e grava as linhas com
 * `writeBatch`. Nunca cria SQLite nem toca disco.
 *
 * Entradas (JSON por caso):
 * - `{"op":"bank","lote":[{item,hash}],"engine":"seeded"|"none","rows":[{hash,uri,title}]}`
 *   Saída: linhas `{hash,uri,title}` ordenadas por hash.
 * - `{"op":"merge","item":{...},"title":"","hash":"","prior":null|"CAM"|...,"bank":null|[{hash,uri,title}]}`
 *   Saída: a fonte (`"CAM"` etc.) ou `null` (o `undefined` do TS).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };
const artifact = path.resolve(job.artifact);
const mod = await import(pathToFileURL(artifact).href);
const bank = await import(pathToFileURL(path.join(path.dirname(artifact), 'magnet-bank-rows.js')).href);

/** Linha completa do MagnetRow: só `hash`, `uri` e `title` vêm do corpus. */
function fullRow(r) {
  return {
    hash: r.hash, uri: r.uri, title: r.title, size: 0, isBr: 0, dubbed: 0,
    quality: '', seedersMax: 0, seedersLast: 0, firstSeen: 1, lastSeen: 1, lied: 0,
  };
}

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  if (req.op === 'bank') {
    bank.resetForTests();
    if (req.engine === 'seeded') {
      bank.open(undefined, { forceMemory: true });
      bank.engine().writeBatch({ magnets: req.rows.map(fullRow), sources: [], works: [] });
    }
    const map = mod.bankRowsForMediaSource(req.lote);
    const rows = [...map.values()]
      .map((m) => ({ hash: m.hash, uri: m.uri, title: m.title }))
      .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    out = rows;
  } else if (req.op === 'merge') {
    const bankMap = req.bank
      ? new Map(req.bank.map((r) => [r.hash, { hash: r.hash, uri: r.uri, title: r.title }]))
      : undefined;
    const prior = req.prior === null ? undefined : { mediaSource: req.prior };
    out = mod.mergeMediaSource(req.item, req.title, req.hash, prior, bankMap) ?? null;
  } else {
    throw new Error(`op desconhecida: ${req.op}`);
  }
  return { id: c.id, out: JSON.stringify(out) };
});
bank.resetForTests();
process.stdout.write(JSON.stringify({ ok: true, cases }));
