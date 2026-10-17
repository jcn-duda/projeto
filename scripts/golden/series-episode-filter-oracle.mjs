#!/usr/bin/env node
/**
 * Oráculo do golden de `filterSeriesEpisodeRaw`
 * (`src/providers/stream-builder-episode-filter.ts`).
 *
 * Roda SÓ a função real do `dist` (nunca uma reimplementação), dentro do
 * staging descartável montado por `dump-series-episode-filter.mjs`. Lê o
 * `job.json` (artefato absoluto + casos) e devolve `{ok:true, cases:[{id,out}]}`
 * no stdout.
 *
 * O `input` de cada caso é `{"items":[…], "season", "episode", "universe",
 * "names", "airDate", "now", "unaired", "preAirHashes"}`. A saída canônica é
 * `{"kept":[índices],"dropped":[índices]}` — o TS atual não rotula este laço,
 * então o golden trava só o particionamento (o porte Rust também não compara
 * motivo). `unaired` e `preAirHashes` do corpus são o que o porte Rust recebe
 * (sem I/O de banco); o oráculo os reconferem contra a derivação do TS
 * (margens da config; banco DESLIGADO no staging, então o pre-air sai só do
 * `publishedAt` — o mesmo valor que o corpus declarou). `fetch` é armado para
 * explodir: a função é pura e não toca a rede.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };
const mod = await import(pathToFileURL(path.resolve(job.artifact)).href);
const { default: config } = await import(pathToFileURL(path.resolve(path.dirname(job.artifact), '../config.js')).href);
const { extractInfoHash } = await import(pathToFileURL(path.resolve(path.dirname(job.artifact), '../utils/format.js')).href);

const SANE_DATE_MS = Date.parse('2000-01-01T00:00:00Z');
const hashOf = (r) => String(extractInfoHash(r.infoHash || r.magnet || '') || '').toLowerCase();

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  const items = req.items;
  const index = new Map(items.map((item, i) => [item, i]));
  // Guarda do corpus: `unaired` e `preAirHashes` declarados têm de bater com a
  // derivação do TS nas condições do staging (sem banco de magnets). O pre-air
  // do TS exclui BR e item da conta (só `first_seen`, que não existe aqui).
  const airAt = Date.parse(String(req.airDate || ''));
  const unaired = config.search.unairedMarginMs > 0
    && Number.isFinite(airAt) && airAt - req.now > config.search.unairedMarginMs;
  if (unaired !== req.unaired) throw new Error(`caso ${c.id}: unaired diverge da derivação do TS`);
  const limit = airAt - config.search.preAirReleaseMarginMs;
  const derived = new Set();
  if (config.search.preAirReleaseMarginMs > 0 && Number.isFinite(airAt)) {
    for (const r of items) {
      if (!r || r.isBr || r.fromAccount) continue;
      const hash = hashOf(r);
      if (!hash) continue;
      const published = Number(r.publishedAt);
      if (Number.isFinite(published) && published > SANE_DATE_MS && published < limit) derived.add(hash);
    }
  }
  const declared = [...req.preAirHashes].map((x) => String(x).toLowerCase());
  if (declared.length !== derived.size || declared.some((x) => !derived.has(x))) {
    throw new Error(`caso ${c.id}: preAirHashes diverge da derivação do TS`);
  }
  const { kept, dropped } = mod.filterSeriesEpisodeRaw(items, req.season, req.episode, req.universe, {
    airDate: req.airDate, now: req.now, names: req.names,
  });
  const keptIdx = kept.map((x) => index.get(x));
  const droppedIdx = dropped.map((x) => index.get(x));
  if (keptIdx.length + droppedIdx.length !== items.length) {
    throw new Error(`caso ${c.id}: partição não cobre o lote`);
  }
  return { id: c.id, out: JSON.stringify({ kept: keptIdx, dropped: droppedIdx }) };
});
process.stdout.write(JSON.stringify({ ok: true, cases }));
