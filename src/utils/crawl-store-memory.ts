// Estado da raspagem — ENGINE DE MEMÓRIA (fallback quando `node:sqlite` não
// existe no runtime (Node 20) ou o arquivo não abre). Irmã da engine de
// memória do banco de magnets: implementa os MESMOS verbos da SQL e consome as
// MESMAS regras puras (`crawl-store-rules.ts`), então o consumidor (motor,
// painel) não sabe qual engine está ativa.
//
// O teto existe pelo mesmo motivo do banco de magnets: esta engine só roda
// onde não há SQLite, e um `Map` ilimitado com o acervo de um site grande
// (comandotorrents: dezenas de milhares de URLs) cresceria até OOM. A ordem do
// próprio `Map` É a fila de eviction. Diferença honesta do banco de magnets:
// aqui evictar NÃO perde conhecimento permanente — a URL evictada reaparece no
// próximo ciclo de descoberta (o sitemap é re-lido), então a engine evicta a
// entrada mais antiga sem cerimônia e CONTA a evicção, para o status admitir
// a perda em vez de fingir persistência.
import type {
  CrawlErrorGroup,
  CrawlResultStatus,
  CrawlUrlRow,
  CrawlRunRow,
  ClearSiteReport,
  DiscoveredEntry,
  MarkOpts,
  MarkResultInput,
  SiteCounters,
  UpsertReport,
} from '../providers/crawl-types.js';
import type { CrawlEngine } from './crawl-store.js';
import { applyResult, decideUpsert, emptyCounters, parseStatus } from './crawl-store-rules.js';
import { crawlUrlKey } from './crawl-url-key.js';

/** Teto de URLs na engine de memória (entradas de ~200 B: ~20 MB no pior caso). */
const MEMORY_MAX_URLS = 100_000;
/** Rodadas são poucas por site; teto só por higiene (as mais antigas saem). */
const MEMORY_MAX_RUNS = 1000;

export function memoryCrawlEngine(): CrawlEngine {
  // Chave `site\0url_key`: a identidade é o CAMINHO (Fase 8), então a mesma
  // página em outro host é a MESMA entrada. A ordem de inserção do Map é a fila
  // de eviction.
  const urls = new Map<string, CrawlUrlRow>();
  /** `chave da linha → url_key`: o desempate do `takeNext`/`listByStatus` é pela
   * chave (paridade com o `ORDER BY url_key` do SQLite), e recalcular o caminho
   * de 100 mil URLs a cada tick seria o custo que a fila paga em todo claim. */
  const urlKeys = new Map<string, string>();
  const runs = new Map<number, CrawlRunRow>();
  /** Estado pequeno por site (cursor incremental) — MESMOS verbos da SQL. */
  const state = new Map<string, string>();
  let evictions = 0;
  let nextRunId = 1;

  const key = (site: string, url: string) => `${String(site || '')}\u0000${crawlUrlKey(url)}`;
  const stateKey = (site: string, k: string) => `${String(site || '')}\u0000${String(k || '')}`;

  const evictOldest = (): void => {
    while (urls.size > MEMORY_MAX_URLS) {
      const oldest = urls.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      urls.delete(oldest);
      urlKeys.delete(oldest);
      evictions += 1;
    }
  };

  return {
    kind: 'memory',
    memoryMax() { return MEMORY_MAX_URLS; },
    memoryEvictions() { return evictions; },
    upsertUrls(site, entries: readonly DiscoveredEntry[], now): UpsertReport {
      const s = String(site || '');
      const report: UpsertReport = { added: 0, refreshed: 0, unchanged: 0 };
      for (const entry of entries) {
        const k = key(s, entry.url);
        const { row, outcome } = decideUpsert(s, urls.get(k) ?? null, entry, now);
        // Upsert promove a recência (delete+set): mesma convenção do banco de
        // magnets — URL revisitada não é evictada como se fosse fria.
        urls.delete(k);
        urls.set(k, row);
        urlKeys.set(k, crawlUrlKey(row.url));
        report[outcome] += 1;
      }
      evictOldest();
      return report;
    },
    takeNext(site, now): CrawlUrlRow | null {
      const s = String(site || '');
      let best: CrawlUrlRow | null = null;
      let bestKey = '';
      for (const [k, row] of urls) {
        // MESMA elegibilidade da SQL: pending, partial com retry vencido, ou
        // error cujo backoff venceu.
        if (row.site !== s) continue;
        if (row.status !== 'pending' && row.status !== 'error' && row.status !== 'partial') continue;
        if (row.nextAt > now) continue;
        const uk = urlKeys.get(k) ?? row.url;
        // MESMA ordem da SQL: next_at, added_at, url_key — retomada determinística.
        if (!best
          || row.nextAt < best.nextAt
          || (row.nextAt === best.nextAt && row.addedAt < best.addedAt)
          || (row.nextAt === best.nextAt && row.addedAt === best.addedAt && uk < bestKey)) {
          best = row;
          bestKey = uk;
        }
      }
      if (!best) return null;
      const claimed: CrawlUrlRow = { ...best, status: 'inflight', checkedAt: now };
      urls.set(key(s, best.url), claimed);
      return claimed;
    },
    /**
     * MESMA elegibilidade do `takeNext` acima, respondida sem reivindicar. É o
     * que a engine de memória entrega ao motor como verdade: quem só contava
     * status tratava `inflight` e linha em backoff como fila, o seletor escolhia
     * "item" e o passo virava no-op — aqui o `inflight` é trabalho tomado (a
     * órfã é do `requeueInflight`) e o backoff ainda não venceu.
     */
    hasDue(site, now): boolean {
      const s = String(site || '');
      for (const row of urls.values()) {
        if (row.site !== s) continue;
        if (row.status !== 'pending' && row.status !== 'error' && row.status !== 'partial') continue;
        if (row.nextAt <= now) return true;
      }
      return false;
    },
    getUrl(site, url) { return urls.get(key(site, url)) ?? null; },
    markResult(site, url, result: MarkResultInput, now, opts: MarkOpts = {}): void {
      const k = key(site, url);
      const existing = urls.get(k);
      if (!existing) return;
      urls.set(k, applyResult(existing, result, now, opts));
    },
    requeueInflight(site, olderThanMs, now): number {
      const s = String(site || '');
      let n = 0;
      for (const [k, row] of urls) {
        if (row.site !== s || row.status !== 'inflight' || row.checkedAt > now - olderThanMs) continue;
        urls.set(k, { ...row, status: 'pending', nextAt: 0 });
        n += 1;
      }
      return n;
    },
    requeueErrors(site, status = 'error'): number {
      const s = String(site || '');
      let n = 0;
      for (const [k, row] of urls) {
        if (row.site !== s || row.status !== status) continue;
        // MESMA SQL: o escape do estagnado limpa progresso (recomeça do zero).
        urls.set(k, { ...row, status: 'pending', tries: 0, nextAt: 0, error: '', progress: '' });
        n += 1;
      }
      return n;
    },
    requeueSimulated(site): number {
      const s = String(site || '');
      let n = 0;
      for (const [k, row] of urls) {
        // MESMA SQL: `simulated` OU QUALQUER linha com progresso seco
        // (`"dry":1`) — error/pending/inflight/partial — é resetada do zero
        // (resume de passe que não gravava pularia cards nunca gravados).
        // `releases: 0` junto: a contagem seca é DESCOBERTA, não gravação —
        // somar à releitura ao vivo duplicaria o total do painel.
        // Idempotente: o reset limpa o `progress`; linha seca ao vivo fica.
        const dryProgress = row.progress.includes('"dry":1');
        if (row.site !== s || (row.status !== 'simulated' && !dryProgress)) continue;
        urls.set(k, { ...row, status: 'pending', tries: 0, nextAt: 0, error: '', releases: 0, progress: '' });
        n += 1;
      }
      return n;
    },
    requeueUrl(site, url): boolean {
      const k = key(site, url);
      const row = urls.get(k);
      if (!row) return false;
      urls.set(k, { ...row, status: 'pending', nextAt: 0 });
      return true;
    },
    counters(site): SiteCounters {
      const s = String(site || '');
      const byStatus = emptyCounters();
      let total = 0;
      for (const row of urls.values()) {
        if (row.site !== s) continue;
        byStatus[parseStatus(row.status)] += 1;
        total += 1;
      }
      return { total, byStatus };
    },
    listByStatus(site, status: CrawlResultStatus, limit) {
      const s = String(site || '');
      const cap = Math.max(0, Math.trunc(Number(limit) || 0));
      if (cap <= 0) return [];
      const rows: Array<{ row: CrawlUrlRow; key: string }> = [];
      for (const [k, row] of urls) {
        if (row.site !== s || row.status !== status) continue;
        rows.push({ row, key: urlKeys.get(k) ?? row.url });
      }
      // MESMA ordem da SQL: `checked_at` desc, url_key asc.
      rows.sort((a, b) => (b.row.checkedAt - a.row.checkedAt)
        || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return rows.slice(0, cap).map((r) => r.row);
    },
    errorGroups(site, limit): CrawlErrorGroup[] {
      const s = String(site || '');
      const cap = Math.max(0, Math.trunc(Number(limit) || 0));
      if (cap <= 0) return [];
      const counts = new Map<string, number>();
      for (const row of urls.values()) {
        if (row.site !== s || row.status !== 'error') continue;
        const reason = row.error || 'erro';
        counts.set(reason, (counts.get(reason) || 0) + 1);
      }
      return [...counts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason))
        .slice(0, cap);
    },
    sumReleases(site): number {
      const s = String(site || '');
      let total = 0;
      for (const row of urls.values()) if (row.site === s) total += row.releases || 0;
      return total;
    },
    clearSite(site): ClearSiteReport {
      const s = String(site || '');
      let removedUrls = 0;
      for (const [k, row] of [...urls]) {
        if (row.site !== s) continue;
        urls.delete(k);
        removedUrls += 1;
      }
      let removedRuns = 0;
      for (const [id, run] of [...runs]) {
        if (run.site !== s) continue;
        runs.delete(id);
        removedRuns += 1;
      }
      // MESMA regra da SQL: cursor do site sai junto (é estado daquele site).
      for (const k of [...state.keys()]) {
        if (k.split('\u0000')[0] === s) state.delete(k);
      }
      return { urls: removedUrls, runs: removedRuns };
    },
    startRun(site, phase, cursor, now): number {
      const row: CrawlRunRow = {
        id: nextRunId++,
        site: String(site || ''),
        phase: phase === 'incremental' ? 'incremental' : 'initial',
        cursor: String(cursor || ''),
        startedAt: now,
        finishedAt: null,
        counters: {},
      };
      runs.set(row.id, row);
      while (runs.size > MEMORY_MAX_RUNS) {
        const oldest = Math.min(...runs.keys());
        runs.delete(oldest);
      }
      return row.id;
    },
    finishRun(runId, now, counters): void {
      const row = runs.get(runId);
      if (!row) return;
      row.finishedAt = now;
      row.counters = { ...(counters ?? {}) };
    },
    latestRun(site): CrawlRunRow | null {
      const s = String(site || '');
      let best: CrawlRunRow | null = null;
      for (const row of runs.values()) {
        if (row.site !== s) continue;
        if (!best || row.startedAt > best.startedAt || (row.startedAt === best.startedAt && row.id > best.id)) best = row;
      }
      return best;
    },
    getState(site, k) {
      const v = state.get(stateKey(site, k));
      return v === undefined ? null : v;
    },
    setState(site, k, value) {
      state.set(stateKey(site, k), String(value ?? ''));
    },
    clearRows() { urls.clear(); urlKeys.clear(); runs.clear(); state.clear(); },
    closeEngine() { urls.clear(); urlKeys.clear(); runs.clear(); state.clear(); },
  };
}
