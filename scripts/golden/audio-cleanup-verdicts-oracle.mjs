#!/usr/bin/env node
/**
 * Oráculo do golden das guardas de dublagem por path de
 * `src/utils/audio-cleanup.ts`: `hasPtAudioMark`, `strongEnSceneMark`,
 * `dubbedLieVerdict`, `dnContradictsDubClaim` e `enSceneMirrorTitle`.
 *
 * Mede a saída REAL do `dist` — nunca uma reimplementação do TS. Roda no
 * staging descartável montado por `dump-audio-cleanup-verdicts.mjs` (CWD no
 * staging, env mínima, sem .env/data, `RUST_CORE=off`): lê o `job.json`
 * (artefato absoluto + casos), importa o artefato por caminho absoluto e
 * devolve `{ok:true, cases:[{id,out}]}` no stdout. As listas de config
 * (`ptMarkers`/`enGroups`) entram pelo ambiente (`AUDIO_AUDIT_*`), definido
 * pelo gerador a partir do corpus — o oráculo não as repete.
 *
 * `input` de cada caso é um JSON com `op`:
 * - `ptmark`  + `path`           → `"1"`/`"0"`
 * - `enscene` + `path`           → grupo casado ou `""`
 * - `dn`      + `dn`             → `"1"`/`"0"`
 * - `mirror`  + `title`          → `"1"`/`"0"`
 * - `lie`     + `paths`+`promisedDubbed` → `lie|grupo|videoCount`
 *
 * `fetch` é armado para explodir: o grafo é puro e não toca a rede.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };
const mod = await import(pathToFileURL(path.resolve(job.artifact)).href);

const bit = (v) => (v ? '1' : '0');

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  if (req.op === 'ptmark') out = bit(mod.hasPtAudioMark(req.path));
  else if (req.op === 'enscene') out = mod.strongEnSceneMark(req.path) ?? '';
  else if (req.op === 'dn') out = bit(mod.dnContradictsDubClaim(req.dn));
  else if (req.op === 'mirror') out = bit(mod.enSceneMirrorTitle(req.title));
  else if (req.op === 'lie') {
    const r = mod.dubbedLieVerdict(req.paths, req.promisedDubbed);
    out = `${bit(r.lie)}|${r.matchedGroup ?? ''}|${r.videoCount}`;
  } else throw new Error(`op desconhecida: ${req.op}`);
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});
process.stdout.write(JSON.stringify({ ok: true, cases }));
