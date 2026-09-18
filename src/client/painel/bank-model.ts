// Modelo puro do card "Banco de Magnets Vivo" (Etapa 5). Sem DOM e sem fetch:
// lê o contrato real do bloco `magnetBank` do /dashboard-status.json e da
// resposta de `magnet-bank-search` e devolve estruturas estáveis para a view.
//
// O banco vivo (clone permanente do Jackett) é DIFERENTE do `magnetdb` (estoque
// por conta): aqui os totais são magnets/fontes/obras e a quebra é por indexer.
import { formatAgeFromTimestamp } from './fmt.js';

/** Teto do backend para a busca (`magnet-bank-search`); a UI pede o mesmo. */
export const BANK_SEARCH_RESULT_MAX = 100;

export type BankSearchMode = 'hash' | 'title' | 'recent' | 'unknown';

export interface BankIndexerRow {
  indexer: string;
  hashes: number;
  sources: number;
  lastSeen: number;
}

export interface MagnetBankSummary {
  enabled: boolean;
  engine: string;
  magnets: number;
  sources: number;
  works: number;
  lastSeen: number;
  queue: number;
  queueMax: number;
  byIndexer: BankIndexerRow[];
}

export interface BankSourceView {
  indexer: string;
  tracker: string;
  lastSeen: number;
  seedersLast: number;
}

export interface BankWorkView {
  imdb: string;
  season: number;
  episode: number;
  passedFilter: boolean;
}

export interface BankSearchItemView {
  hash: string;
  uri: string;
  title: string;
  size: number;
  isBr: boolean;
  dubbed: boolean;
  quality: string;
  seedersMax: number;
  seedersLast: number;
  lastSeen: number;
  lied: boolean;
  sources: BankSourceView[];
  works: BankWorkView[];
}

export interface BankSearchView {
  mode: BankSearchMode;
  modeLabel: string;
  query: string;
  /** Total exato de casados; `null` quando a janela foi truncada (sem COUNT). */
  matched: number | null;
  returned: number;
  truncated: boolean;
  items: BankSearchItemView[];
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function engineLabel(engine: unknown): string {
  const value = String(engine || '');
  if (value === 'sql') return 'SQLite';
  if (value === 'memory') return 'MEMÓRIA';
  if (value === 'disabled') return 'DESLIGADO';
  return value ? value.toUpperCase() : '—';
}

export function bankIndexerRows(raw: unknown): BankIndexerRow[] {
  const rows: BankIndexerRow[] = [];
  for (const entry of asArray(raw)) {
    const obj = asObject(entry);
    if (!obj) continue;
    const indexer = String(obj.indexer ?? '').trim();
    if (!indexer) continue;
    rows.push({
      indexer,
      hashes: num(obj.hashes),
      sources: num(obj.sources),
      lastSeen: num(obj.lastSeen),
    });
  }
  // Mais recente primeiro; empate por id, determinístico (mesma ordem da SQL).
  return rows.sort((a, b) => (b.lastSeen - a.lastSeen) || (a.indexer < b.indexer ? -1 : a.indexer > b.indexer ? 1 : 0));
}

export function magnetBankSummary(raw: unknown): MagnetBankSummary {
  const obj = asObject(raw) || {};
  return {
    enabled: obj.enabled === true,
    engine: engineLabel(obj.engine),
    magnets: num(obj.magnets),
    sources: num(obj.sources),
    works: num(obj.works),
    lastSeen: num(obj.lastSeen),
    queue: num(obj.queue),
    queueMax: num(obj.queueMax),
    byIndexer: bankIndexerRows(obj.byIndexer),
  };
}

/** "há X" para o último visto; `0`/ausente sai "—" (nunca "há 56 anos"). */
export function bankLastSeenLabel(ts: unknown): string {
  const value = num(ts);
  if (value <= 0) return '—';
  return `${formatAgeFromTimestamp(value)} atrás`;
}

export function bankSearchModeLabel(mode: BankSearchMode): string {
  if (mode === 'hash') return 'por hash';
  if (mode === 'title') return 'por título';
  if (mode === 'recent') return 'recentes';
  return 'busca';
}

function normalizeSource(raw: unknown): BankSourceView | null {
  const obj = asObject(raw);
  if (!obj) return null;
  return {
    indexer: String(obj.indexer ?? ''),
    tracker: String(obj.tracker ?? ''),
    lastSeen: num(obj.lastSeen),
    seedersLast: num(obj.seedersLast),
  };
}

function normalizeWork(raw: unknown): BankWorkView | null {
  const obj = asObject(raw);
  if (!obj) return null;
  return {
    imdb: String(obj.imdb ?? ''),
    season: num(obj.season),
    episode: num(obj.episode),
    passedFilter: obj.passedFilter === 1 || obj.passedFilter === true,
  };
}

function normalizeItem(raw: unknown): BankSearchItemView | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const hash = String(obj.hash ?? '');
  if (!hash) return null;
  return {
    hash,
    uri: String(obj.uri ?? ''),
    title: String(obj.title ?? '') || '(sem título)',
    size: num(obj.size),
    isBr: obj.isBr === true,
    dubbed: obj.dubbed === true,
    quality: String(obj.quality ?? ''),
    seedersMax: num(obj.seedersMax),
    seedersLast: num(obj.seedersLast),
    lastSeen: num(obj.lastSeen),
    lied: obj.lied === true,
    sources: asArray(obj.sources).map(normalizeSource).filter((s): s is BankSourceView => s !== null),
    works: asArray(obj.works).map(normalizeWork).filter((w): w is BankWorkView => w !== null),
  };
}

export function bankSearchView(raw: unknown): BankSearchView {
  const obj = asObject(raw) || {};
  const modeRaw = String(obj.mode || '');
  const mode: BankSearchMode = modeRaw === 'hash' || modeRaw === 'title' || modeRaw === 'recent' ? modeRaw : 'unknown';
  const items = asArray(obj.items)
    .map(normalizeItem)
    .filter((item): item is BankSearchItemView => item !== null);
  return {
    mode,
    modeLabel: bankSearchModeLabel(mode),
    query: String(obj.query ?? ''),
    matched: obj.matched == null ? null : num(obj.matched),
    returned: num(obj.returned),
    truncated: obj.truncated === true,
    items,
  };
}

/** "N de M" quando o total é conhecido; "N+" quando a janela foi truncada
 * (o backend não pagou COUNT exato — ver `searchBank`). */
export function bankSearchCountLabel(view: { matched: number | null; returned: number }): string {
  return view.matched == null ? `${view.returned}+` : `${view.returned} de ${view.matched}`;
}

/** Rótulo da obra: temporada/episódio quando existem; "-1" é o nulo da PK. */
export function workLabel(work: BankWorkView): string {
  const parts: string[] = [];
  if (work.imdb) parts.push(work.imdb);
  if (work.season > 0) {
    const ep = work.episode > 0 ? `E${String(work.episode).padStart(2, '0')}` : '';
    parts.push(`S${String(work.season).padStart(2, '0')}${ep}`);
  } else if (work.episode > 0) {
    parts.push(`E${String(work.episode).padStart(2, '0')}`);
  }
  parts.push(work.passedFilter ? 'passou' : 'filtrada');
  return parts.join(' · ');
}
