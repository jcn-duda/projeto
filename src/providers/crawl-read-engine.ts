// Leitura do `crawl.db` para o card do painel. O dono do arquivo é o sidecar:
// o Node não abre o SQLite, guarda a última foto de `GET /crawl/site-snapshot`
// por site e entrega ao montador do status (síncrono) por esta interface.
import config from '../config.js';
import { emptyCounters } from '../utils/crawl-store-rules.js';
import * as log from '../utils/logger.js';
import { PROBE_STATE_KEY } from './crawl-site-probe.js';
import type {
  CrawlErrorGroup, CrawlResultStatus, CrawlRunRow, CrawlUrlRow, SiteCounters,
} from './crawl-types.js';

/** O que o card lê do `crawl.db`. Os métodos são o contrato antigo; o
 * `snapshotAt` é OPCIONAL (stub de teste antigo não precisa implementar) e
 * devolve epoch ms da última foto gravada — `null` = nunca veio foto. */
export interface CrawlReadEngine {
  readonly kind: 'sql' | 'memory';
  counters(site: string): SiteCounters;
  latestRun(site: string): CrawlRunRow | null;
  sumReleases(site: string): number;
  listByStatus(site: string, status: CrawlResultStatus, limit: number): CrawlUrlRow[];
  errorGroups(site: string, limit: number): CrawlErrorGroup[];
  getState(site: string, key: string): string | null;
  snapshotAt?(site: string): number | null;
  /** Vitals que o sidecar conta no site inteiro; `null` = foto sem o bloco
   * (sidecar anterior a ele) — aí o vitals cai na conta sobre as listas. */
  vitals?(site: string): SidecarVitals | null;
}

/** Bloco `vitals` da foto (`CrawlStore::site_vitals`). */
export type SidecarVitals = {
  pagesLastHour: number;
  http429: { total: number; lastHour: number };
  expired: { total: number; lastHour: number };
};

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
  vitals?: SidecarVitals;
};

// 200 = teto do sidecar (`MAX_LIMIT` do snapshot): a foto é também a fonte dos
// vitals por hora (ritmo, 429, expirado — `crawl-vitals.ts`), e a janela de 50
// saturava em sites no ritmo do teto padrão (1500/h enche 50 em 2 min).
const SNAPSHOT_LIMIT = 200;
const LIST_OF: Partial<Record<CrawlResultStatus, keyof SiteSnapshot['lists']>> = {
  done: 'done', 'no-work': 'noWork', partial: 'partial', error: 'error',
};

const snapshots = new Map<string, SiteSnapshot>();
/** Epoch ms da última foto gravada por site: a idade da foto é o que separa
 * "site zerado" de "sidecar não respondeu" no card. */
const snapshotTakenAt = new Map<string, number>();
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
  snapshotAt: (site) => snapshotTakenAt.get(site) ?? null,
  vitals: (site) => snapshots.get(site)?.vitals ?? null,
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
  // Falha de foto era engolida em silêncio e o card ficava "zerado" sem
  // explicação (magnets 0, última rodada —) com o sidecar de pé — token
  // ausente (401) e site desconhecido (400) eram indistinguíveis de site
  // sem acervo. O log.debug deixa o operador ver o porquê; o card fica com
  // a última foto (fail-open, mesma régua do streams-stats-native).
  const fail = (reason: string): void => {
    log.debug(`[crawl] foto de ${site} não gravou: ${reason}`);
  };
  try {
    const resp = await fetch(`http://127.0.0.1:${config.crawl.sidecarPort}/crawl/site-snapshot?${query}`, {
      signal: AbortSignal.timeout(config.crawl.sidecarStatusTimeoutMs),
      headers: config.jackett.testToken ? { 'X-Indexer-Test-Token': config.jackett.testToken } : {},
    });
    if (!resp.ok) {
      fail(`sidecar respondeu HTTP ${resp.status}`);
      return;
    }
    const body = await resp.json() as Partial<SiteSnapshot> | null;
    // Corpo fora do contrato não pode derrubar o painel: fica a foto anterior.
    if (body?.counters && body.lists && body.state) {
      snapshots.set(site, body as SiteSnapshot);
      snapshotTakenAt.set(site, Date.now());
    } else {
      fail('corpo fora do contrato do snapshot');
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
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
  snapshotTakenAt.clear();
}
