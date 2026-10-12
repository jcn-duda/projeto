#!/usr/bin/env node
/**
 * Oráculo do golden das REGRAS PURAS + CODEC do estado da raspagem
 * (`src/utils/crawl-store-rules.ts`): `errorBackoffMs`, `parseProgress`,
 * `renderProgress`, `progressAdvanced`, `withDryFlag`, `decideUpsert`,
 * `applyResult`, `renderUrl`, `parseStatus`, `parseUrlRow` e `emptyCounters`.
 *
 * Mede a saída REAL do `dist` — nunca uma reimplementação do TS. Roda no
 * staging descartável montado por `dump-crawl-store-rules.mjs` (CWD no staging,
 * env mínima, sem .env/data, `RUST_CORE=off`): lê o `job.json` (artefato
 * absoluto + casos), importa o artefato por caminho absoluto e devolve
 * `{ok:true, meta, cases:[{id,out}]}` no stdout. O grafo é puro (só
 * `crawl-url-key.js`, sem config/dotenv), então `fetch` é armado para explodir.
 *
 * `input` de cada caso é um JSON com `op`; a saída é SEMPRE string, com
 * codificação fixa por operação:
 * - `backoff`          + `baseMs`+`tries`            → decimal
 * - `parseProgress`    + `raw`                        → JSON do progresso (ou "null")
 * - `renderProgress`   + `p`                          → JSON canônico cru
 * - `progressAdvanced` + `prev`+`next`               → "1"/"0"
 * - `withDryFlag`      + `raw`                        → JSON cru (ou "")
 * - `decideUpsert`     + `site`+`existing`+`entry`+`now` → JSON `{outcome,row}`
 * - `applyResult`      + `existing`+`result`+`now`+`opts` → JSON da linha
 * - `renderUrl`        + `row`                        → JSON do array de colunas
 * - `parseStatus`      + `value`                      → status
 * - `parseUrlRow`      + `r`                          → JSON da linha
 * - `emptyCounters`                                   → JSON dos contadores
 *
 * `meta.constants` devolve os literais EXPORTADOS pelo artefato
 * (`ERROR_BACKOFF_CAP_MS`, `CRAWL_GIVE_UP_MS`, `DEFAULT_RETRY_BASE_MS`) para o
 * gerador conferir contra o `config` do corpus — o corpus os documenta e a
 * medição confirma que o dist vivo concorda.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
globalThis.fetch = () => { throw new Error('fetch proibido no oráculo'); };
const mod = await import(pathToFileURL(path.resolve(job.artifact)).href);

const bit = (v) => (v ? '1' : '0');

const meta = {
  constants: {
    errorBackoffCapMs: mod.ERROR_BACKOFF_CAP_MS,
    crawlGiveUpMs: mod.CRAWL_GIVE_UP_MS,
    defaultRetryBaseMs: mod.DEFAULT_RETRY_BASE_MS,
  },
};

const cases = job.cases.map((c) => {
  const req = JSON.parse(c.input);
  let out;
  switch (req.op) {
    case 'backoff':
      out = String(mod.errorBackoffMs(req.baseMs, req.tries));
      break;
    case 'parseProgress':
      out = JSON.stringify(mod.parseProgress(req.raw));
      break;
    case 'renderProgress':
      out = String(mod.renderProgress(req.p));
      break;
    case 'progressAdvanced':
      out = bit(mod.progressAdvanced(req.prev, req.next));
      break;
    case 'withDryFlag':
      out = String(mod.withDryFlag(req.raw));
      break;
    case 'decideUpsert':
      out = JSON.stringify(mod.decideUpsert(req.site, req.existing ?? null, req.entry, req.now));
      break;
    case 'applyResult':
      out = JSON.stringify(mod.applyResult(req.existing, req.result, req.now, req.opts));
      break;
    case 'renderUrl':
      out = JSON.stringify(mod.renderUrl(req.row));
      break;
    case 'parseStatus':
      out = String(mod.parseStatus(req.value));
      break;
    case 'parseUrlRow':
      out = JSON.stringify(mod.parseUrlRow(req.r));
      break;
    case 'emptyCounters':
      out = JSON.stringify(mod.emptyCounters());
      break;
    default:
      throw new Error(`op desconhecida: ${req.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});
process.stdout.write(JSON.stringify({ ok: true, meta, cases }));
