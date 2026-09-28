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
  SeriesWorkProgress,
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

// --- Codec do progresso de série parcial (Fase 7 v2) ------------------------

/**
 * Parse validado do JSON da coluna `progress`. Ilegível/fora de forma →
 * `null` (a linha é tratada como sem progresso — nunca lança, nunca adota
 * forma estranha como verdade).
 */
export function parseProgress(raw: unknown): SeriesWorkProgress | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  const p = value as Partial<SeriesWorkProgress> | null;
  if (!p || typeof p !== 'object' || p.v !== 1 || !Array.isArray(p.doneCards)) return null;
  const doneCards = p.doneCards.map((u) => String(u || '')).filter(Boolean);
  const card = p.card && typeof p.card === 'object'
    ? { url: String((p.card as { url?: unknown }).url || ''), skip: Number((p.card as { skip?: unknown }).skip) || 0 }
    : undefined;
  const seen = Array.isArray(p.seen) ? p.seen.map((k) => String(k || '')).filter(Boolean) : [];
  return {
    v: 1,
    doneCards,
    ...(card && card.url ? { card } : {}),
    totalCards: Number(p.totalCards) || 0,
    ...(seen.length ? { seen } : {}),
    ...(p.dry === 1 ? { dry: 1 as const } : {}),
  };
}

/**
 * Serialização canônica: ordem de chaves FIXA (v, doneCards, card,
 * totalCards, seen, dry) e arrays na ordem dada — a comparação de avanço é textual
 * e só é honesta com forma estável.
 */
export function renderProgress(p: SeriesWorkProgress): string {
  const card = p.card && p.card.url ? { url: String(p.card.url), skip: Math.max(0, Math.trunc(Number(p.card.skip) || 0)) } : null;
  return JSON.stringify({
    v: 1,
    doneCards: (Array.isArray(p.doneCards) ? p.doneCards : []).map((u) => String(u || '')).filter(Boolean),
    ...(card ? { card } : {}),
    totalCards: Math.max(0, Math.trunc(Number(p.totalCards) || 0)),
    ...(Array.isArray(p.seen) && p.seen.length ? { seen: p.seen.map((k) => String(k || '')).filter(Boolean) } : {}),
    ...(p.dry === 1 ? { dry: 1 } : {}),
  });
}

/**
 * A marcação de progresso `next` avança em relação ao `prevRaw` (coluna)?
 * - `next` inválido/ausente → false (defensivo: um `partial` sem progresso
 *   nunca prova avanço, nunca vira `done` por comparação vazia);
 * - `prev` não parseia → true (1ª marcação da linha);
 * - senão, compara a forma canônica SEM o campo `dry` (dry é metadado do
 *   passe, não avanço de leitura).
 */
export function progressAdvanced(prevRaw: unknown, next?: SeriesWorkProgress | string | null): boolean {
  let parsedNext: SeriesWorkProgress | null = null;
  if (typeof next === 'string') parsedNext = parseProgress(next);
  else if (next && typeof next === 'object') parsedNext = next;
  if (!parsedNext) return false;
  const prev = parseProgress(prevRaw);
  if (!prev) return true;
  // `seen` também fica de fora: é memória de dedupe, não leitura de card.
  const { dry: _prevDry, seen: _prevSeen, ...prevCore } = prev;
  const { dry: _nextDry, seen: _nextSeen, ...nextCore } = parsedNext;
  return renderProgress(prevCore as SeriesWorkProgress) !== renderProgress(nextCore as SeriesWorkProgress);
}

/** Re-render do JSON cru com o flag `dry:1` (passe de dry-run). Cru ilegível
 * volta vazio — nada a marcar. */
export function withDryFlag(raw: unknown): string {
  const p = parseProgress(raw);
  return p ? renderProgress({ ...p, dry: 1 }) : '';
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
        releases: 0, error: '', progress: '', addedAt: now,
      },
    };
  }
  if ((existing.lastmod || '') === lastmod) {
    return { outcome: 'unchanged', row: existing };
  }
  // lastmod novo: reprocessa do zero, preservando só a identidade da fila.
  // `progress: ''` explícito: o spread herdaria o progresso — conteúdo novo
  // reexecuta o varrimento do zero (o card antigo pode nem existir mais).
  return {
    outcome: 'refreshed',
    row: {
      ...existing,
      lastmod, kind,
      status: 'pending',
      imdb: null, tries: 0, nextAt: 0, checkedAt: 0,
      releases: 0, error: '', progress: '',
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
      // O spread preserva o `progress`: uma tentativa que falhou NÃO perde o
      // avanço anterior (o retry retoma dos cards já feitos).
    };
  }
  if (result.status === 'partial') {
    // AVANÇO (progresso novo e diferente do anterior): progresso, não falha —
    // `tries: 0` e retry no prazo curto da base. O guarda anti-loop é o
    // avanço em si (monotônico por invariante do `SeriesWorkProgress`); a
    // ESTAGNAÇÃO não passa por aqui: o crawl-page compara antes de marcar e
    // manda estouro como `error series_stall`. Um `partial` sem progresso
    // nunca chega ao store pelo caminho de produção (o crawl-page recusa);
    // se chegar, o progresso preservado do spread mantém o estado honesto.
    return {
      ...existing,
      status: 'partial',
      tries: 0,
      // Retry ≥ base (60s): o `pending` com next_at=0 continua vindo primeiro
      // na ordem da fila — parcial espera o pending da mesma rodada.
      nextAt: now + (opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS),
      checkedAt: now,
      releases: result.releases ?? 0,
      imdb: result.imdb !== undefined ? result.imdb : existing.imdb,
      // Motivo do recorte como diagnóstico (errorGroups só conta 'error').
      error: String(result.error || ''),
      progress: typeof result.progress === 'string' ? result.progress : existing.progress,
    };
  }
  // Terminais: sucesso limpa erro e fila de retry. A releitura futura é
  // decisão do lastmod (upsert), não do relógio — `done` não ganha nextAt.
  // `done` sem contagem explícita preserva a anterior (merge conservador);
  // `no-torrent`/`no-work` provam ausência, então zeram. `progress: ''`
  // explícito: um `simulated`/`done` terminal NÃO herda progresso — um
  // `simulated` que completou um dry-run manteria o progresso seco e, no
  // flip true→false, a linha viraria `pending` e o resume pularia cards
  // nunca gravados.
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
    progress: '',
  };
}

export const URL_COLUMNS = [
  'site', 'url', 'lastmod', 'kind', 'status', 'imdb',
  'tries', 'next_at', 'checked_at', 'releases', 'error', 'progress', 'added_at',
];

export function renderUrl(row: CrawlUrlRow): (string | number | null)[] {
  return [
    row.site, row.url, row.lastmod, row.kind, row.status, row.imdb,
    row.tries, row.nextAt, row.checkedAt, row.releases, row.error, row.progress, row.addedAt,
  ];
}

/** Status fora da lista conhecida vira `pending` (linha legada/ilegível volta
 * a ser processada em vez de sumir dos contadores). */
export function parseStatus(value: unknown): CrawlUrlStatus {
  return value === 'inflight' || value === 'done' || value === 'no-torrent'
    || value === 'no-work' || value === 'error' || value === 'simulated'
    || value === 'partial' ? value : 'pending';
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
    progress: String(r.progress || ''),
    addedAt: Number(r.added_at) || 0,
  };
}

/** Contadores zerados com TODOS os status — o painel lê a série inteira. */
export function emptyCounters(): Record<CrawlUrlStatus, number> {
  return { pending: 0, inflight: 0, done: 0, 'no-torrent': 0, 'no-work': 0, error: 0, simulated: 0, partial: 0 };
}
