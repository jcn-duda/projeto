import type { AppServices } from './types.js';
import * as brCoverage from '../utils/br-coverage.js';

export const ALL_BLOCKS = [
  'general',
  'searchFirst',
  'metrics',
  'cache',
  'debrid',
  'autofetch',
  'releaseIndex',
  'harvest',
  'f3',
  'magnetdb',
  'catalog',
  'indexers',
  'resolvers',
  'conta',
  'gate',
] as const;

export type BlockName = (typeof ALL_BLOCKS)[number];
const BLOCK_SET = new Set<string>(ALL_BLOCKS);

function releaseIndexStatus(services: AppServices) {
  const counters = services.metrics.snapshot().counters;
  return {
    ...services.releaseIndex.status(),
    hits: counters['search.idx.hit'] || 0,
    misses: counters['search.idx.miss'] || 0,
    gaps: counters['search.idx.gap'] || 0,
    servedReleases: counters['search.idx.served'] || 0,
    recordedReleases: counters['search.idx.recorded'] || 0,
    wouldHit: counters['search.idx.wouldHit'] || 0,
    wouldMiss: counters['search.idx.wouldMiss'] || 0,
    wastedQueries: counters['search.jackett.wastedQueries'] || 0,
    wastedMs: counters['search.jackett.wastedMs'] || 0,
    wastedQueriesBackground: counters['search.jackett.wastedQueries.background'] || 0,
    wastedMsBackground: counters['search.jackett.wastedMs.background'] || 0,
    accountSufficient: counters['search.account.sufficient'] || 0,
    fastPaths: counters['search.fastPath'] || 0,
  };
}

export function accountTimeout(services: AppServices) {
  const adapter = services.debrid.current?.() || null;
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({
        ok: false,
        reason: 'timeout',
        error: 'timeout consultando o debrid',
        ...(adapter ? {
          service: adapter.id,
          label: adapter.label,
          fix: 'o serviço não respondeu dentro do prazo do painel; tente de novo — persistindo, o serviço está instável ou a rede está lenta',
        } : {}),
      }),
      services.config.debrid.dashboardAccountTimeoutMs,
    );
    timer.unref?.();
  });
}

function jackettServiceFlag(indexers: { length: number; source?: string }): boolean | 'naomedido' {
  if (indexers?.source !== 'live') return 'naomedido';
  return indexers.length > 0;
}

export interface BlockContext {
  services: AppServices;
  lastResolverProbes: Map<string, any>;
  requestedBlocks?: Set<string>;
}

export async function computeStatusPayload(
  ctx: BlockContext,
  blocosParam?: string | null,
): Promise<{ ok: true; data: Record<string, any> } | { ok: false; status: number; error: string; allowed: readonly string[] }> {
  const { services, lastResolverProbes } = ctx;

  let requested: string[] | null = null;
  if (blocosParam != null && String(blocosParam).trim() !== '') {
    const rawList = String(blocosParam)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const name of rawList) {
      if (!BLOCK_SET.has(name)) {
        return {
          ok: false,
          status: 400,
          error: `bloco desconhecido: "${name}"`,
          allowed: ALL_BLOCKS,
        };
      }
    }
    requested = rawList;
  }

  const reqSet = requested ? new Set<string>(requested) : null;
  const isReq = (name: string) => reqSet === null || reqSet.has(name);

  // Lazy loaders memoizados por ciclo de requisição
  let memoAccount: Promise<any> | null = null;
  const getAccount = () => {
    if (!memoAccount) {
      memoAccount = Promise.race([services.debrid.accountStatus(), accountTimeout(services)]) as Promise<any>;
    }
    return memoAccount;
  };

  let memoIndexers: Promise<any> | null = null;
  const getIndexers = () => {
    if (!memoIndexers) {
      memoIndexers = services.jackettCatalog.load();
    }
    return memoIndexers;
  };

  const out: Record<string, any> = {
    generatedAt: new Date().toISOString(),
  };

  if (requested) {
    out.blocos = requested;
  }

  // Bloco: searchFirst
  if (isReq('searchFirst')) {
    const counters = services.metrics.snapshot().counters;
    out.searchFirst = {
      responses: counters['search.first.responses'] || 0,
      brFound: counters['search.first.brFound'] || 0,
      brCached: counters['search.first.brCached'] || 0,
      brHidden: counters['search.first.brHidden'] || 0,
      brVisible: counters['search.first.brVisible'] || 0,
      brLate: counters['search.first.brLate'] || 0,
    };
  }

  // Bloco: general
  if (isReq('general')) {
    const metricSnapshot = services.metrics.snapshot();
    const memory = process.memoryUsage();
    const [account, indexers] = await Promise.all([getAccount(), getIndexers()]);
    const resolvers = services.brResolvers.RESOLVERS;
    const metadataTiming = metricSnapshot.timers['search.metadata'];

    out.general = {
      ok: true,
      version: services.config.version,
      uptimeS: metricSnapshot.uptimeS,
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
      services: {
        addon: true,
        jackett: jackettServiceFlag(indexers),
        debrid: Boolean(account?.ok),
        resolvers: services.config.resolvers.embedded ? resolvers.length : 0,
      },
      search: {
        deadlineMetadata: metricSnapshot.counters['search.deadline.metadata'] || 0,
        deadlineProviders: metricSnapshot.counters['search.deadline.providers'] || 0,
        metadataAvgMs: metadataTiming?.avgMs ?? null,
        metadataP95Ms: metadataTiming?.p95Ms ?? null,
        metadataMaxMs: metadataTiming?.maxMs ?? null,
      },
    };
  }

  // Bloco: metrics
  if (isReq('metrics')) {
    out.metrics = services.metrics.snapshot();
  }

  // Bloco: cache
  if (isReq('cache')) {
    const metricSnapshot = services.metrics.snapshot();
    const hits = metricSnapshot.counters['cache.hit'] || 0;
    const misses = metricSnapshot.counters['cache.miss'] || 0;
    out.cache = {
      ...services.cache.snapshot(),
      persistent: services.config.cache.persist,
      l2: services.cache.l2Stats(),
      hits,
      misses,
      hitRate: hits + misses > 0 ? hits / (hits + misses) : null,
      swrServed: metricSnapshot.counters['search.swr.served'] || 0,
    };
  }

  // Bloco: debrid
  if (isReq('debrid')) {
    const account = await getAccount();
    const accounts = await services.debrid.dashboardAccounts(account);
    out.debrid = {
      active: services.debrid.current()?.id || null,
      account,
      accounts,
      services: services.debrid.SERVICES,
    };
  }

  // Bloco: autofetch
  if (isReq('autofetch')) {
    out.autofetch = {
      ...services.autofetch.snapshot(),
      ...services.providers.autofetchStatus(),
    };
  }

  // Bloco: releaseIndex
  if (isReq('releaseIndex')) {
    out.releaseIndex = releaseIndexStatus(services);
  }

  // Bloco: harvest
  if (isReq('harvest')) {
    out.harvest = {
      ...services.harvester.status(),
      debridAccount: services.harvesterDebrid.snapshot(),
      debridResolved: services.harvesterDebrid.resolveQuota()?.adapter?.id ?? null,
    };
  }

  // Bloco: f3
  if (isReq('f3')) {
    out.f3 = brCoverage.status();
  }

  // Bloco: magnetdb
  if (isReq('magnetdb')) {
    out.magnetdb = services.magnetdb.status();
  }

  // Bloco: catalog
  if (isReq('catalog')) {
    out.catalog = services.debrid.catalogStatusEnv();
  }

  // Bloco: indexers
  if (isReq('indexers')) {
    const indexers = await getIndexers();
    out.indexers = indexers.map((indexer: any) => ({
      ...indexer,
      breaker: services.jackett.breakerSnapshot(indexer.id),
      flagSlow: indexer.status == null ? null : indexer.status.state === 'slow',
    }));
  }

  // Bloco: resolvers
  if (isReq('resolvers')) {
    out.resolvers = services.brResolvers.RESOLVERS.map((resolver) => {
      const last = lastResolverProbes.get(resolver.name);
      return {
        id: resolver.name,
        label: resolver.name,
        port: resolver.port + services.config.resolvers.portOffset,
        embedded: services.config.resolvers.embedded,
        domain: services.brResolvers.activeSite(resolver.name),
        ...(last ? {
          status: last.status,
          checkedAt: last.checkedAt,
          lastMs: last.lastMs,
          lastError: last.lastError,
          results: last.results,
        } : {}),
      };
    });
  }

  // Bloco novo: conta (total, ready, downloading, dead, cap, warnAt, idade mais antiga, presos)
  if (isReq('conta')) {
    const account = await getAccount();
    const cap = services.config.debrid.accountCap || 1000;
    const warnAt = services.config.debrid.accountWarnTotal || 800;
    const total = Number(account?.magnets || 0);
    const ready = Number(account?.ready || 0);
    const downloading = Number(account?.active || 0);
    const dead = Number(account?.error || 0);
    const oldestAt = account?.oldestAt || null;
    const oldestAgeMs = oldestAt ? Math.max(0, Date.now() - (oldestAt > 1e11 ? oldestAt : oldestAt * 1000)) : null;

    out.conta = {
      ok: Boolean(account?.ok),
      service: account?.service || services.debrid.current()?.id || null,
      label: account?.label || services.debrid.current()?.label || null,
      total,
      ready,
      downloading,
      dead,
      cap,
      warnAt,
      usagePercent: cap > 0 ? Math.round((total / cap) * 100) : 0,
      oldestAt,
      oldestAgeMs,
      stuckCount: downloading > 0 && oldestAgeMs && oldestAgeMs > 86_400_000 ? 1 : 0,
    };
  }

  // Bloco novo: gate (effective vs envDefaults vs overriddenKeys com diff do servidor)
  if (isReq('gate')) {
    const afSnap = services.autofetchLive.snapshot();
    const effective = afSnap.effective;
    const envDefaults = afSnap.envDefaults;
    const overriddenKeys = afSnap.overriddenKeys;
    const diffs = overriddenKeys.map((key: string) => ({
      key,
      effective: (effective as any)[key],
      envDefault: (envDefaults as any)[key],
    }));

    out.gate = {
      effective,
      envDefaults,
      overriddenKeys,
      diffs,
      paused: afSnap.paused,
      pausedSince: afSnap.pausedSince,
      autoFetchPauseAt: effective.autoFetchPauseAt,
      envAutoFetchPauseAt: envDefaults.autoFetchPauseAt,
      isAutoFetchPauseAtOverridden: overriddenKeys.includes('autoFetchPauseAt'),
    };
  }

  return { ok: true, data: out };
}
