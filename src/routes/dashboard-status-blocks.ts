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

type MetricSnapshot = ReturnType<AppServices['metrics']['snapshot']>;

function releaseIndexStatus(services: AppServices, counters: MetricSnapshot['counters']) {
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

interface TimeoutPayload {
  ok: false;
  reason: 'timeout';
  error: string;
  service?: string;
  label?: string;
  fix?: string;
}

/**
 * Corre `operation` contra o prazo do painel e LIMPA o timer quando a operação
 * vence. Sem o clear, o timeout continuava armado (unref só evita segurar o
 * processo, não o disparo) e um `accountStatus` que responde rápido deixava
 * um timer pendente por requisição.
 */
export function accountTimeout<T>(services: AppServices, operation: Promise<T>): Promise<T | TimeoutPayload> {
  const adapter = services.debrid.current?.() || null;
  return new Promise<T | TimeoutPayload>((resolve, reject) => {
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
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
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

export interface ContaBlockOptions {
  cap: number;
  warnAt: number;
  service?: string | null;
  label?: string | null;
}

/**
 * Bloco `conta` (puro, para teste). `oldestAt` é o magnet mais antigo da CONTA
 * inteira — prontos incluídos. É contexto de ocupação, NÃO prova de download
 * preso: um magnet pronto e antigo tem a mesma idade de um download travado.
 * Derivar "preso >24h" daqui (como a versão anterior fazia com `stuckCount`)
 * acendia o alerta em conta saudável; a evidência ativa por item não existe
 * neste contrato sem consulta extra, então o bloco não afirma nada disso.
 */
export function contaBlock(account: any, opts: ContaBlockOptions) {
  const total = Number(account?.magnets || 0);
  const ready = Number(account?.ready || 0);
  const downloading = Number(account?.active || 0);
  const dead = Number(account?.error || 0);

  return {
    ok: Boolean(account?.ok),
    service: account?.service || opts.service || null,
    label: account?.label || opts.label || null,
    total,
    ready,
    downloading,
    dead,
    cap: opts.cap,
    warnAt: opts.warnAt,
    usagePercent: opts.cap > 0 ? Math.round((total / opts.cap) * 100) : 0,
    oldestAt: account?.oldestAt || null,
  };
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

  // Snapshot de métricas memoizado por ciclo de requisição: cada bloco que lê
  // contadores/timers chamava `snapshot()` de novo (até 5 vezes por request
  // completo, cada uma ordenando os anéis de amostra). Os blocos são coerentes
  // o suficiente dividindo a MESMA foto, e o custo cai para uma leitura.
  let memoMetrics: MetricSnapshot | null = null;
  const getMetrics = (): MetricSnapshot => {
    if (!memoMetrics) memoMetrics = services.metrics.snapshot();
    return memoMetrics;
  };

  // Lazy loaders memoizados por ciclo de requisição
  let memoAccount: Promise<any> | null = null;
  const getAccount = () => {
    if (!memoAccount) {
      memoAccount = accountTimeout(services, services.debrid.accountStatus()) as Promise<any>;
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

  // Bloco: general. Vem ANTES do searchFirst de propósito: `getIndexers()` lê o
  // catálogo e essa leitura conta `cache.miss`; o snapshot memoizado precisa
  // nascer DEPOIS dela para o bloco `cache` continuar enxergando a leitura que
  // a própria requisição fez — como enxergava quando cada bloco tirava a
  // própria foto.
  if (isReq('general')) {
    const memory = process.memoryUsage();
    const [account, indexers] = await Promise.all([getAccount(), getIndexers()]);
    const metricSnapshot = getMetrics();
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

  // Bloco: searchFirst (KPI I0). Usa a mesma foto do general quando ele roda.
  if (isReq('searchFirst')) {
    const counters = getMetrics().counters;
    out.searchFirst = {
      responses: counters['search.first.responses'] || 0,
      brFound: counters['search.first.brFound'] || 0,
      brCached: counters['search.first.brCached'] || 0,
      brHidden: counters['search.first.brHidden'] || 0,
      brVisible: counters['search.first.brVisible'] || 0,
      brLate: counters['search.first.brLate'] || 0,
    };
  }

  // Bloco: metrics
  if (isReq('metrics')) {
    out.metrics = getMetrics();
  }

  // Bloco: cache
  if (isReq('cache')) {
    const metricSnapshot = getMetrics();
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
    out.releaseIndex = releaseIndexStatus(services, getMetrics().counters);
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

  // Bloco novo: conta (total, ready, downloading, dead, cap, warnAt, idade do
  // magnet mais antigo). Sem inferência de "preso" — ver contaBlock.
  if (isReq('conta')) {
    const account = await getAccount();
    const adapter = services.debrid.current();
    out.conta = contaBlock(account, {
      cap: services.config.debrid.accountCap || 1000,
      warnAt: services.config.debrid.accountWarnTotal || 800,
      service: adapter?.id || null,
      label: adapter?.label || null,
    });
  }

  // Bloco gate: divergências ao vivo do Chupim E do Colhedor, cada uma com o
  // dono (`owner`) para o painel abrir a aba certa e focar o `cfg-field`. O dono
  // vem da config que listou a chave — nada hardcoded no cliente. `paused`/
  // `pausedSince` são estado de controle (botão), não campo de formulário.
  if (isReq('gate')) {
    const afSnap = services.autofetchLive.snapshot();
    const hSnap = services.harvesterLive.snapshot();
    const diffs: Array<{ key: string; owner: string; effective: unknown; envDefault: unknown }> = [];
    const seenKeys = new Set<string>();
    for (const [owner, snap] of [['chupim', afSnap], ['colhedor', hSnap]] as const) {
      for (const key of snap.overriddenKeys) {
        if (key === 'paused' || key === 'pausedSince' || seenKeys.has(key)) continue;
        seenKeys.add(key);
        diffs.push({
          key,
          owner,
          effective: (snap.effective as any)[key],
          envDefault: (snap.envDefaults as any)[key],
        });
      }
    }

    out.gate = {
      effective: afSnap.effective,
      envDefaults: afSnap.envDefaults,
      overriddenKeys: afSnap.overriddenKeys,
      diffs: diffs.sort((a, b) => a.key.localeCompare(b.key)),
      fieldOwner: Object.fromEntries(diffs.map((d) => [d.key, d.owner] as const)),
      paused: afSnap.paused,
      pausedSince: afSnap.pausedSince,
      autoFetchPauseAt: afSnap.effective.autoFetchPauseAt,
      envAutoFetchPauseAt: afSnap.envDefaults.autoFetchPauseAt,
      isAutoFetchPauseAtOverridden: afSnap.overriddenKeys.includes('autoFetchPauseAt'),
    };
  }

  return { ok: true, data: out };
}
