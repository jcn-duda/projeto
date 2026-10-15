#!/usr/bin/env node
/**
 * Oráculo do golden `autofetch-policy`: mede a saída REAL do `dist` para cada
 * caso do corpus. Roda em processo filho isolado (sem rede, sem config real).
 *
 * `input` de cada caso é JSON com `op`; a saída é SEMPRE string:
 * - `normalizeSeedsMaxQuality`  → qualidade normalizada
 * - `effectiveSeedsMaxBytes`    → número (bytes)
 * - `seedsDownloadBytes`        → número (bytes)
 * - `seedsQualityReject`        → razão ou "null"
 * - `seedsSizeReject`           → razão ou "null"
 * - `seedsIntrinsicRejection`   → razão ou "null"
 * - `filterSeedsUniverse`       → JSON {eligible,rejected}
 * - `hasPlayableStream`         → "1"/"0"
 * - `seedsSelectionBlock`       → razão ou "null"
 * - `decideSeedsStop`           → JSON {stop,rareOverCached}
 * - `seedsDrainRejection`       → razão ou "null"
 * - `streamTitleBytes`          → número (bytes)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };

const mod = await import(pathToFileURL(path.resolve(job.repo, job.artifact)).href);
const epMod = await import(pathToFileURL(path.resolve(job.repo, job.episodeSizeArtifact)).href);

const bit = (v) => (v ? '1' : '0');
const reason = (v) => (v == null ? 'null' : String(v));

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  switch (req.op) {
    case 'normalizeSeedsMaxQuality':
      out = String(mod.normalizeSeedsMaxQuality(req.value));
      break;
    case 'effectiveSeedsMaxBytes':
      out = String(mod.effectiveSeedsMaxBytes({ seedsMaxGb: req.seedsMaxGb, maxSizeGb: req.maxSizeGb }));
      break;
    case 'seedsDownloadBytes':
      out = String(mod.seedsDownloadBytes(req.stream ?? null));
      break;
    case 'seedsQualityReject':
      out = reason(mod.seedsQualityReject(req.stream ?? null, req.maxQuality));
      break;
    case 'seedsSizeReject':
      out = reason(mod.seedsSizeReject(req.stream ?? null, req.maxBytes));
      break;
    case 'seedsIntrinsicRejection':
      out = reason(mod.seedsIntrinsicRejection(req.stream ?? null, req.cfg));
      break;
    case 'filterSeedsUniverse': {
      const { eligible, rejected } = mod.filterSeedsUniverse(req.streams ?? [], req.cfg);
      const rej = {};
      for (const [k, v] of rejected) rej[k] = v;
      out = JSON.stringify({ eligible: eligible.length, rejected: rej });
      break;
    }
    case 'hasPlayableStream':
      out = bit(mod.hasPlayableStream(req.streams ?? []));
      break;
    case 'seedsSelectionBlock':
      out = reason(mod.seedsSelectionBlock(req.cfg ?? {}, req.streams ?? [], req.extra ?? {}));
      break;
    case 'decideSeedsStop':
      out = JSON.stringify(mod.decideSeedsStop(req));
      break;
    case 'seedsDrainRejection':
      out = reason(mod.seedsDrainRejection(req.candidate ?? null, req.cfg));
      break;
    case 'streamTitleBytes':
      out = String(epMod.streamTitleBytes(req.title));
      break;
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

const outPath = process.argv[3];
fs.writeFileSync(outPath, JSON.stringify({ ok: true, meta: null, cases }));
