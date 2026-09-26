// Estado da raspagem dos sites BR — REGRAS PURAS + CODEC (Fase 0, sem rede).
//
// A decisão do upsert idempotente e a marcação de resultado são FUNÇÕES PURAS
// aqui, e as duas engines (SQLite e memória) as consomem — paridade garantida
// por construção, não por dois códigos parecidos (mesmo motivo do
// `magnet-bank-merge.ts`). O codec (render/parse das linhas) vive junto: é
// pura transformação de dados, sem I/O.
//
// Semântica do upsert (o coração da fase incremental):
// - URL nova → nasce `pending` (elegível na hora);
// - lastmod IGUAL → `unchanged`: a linha NEM É TOCADA, porque o estado atual
//   (`done`, `inflight`, `error`) continua verdadeiro para o conteúdo antigo;
// - lastmod NOVO → `refreshed`: o conteúdo pode ter mudado, então a URL volta
//   a `pending` do zero (tries/imdb/releases/error limpos) — é o que faz um
//   lançamento do site entrar no banco sem reprocessar as outras 10 mil URLs.
import type {
  CrawlPageKind,
  CrawlUrlRow,
  CrawlUrlStatus,
  DiscoveredEntry,
  MarkOpts,
  MarkResultInput,
  UpsertReport,
} from '../providers/crawl-types.js';

/** Teto do backoff exponencial: 6h — erro persistente não pode virar polling
 * eterno, mas também não pode dormir mais que o ciclo incremental. */
export const ERROR_BACKOFF_CAP_MS = 6 * 3600_000;

/** Dormência de URL cujas tentativas esgotaram (`tries >= maxTries`): um dia
 * inteiro. Não é apagada — o "Reprocessar erros" do painel a reenfileira. */
export const CRAWL_GIVE_UP_MS = 24 * 3600_000;

/** Backoff default quando o motor não declara base (erro transitório: 1 min). */
export const DEFAULT_RETRY_BASE_MS = 60_000;

/** Piso do backoff: base menor que 1s é martelada de requisição. */
const MIN_RETRY_BASE_MS = 1000;

/** `tries` é o contador JÁ incrementado da tentativa que falhou (1 = 1ª falha). */
export function errorBackoffMs(baseMs: number, tries: number): number {
  const base = Math.max(MIN_RETRY_BASE_MS, baseMs);
  return Math.min(base * 2 ** Math.max(0, tries - 1), ERROR_BACKOFF_CAP_MS);
}

/** Decisão PURA do upsert idempotente (ver cabeçalho). Ambas as engines a
 * consomem dentro de sua própria escrita, então o relatório `UpsertReport`
 * tem o mesmo significado nas duas. */
export function decideUpsert(
  site: string,
  existing: CrawlUrlRow | null,
  entry: DiscoveredEntry,
  now: number,
): { row: CrawlUrlRow; outcome: keyof UpsertReport } {
  const url = String(entry.url || '');
  const lastmod = String(entry.lastmod || '');
  const kind: CrawlPageKind = entry.kind === 'tv_show' ? 'tv_show' : 'movie';
  if (!existing) {
    return {
      outcome: 'added',
      row: {
        site, url, lastmod, kind,
        status: 'pending',
        imdb: null, tries: 0, nextAt: 0, checkedAt: 0,
        releases: 0, error: '', addedAt: now,
      },
    };
  }
  if ((existing.lastmod || '') === lastmod) {
    return { outcome: 'unchanged', row: existing };
  }
  // lastmod novo: reprocessa do zero, preservando só a identidade da fila.
  return {
    outcome: 'refreshed',
    row: {
      ...existing,
      lastmod, kind,
      status: 'pending',
      imdb: null, tries: 0, nextAt: 0, checkedAt: 0,
      releases: 0, error: '',
    },
  };
}

/** Aplica o resultado do processamento a uma linha EXISTENTE (pura). URL
 * desconhecida é recusa do chamador (no-op), não daqui — assim as duas
 * engines recusam igual. */
export function applyResult(
  existing: CrawlUrlRow,
  result: MarkResultInput,
  now: number,
  opts: MarkOpts = {},
): CrawlUrlRow {
  if (result.status === 'error') {
    const tries = existing.tries + 1;
    const exhausted = opts.maxTries !== undefined && tries >= opts.maxTries;
    const nextAt = now
      + (exhausted
        ? CRAWL_GIVE_UP_MS
        : errorBackoffMs(opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, tries));
    return {
      ...existing,
      status: 'error',
      tries,
      nextAt,
      checkedAt: now,
      error: String(result.error || 'erro'),
    };
  }
  // Terminais: sucesso limpa erro e fila de retry. A releitura futura é
  // decisão do lastmod (upsert), não do relógio — `done` não ganha nextAt.
  // `done` sem contagem explícita preserva a anterior (merge conservador);
  // `no-torrent`/`no-work` provam ausência, então zeram.
  const releases = result.releases ?? (result.status === 'done' ? existing.releases : 0);
  const imdb = result.imdb !== undefined ? result.imdb : existing.imdb;
  return {
    ...existing,
    status: result.status,
    imdb,
    releases,
    nextAt: 0,
    checkedAt: now,
    error: '',
  };
}

export const URL_COLUMNS = [
  'site', 'url', 'lastmod', 'kind', 'status', 'imdb',
  'tries', 'next_at', 'checked_at', 'releases', 'error', 'added_at',
];

export function renderUrl(row: CrawlUrlRow): (string | number | null)[] {
  return [
    row.site, row.url, row.lastmod, row.kind, row.status, row.imdb,
    row.tries, row.nextAt, row.checkedAt, row.releases, row.error, row.addedAt,
  ];
}

/** Status fora da lista conhecida vira `pending` (linha legada/ilegível volta
 * a ser processada em vez de sumir dos contadores). */
export function parseStatus(value: unknown): CrawlUrlStatus {
  return value === 'inflight' || value === 'done' || value === 'no-torrent'
    || value === 'no-work' || value === 'error' ? value : 'pending';
}

export function parseUrlRow(r: Record<string, unknown>): CrawlUrlRow {
  return {
    site: String(r.site || ''),
    url: String(r.url || ''),
    lastmod: String(r.lastmod || ''),
    kind: r.kind === 'tv_show' ? 'tv_show' : 'movie',
    status: parseStatus(r.status),
    imdb: r.imdb == null ? null : String(r.imdb),
    tries: Number(r.tries) || 0,
    nextAt: Number(r.next_at) || 0,
    checkedAt: Number(r.checked_at) || 0,
    releases: Number(r.releases) || 0,
    error: String(r.error || ''),
    addedAt: Number(r.added_at) || 0,
  };
}

/** Contadores zerados com TODOS os status — o painel lê a série inteira. */
export function emptyCounters(): Record<CrawlUrlStatus, number> {
  return { pending: 0, inflight: 0, done: 0, 'no-torrent': 0, 'no-work': 0, error: 0 };
}
