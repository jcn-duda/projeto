// Busca READ-ONLY no banco de magnets vivo para o painel (Etapa 5). Extraído
// de `magnet-bank.ts` pela catraca de 400 linhas: aqui não há captura, fila nem
// escrita — só uma leitura validada e LIMITADA.
//
// A busca aceita três modos, decididos pela própria query (sem `mode` explícito
// vindo da rede):
//   - hash de 40 hex  → lookup pela PK;
//   - texto           → substring do título (case-insensitive), mín. 2 chars;
//   - vazio           → os N mais recentes (comportamento seguro: nunca varre
//                        nem devolve o banco inteiro).
//
// Segurança de payload: o banco é GLOBAL e não guarda credencial nem digest de
// conta, mas a resposta é montada por WHITELIST de campos — magnet, fontes e
// obras são PROJETADOS explicitamente (nunca o objeto cru da engine). O hash
// exposto é sempre o de conteúdo (40-hex minúsculo).
import { readEngine } from './magnet-bank.js';
import type { MagnetRow, SourceRow, WorkRow } from './magnet-bank.js';

export const BANK_SEARCH_MAX = 100;
const DEFAULT_LIMIT = 50;
const HASH_RE = /^[a-f0-9]{40}$/i;
const MAX_QUERY_LENGTH = 120;
const MIN_TITLE_LENGTH = 2;

export type BankSearchMode = 'hash' | 'title' | 'recent';

/** Fonte projetada (sem `hash`/campos internos): só o que a UI mostra. */
export type BankSearchSource = {
  indexer: string;
  tracker: string;
  firstSeen: number;
  lastSeen: number;
  seedersLast: number;
};

/** Obra projetada (sem `hash`): identidade + estado do filtro. */
export type BankSearchWork = {
  imdb: string;
  season: number;
  episode: number;
  firstSeen: number;
  lastSeen: number;
  passedFilter: boolean;
};

export type BankSearchItem = {
  hash: string;
  uri: string;
  title: string;
  size: number;
  isBr: boolean;
  dubbed: boolean;
  quality: string;
  seedersMax: number;
  seedersLast: number;
  firstSeen: number;
  lastSeen: number;
  lied: boolean;
  sources: BankSearchSource[];
  works: BankSearchWork[];
};

export type BankSearchResult =
  | {
    ok: true;
    mode: BankSearchMode;
    query: string;
    limit: number;
    /** Total exato de casados quando a janela os contém; `null` = truncado. */
    matched: number | null;
    returned: number;
    truncated: boolean;
    items: BankSearchItem[];
  }
  | { ok: false; error: string };

/** Teto duro 1..100; `<= 0`/inválido cai no default (50). */
function clampLimit(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(BANK_SEARCH_MAX, n) : DEFAULT_LIMIT;
}

/**
 * Variantes ÚNICAS de caixa da query de título (original + lower/upper pt-BR).
 * O LIKE do SQLite só faz casefold para ASCII; mandar as três formas faz o
 * acento casar (`Épico` × `épico`/`ÉPICO`) sem coluna normalizada nem schema
 * novo. A engine de memória usa as MESMAS variantes, então as duas concordam.
 */
function titleVariants(query: string): string[] {
  const out = new Set<string>([query]);
  try { out.add(query.toLocaleLowerCase('pt-BR')); } catch { /* locale sem suporte: mantém a original */ }
  try { out.add(query.toLocaleUpperCase('pt-BR')); } catch { /* idem */ }
  return [...out];
}

function groupBy<T extends { hash: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.hash);
    if (list) list.push(row);
    else out.set(row.hash, [row]);
  }
  return out;
}

/** Linha → payload seguro (allowlist explícita: nunca o objeto cru da engine). */
function toSource(row: SourceRow): BankSearchSource {
  return {
    indexer: row.indexer,
    tracker: row.tracker,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    seedersLast: row.seedersLast,
  };
}

function toWork(row: WorkRow): BankSearchWork {
  return {
    imdb: row.imdb,
    season: row.season,
    episode: row.episode,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    passedFilter: row.passedFilter === 1,
  };
}

function toItem(row: MagnetRow, sources: SourceRow[], works: WorkRow[]): BankSearchItem {
  return {
    hash: row.hash,
    uri: row.uri,
    title: row.title,
    size: row.size,
    isBr: row.isBr === 1,
    dubbed: row.dubbed === 1,
    quality: row.quality,
    seedersMax: row.seedersMax,
    seedersLast: row.seedersLast,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    lied: row.lied === 1,
    sources: sources.map(toSource),
    works: works.map(toWork),
  };
}

/**
 * Executa a busca. Devolve `{ok:false, error}` para query inválida (texto de 1
 * caractere ou acima do teto) — o handler transforma em 400 sem silenciar.
 * Fontes e obras saem em DUAS consultas em lote (sem N+1) para os hashes
 * retornados.
 *
 * A janela é lida com `limit + 1` registros: `truncated` prova que a lista foi
 * cortada SEM pagar um COUNT exato em cima da varredura (que dobraria o custo
 * da busca por título). Quando a janela contém todos os casados, `matched` é
 * exato; truncado, `matched` é `null`.
 */
export function searchBank(rawQuery: unknown, rawLimit: unknown = DEFAULT_LIMIT): BankSearchResult {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (query.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `consulta acima de ${MAX_QUERY_LENGTH} caracteres` };
  }
  const limit = clampLimit(rawLimit);
  const mode: BankSearchMode = query === '' ? 'recent' : HASH_RE.test(query) ? 'hash' : 'title';
  if (mode === 'title' && query.length < MIN_TITLE_LENGTH) {
    return { ok: false, error: `informe ao menos ${MIN_TITLE_LENGTH} caracteres para buscar por título` };
  }

  const e = readEngine();
  const normalized = mode === 'hash' ? query.toLowerCase() : query;
  if (!e) {
    return { ok: true, mode, query: normalized, limit, matched: 0, returned: 0, truncated: false, items: [] };
  }

  let rows: MagnetRow[];
  let truncated = false;
  if (mode === 'hash') {
    const row = e.getMagnet(normalized);
    rows = row ? [row] : [];
  } else {
    const window = mode === 'title'
      ? e.searchMagnetsByTitle(titleVariants(query), limit + 1)
      : e.listRecentMagnets(limit + 1);
    truncated = window.length > limit;
    rows = truncated ? window.slice(0, limit) : window;
  }

  const hashes = rows.map((row) => row.hash);
  const sourcesByHash = groupBy(e.listSourcesMany(hashes));
  const worksByHash = groupBy(e.listWorksMany(hashes));
  const items = rows.map((row) => toItem(row, sourcesByHash.get(row.hash) || [], worksByHash.get(row.hash) || []));
  const returned = items.length;

  return {
    ok: true,
    mode,
    query: normalized,
    limit,
    matched: truncated ? null : returned,
    returned,
    truncated,
    items,
  };
}
