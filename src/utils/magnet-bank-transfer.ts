// EXPORTAR o banco de magnets VIVO (aba Magnets do painel).
//
// Para que serve: o `magnets.db` é acervo PERMANENTE — o que o site derrubado
// já não devolve só existe ali. Uma pane de disco na VPS o perde inteiro, e o
// operador quer também levar o acervo da VPS para o Docker local e testar com
// dado real. O export é a cópia de segurança; o import a traz de volta.
//
// Formato: NDJSON (uma linha JSON por registro), gzipado no transporte. A
// primeira linha é o cabeçalho `{"t":"meta","format":…,"v":1,…}`; depois
// vêm os registros com `t` = `m` (magnet), `s` (fonte) e `w` (obra), cada
// magnet seguido das SUAS fontes e obras.
//
// A MESCLA do import congelou no oráculo
// (`test/helpers/pipeline-oracle/magnet-bank-import.ts`): quem mescla/grava
// hoje é o gateway via `POST /magnet-bank/import` na admin 8711
// (`adom-store::magnet_bank_import`) — a rota Node só spoola o arquivo
// descompactado e repassa. Aqui fica o lado export.
import type { Engine } from './magnet-bank-rows.js';

export const TRANSFER_FORMAT = 'adom-magnet-bank';
export const TRANSFER_VERSION = 1;
/** Magnets por página do export (leitura, sem transação). */
const PAGE = 500;

// --- Export ---------------------------------------------------------------

/** Linhas NDJSON do acervo inteiro, em páginas por hash (keyset). */
export function* exportLines(engine: Engine, now = Date.now()): Generator<string> {
  yield JSON.stringify({
    t: 'meta', format: TRANSFER_FORMAT, v: TRANSFER_VERSION, exportedAt: now,
    engine: engine.kind,
    counts: { magnets: engine.countMagnets(), sources: engine.countSources(), works: engine.countWorks() },
  }) + '\n';
  let after = '';
  for (;;) {
    const page = engine.listMagnetsAfter(after, PAGE);
    if (!page.length) return;
    const hashes = page.map((m) => m.hash);
    const sources = groupByHash(engine.listSourcesMany(hashes));
    const works = groupByHash(engine.listWorksMany(hashes));
    let chunk = '';
    for (const m of page) {
      chunk += JSON.stringify({ t: 'm', ...m }) + '\n';
      for (const s of sources.get(m.hash) ?? []) chunk += JSON.stringify({ t: 's', ...s }) + '\n';
      for (const w of works.get(m.hash) ?? []) chunk += JSON.stringify({ t: 'w', ...w }) + '\n';
    }
    yield chunk;
    after = page[page.length - 1].hash;
  }
}

function groupByHash<T extends { hash: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.hash);
    if (list) list.push(row); else out.set(row.hash, [row]);
  }
  return out;
}
