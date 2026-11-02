// Leitura do `crawl.db` para o card do painel. O dono do arquivo é o sidecar:
// o Node não abre o SQLite, guarda a última foto de `GET /crawl/site-snapshot`
// por site e entrega ao montador do status (síncrono) por esta interface.
import config from '../config.js';
import { emptyCounters } from '../utils/crawl-store-rules.js';
import { PROBE_STATE_KEY } from './crawl-site-probe.js';
import type {
  CrawlErrorGroup, CrawlResultStatus, CrawlRunRow, CrawlUrlRow, SiteCounters,
} from './crawl-types.js';

/** O que o card lê do `crawl.db`. */
export interface CrawlReadEngine {
  readonly kind: 'sql' | 'memory';
  counters(site: string): SiteCounters;
  latestRun(site: string): CrawlRunRow | null;
  sumReleases(site: string): number;
  listByStatus(site: string, status: CrawlResultStatus, limit: number): CrawlUrlRow[];
  errorGroups(site: string, limit: number): CrawlErrorGroup[];
  getState(site: string, key: string): string | null;
}

type SnapshotRow = {
  url: string; imdb: string | null; releases: number; checkedAt: number;
  error: string | null; tries?: number; progress: string | null;
};

type SiteSnapshot = {
  counters: { total: number; byStatus: Partial<SiteCounters['byStatus']> };
  latestRun: CrawlRunRow | null;
  magnetsFound: number;
  lists: { done: SnapshotRow[]; noWork: SnapshotRow[]; partial: SnapshotRow[]; error: SnapshotRow[] };
  errorGroups: CrawlErrorGroup[];
  state: { probeVerdict: string | null; cursorMovie: string; cursorTvShow: string };
};

const SNAPSHOT_LIMIT = 50;
const LIST_OF: Partial<Record<CrawlResultStatus, keyof SiteSnapshot['lists']>> = {
  done: 'done', 'no-work': 'noWork', partial: 'partial', error: 'error',
};

const snapshots = new Map<string, SiteSnapshot>();
let override: (() => CrawlReadEngine | null) | null = null;

function toRow(site: string, status: CrawlResultStatus, row: SnapshotRow): CrawlUrlRow {
  return {
    site, url: row.url, lastmod: '', kind: 'movie', status, imdb: row.imdb, tries: row.tries ?? 0,
    nextAt: 0, checkedAt: row.checkedAt, releases: row.releases, error: row.error ?? '', progress: row.progress ?? '',
  } as CrawlUrlRow;
}

const nativeEngine: CrawlReadEngine = {
  kind: 'sql',
  counters(site) {
    const snap = snapshots.get(site);
    return { total: snap?.counters.total ?? 0, byStatus: { ...emptyCounters(), ...snap?.counters.byStatus } };
  },
  latestRun: (site) => snapshots.get(site)?.latestRun ?? null,
  sumReleases: (site) => snapshots.get(site)?.magnetsFound ?? 0,
  listByStatus(site, status, limit) {
    const list = LIST_OF[status];
    if (!list) return [];
    return (snapshots.get(site)?.lists[list] ?? []).slice(0, limit).map((row) => toRow(site, status, row));
  },
  errorGroups: (site, limit) => (snapshots.get(site)?.errorGroups ?? []).slice(0, limit),
  getState(site, key) {
    const state = snapshots.get(site)?.state;
    if (!state) return null;
    if (key === PROBE_STATE_KEY) return state.probeVerdict;
    if (key === 'cursor:movie') return state.cursorMovie || null;
    if (key === 'cursor:tv_show') return state.cursorTvShow || null;
    return null;
  },
};

/** Motor de leitura vigente: a foto do sidecar, ou o dublê do teste. */
export function crawlReadEngine(): CrawlReadEngine | null {
  return override ? override() : nativeEngine;
}

async function refreshSite(site: string): Promise<void> {
  const query = `site=${encodeURIComponent(site)}&limit=${SNAPSHOT_LIMIT}`;
  try {
    const resp = await fetch(`http://127.0.0.1:${config.crawl.sidecarPort}/crawl/site-snapshot?${query}`, {
      signal: AbortSignal.timeout(config.crawl.sidecarStatusTimeoutMs),
      headers: config.jackett.testToken ? { 'X-Indexer-Test-Token': config.jackett.testToken } : {},
    });
    if (!resp.ok) return;
    const body = await resp.json() as Partial<SiteSnapshot> | null;
    // Corpo fora do contrato não pode derrubar o painel: fica a foto anterior.
    if (body?.counters && body.lists && body.state) snapshots.set(site, body as SiteSnapshot);
  } catch {
    // Sidecar fora do ar: o card fica com a última foto; o bloco já avisa a queda.
  }
}

/** Renova a foto dos sites antes de montar o bloco. Nunca lança. */
export async function refreshCrawlSnapshots(sites: readonly string[]): Promise<void> {
  if (override) return;
  await Promise.all(sites.map(refreshSite));
}

/** Só para TESTE: troca a foto do sidecar por um motor local. */
export function setCrawlReadEngineForTest(provider: (() => CrawlReadEngine | null) | null): void {
  override = provider;
  snapshots.clear();
}
