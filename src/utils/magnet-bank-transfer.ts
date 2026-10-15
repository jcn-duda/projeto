// EXPORTAR / IMPORTAR o banco de magnets VIVO (aba Magnets do painel).
//
// Para que serve: o `magnets.db` é acervo PERMANENTE — o que o site derrubado
// já não devolve só existe ali. Uma pane de disco na VPS o perde inteiro, e o
// operador quer também levar o acervo da VPS para o Docker local e testar com
// dado real. O export é a cópia de segurança; o import a traz de volta.
//
// Formato: NDJSON (uma linha JSON por registro), gzipado no transporte. A
// primeira linha é o cabeçalho `{"t":"meta","format":…,"v":1,…}`; depois
// vêm os registros com `t` = `m` (magnet), `s` (fonte) e `w` (obra), cada
// magnet seguido das SUAS fontes e obras. Linha, e não o arquivo SQLite cru:
// dá para gerar em fluxo sem parar a captura, é legível, e o import valida
// registro a registro em vez de confiar num banco de fora.
//
// O import MESCLA, nunca substitui (decisão do operador, 2026-09-29): a
// regra é a do próprio banco — `first_seen` o mais antigo, `last_seen` o mais
// novo, seeders máximos, `is_br`/`dubbed`/`lied` só sobem, URI só troca por
// outra mais rica. Importar o mesmo arquivo duas vezes não muda nada na
// segunda, e nada que já existe localmente é apagado.
import { isRicherUri } from './magnet-bank-merge.js';
import type { Engine, MagnetRow, SourceRow, WorkRow } from './magnet-bank-rows.js';

export const TRANSFER_FORMAT = 'adom-magnet-bank';
export const TRANSFER_VERSION = 1;
/** Magnets por página do export (leitura, sem transação). */
const PAGE = 500;
/**
 * Magnets por lote do IMPORT (uma transação cada). Menor que a página do
 * export porque o lote é SÍNCRONO e segura o event loop: medido em 2026-09-29
 * no Docker do Windows (volume montado, fsync lento), lote de 500 travava até
 * 647 ms — a busca ao vivo esperava junto. Com 200 e uma volta ao event loop
 * entre lotes, a importação divide o processo com as requisições.
 */
const IMPORT_BATCH = 200;

// --- Validação de registro vindo de arquivo --------------------------------

const HASH_RE = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/;
const IMDB_RE = /^tt\d{1,12}$/;
const MAX_URI = 2048;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v: unknown, min = 0): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min ? n : min;
};
const flag = (v: unknown): number => (Number(v) ? 1 : 0);
const hashOf = (v: unknown): string | null => {
  const h = str(v, 64).toLowerCase();
  return HASH_RE.test(h) ? h : null;
};

/** Magnet do arquivo → linha do banco; `null` quando não é registro válido. */
export function readMagnet(o: Record<string, unknown>): MagnetRow | null {
  const hash = hashOf(o.hash);
  if (!hash) return null;
  const uri = str(o.uri, MAX_URI + 1);
  return {
    hash,
    // URI que não é magnet (ou longa demais) vira vazia: o play cai no magnet
    // padrão do hash, que é o comportamento de banco sem URI.
    uri: uri.length <= MAX_URI && /^magnet:\?/i.test(uri) ? uri : '',
    title: str(o.title, 500),
    size: int(o.size),
    isBr: flag(o.isBr),
    dubbed: flag(o.dubbed),
    quality: str(o.quality, 20),
    seedersMax: int(o.seedersMax),
    seedersLast: int(o.seedersLast),
    firstSeen: int(o.firstSeen),
    lastSeen: int(o.lastSeen),
    lied: flag(o.lied),
  };
}

export function readSource(o: Record<string, unknown>): SourceRow | null {
  const hash = hashOf(o.hash);
  const indexer = str(o.indexer, 100);
  if (!hash || !indexer) return null;
  return {
    hash, indexer, tracker: str(o.tracker, 100),
    firstSeen: int(o.firstSeen), lastSeen: int(o.lastSeen), seedersLast: int(o.seedersLast),
  };
}

export function readWork(o: Record<string, unknown>): WorkRow | null {
  const hash = hashOf(o.hash);
  const imdb = str(o.imdb, 20);
  if (!hash || !IMDB_RE.test(imdb)) return null;
  return {
    hash, imdb, season: int(o.season, -1), episode: int(o.episode, -1),
    firstSeen: int(o.firstSeen), lastSeen: int(o.lastSeen), passedFilter: flag(o.passedFilter),
  };
}

// --- Mesclagem linha × linha (as datas vêm do arquivo, não do relógio) ------

const minSeen = (a: number, b: number) => (a && b ? Math.min(a, b) : a || b);

export function mergeMagnetRows(prev: MagnetRow | null, next: MagnetRow): MagnetRow {
  if (!prev) return next;
  const newer = next.lastSeen > prev.lastSeen;
  return {
    hash: prev.hash,
    uri: isRicherUri(next.uri, prev.uri) ? next.uri : prev.uri,
    title: prev.title || next.title,
    size: prev.size || next.size,
    isBr: prev.isBr || next.isBr ? 1 : 0,
    dubbed: prev.dubbed || next.dubbed ? 1 : 0,
    quality: prev.quality || next.quality,
    seedersMax: Math.max(prev.seedersMax, next.seedersMax),
    seedersLast: newer ? next.seedersLast : prev.seedersLast,
    firstSeen: minSeen(prev.firstSeen, next.firstSeen),
    lastSeen: Math.max(prev.lastSeen, next.lastSeen),
    lied: prev.lied || next.lied ? 1 : 0,
  };
}

export function mergeSourceRows(prev: SourceRow | null, next: SourceRow): SourceRow {
  if (!prev) return next;
  const newer = next.lastSeen > prev.lastSeen;
  return {
    hash: prev.hash,
    indexer: prev.indexer,
    tracker: prev.tracker || next.tracker,
    firstSeen: minSeen(prev.firstSeen, next.firstSeen),
    lastSeen: Math.max(prev.lastSeen, next.lastSeen),
    seedersLast: newer ? next.seedersLast : prev.seedersLast,
  };
}

export function mergeWorkRows(prev: WorkRow | null, next: WorkRow): WorkRow {
  if (!prev) return next;
  // `passed_filter` reflete a ÚLTIMA observação da obra (regra do banco): vence
  // o lado com `last_seen` mais novo, e o empate preserva o local.
  const newer = next.lastSeen > prev.lastSeen;
  return {
    ...prev,
    firstSeen: minSeen(prev.firstSeen, next.firstSeen),
    lastSeen: Math.max(prev.lastSeen, next.lastSeen),
    passedFilter: newer ? next.passedFilter : prev.passedFilter,
  };
}

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

// --- Import ---------------------------------------------------------------

export interface ImportReport {
  ok: boolean;
  error?: string;
  lines: number;
  rejected: number;
  magnets: { read: number; inserted: number; merged: number };
  sources: { read: number; inserted: number; merged: number };
  works: { read: number; inserted: number; merged: number };
}

const counter = () => ({ read: 0, inserted: 0, merged: 0 });

/**
 * Importa as linhas do arquivo mesclando no banco, em lotes de `PAGE` magnets
 * (uma transação por lote). O cabeçalho é OBRIGATÓRIO e é ele que recusa
 * arquivo de outro formato/versão — sem ler nada além dele.
 */
export async function importLines(engine: Engine, lines: AsyncIterable<string>): Promise<ImportReport> {
  const report: ImportReport = {
    ok: false, lines: 0, rejected: 0, magnets: counter(), sources: counter(), works: counter(),
  };
  let header = false;
  let magnets: MagnetRow[] = [];
  let sources: SourceRow[] = [];
  let works: WorkRow[] = [];

  const flush = () => {
    if (!magnets.length && !sources.length && !works.length) return;
    const hashes = [...new Set([...magnets, ...sources, ...works].map((r) => r.hash))];
    const localM = new Map(engine.listMagnetsMany(hashes).map((r) => [r.hash, r]));
    const localS = new Map(engine.listSourcesMany(hashes).map((r) => [`${r.hash}\u0000${r.indexer}`, r]));
    const localW = new Map(engine.listWorksMany(hashes).map((r) => [workKey(r), r]));
    const outM = new Map<string, MagnetRow>();
    for (const row of magnets) {
      const prev = outM.get(row.hash) ?? localM.get(row.hash) ?? null;
      if (localM.has(row.hash) || outM.has(row.hash)) report.magnets.merged++; else report.magnets.inserted++;
      outM.set(row.hash, mergeMagnetRows(prev, row));
    }
    // Fonte/obra sem o magnet (nem no arquivo, nem no banco) ficaria ÓRFÃ: o
    // banco nunca grava uma sem a outra, e o fallback leria hash sem URI.
    const known = (hash: string) => outM.has(hash) || localM.has(hash);
    const orphans = sources.filter((r) => !known(r.hash)).length + works.filter((r) => !known(r.hash)).length;
    report.rejected += orphans;
    sources = sources.filter((r) => known(r.hash));
    works = works.filter((r) => known(r.hash));
    const outS = new Map<string, SourceRow>();
    for (const row of sources) {
      const key = `${row.hash}\u0000${row.indexer}`;
      const prev = outS.get(key) ?? localS.get(key) ?? null;
      if (prev) report.sources.merged++; else report.sources.inserted++;
      outS.set(key, mergeSourceRows(prev, row));
    }
    const outW = new Map<string, WorkRow>();
    for (const row of works) {
      const key = workKey(row);
      const prev = outW.get(key) ?? localW.get(key) ?? null;
      if (prev) report.works.merged++; else report.works.inserted++;
      outW.set(key, mergeWorkRows(prev, row));
    }
    engine.writeBatch({ magnets: [...outM.values()], sources: [...outS.values()], works: [...outW.values()] });
    magnets = []; sources = []; works = [];
  };

  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    report.lines++;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (!header) return { ...report, error: 'arquivo não é NDJSON do banco de magnets' };
      report.rejected++;
      continue;
    }
    if (!header) {
      if (o?.t !== 'meta' || o.format !== TRANSFER_FORMAT) {
        return { ...report, error: 'cabeçalho ausente: o arquivo não é um export do banco de magnets' };
      }
      if (o.v !== TRANSFER_VERSION) return { ...report, error: `versão do arquivo não suportada (${String(o.v)})` };
      header = true;
      continue;
    }
    const row = o?.t === 'm' ? readMagnet(o) : o?.t === 's' ? readSource(o) : o?.t === 'w' ? readWork(o) : null;
    if (!row) { report.rejected++; continue; }
    if (o.t === 'm') { magnets.push(row as MagnetRow); report.magnets.read++; }
    else if (o.t === 's') { sources.push(row as SourceRow); report.sources.read++; }
    else { works.push(row as WorkRow); report.works.read++; }
    if (magnets.length >= IMPORT_BATCH) {
      flush();
      // Devolve a vez ao event loop: o lote é síncrono, e sem esta pausa a
      // leitura do arquivo emendaria lote atrás de lote sem deixar a busca ao
      // vivo ser atendida.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (!header) return { ...report, error: 'arquivo vazio' };
  flush();
  return { ...report, ok: true };
}

function workKey(r: WorkRow): string {
  return `${r.hash}\u0000${r.imdb}\u0000${r.season}\u0000${r.episode}`;
}
