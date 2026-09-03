import { asyncRoute } from './async.js';
import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';
import { dispatchDashboardAction } from './dashboard-actions.js';
import * as brCoverage from '../utils/br-coverage.js';
import { unavailable, makeStreamTraceHandler } from './stream-trace.js';

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
    // Fundo (colhedor, enriquecimento/varredura de cauda): sonda negativa da
    // descoberta, não custo do caminho de resposta. Os dois baldes não somam
    // "desperdício do usuário" — ler juntos era pintar o aquecimento do índice
    // como tempo que a resposta queimou.
    wastedQueriesBackground: counters['search.jackett.wastedQueries.background'] || 0,
    wastedMsBackground: counters['search.jackett.wastedMs.background'] || 0,
    accountSufficient: counters['search.account.sufficient'] || 0,
    fastPaths: counters['search.fastPath'] || 0,
  };
}

function accountTimeout(services: AppServices) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: 'timeout', error: 'timeout consultando o debrid' }),
      services.config.debrid.dashboardAccountTimeoutMs,
    );
    timer.unref?.();
  });
}

function makeDiagnosticHandlers(services: AppServices) {
  // Último probe de cada resolvedor (/test-resolver.json), SÓ em memória e
  // por instância de app: é estado do momento para o painel, não histórico —
  // reiniciou, volta sem campos e o próximo probe repinta. Vive na factory
  // (não no módulo) para não vazar entre instâncias de createApp nos testes.
  const lastResolverProbes = new Map<string, {
    // 'error' (não 'erro'): é o valor que o stateName() do painel reconhece —
    // um probe falho tem que acender vermelho no card, não voltar a cinza.
    status: 'ok' | 'error';
    checkedAt: string;
    lastMs: number;
    lastError: string | null;
    results: number | null;
  }>();

  const metrics = (req: express.Request, res: express.Response) => {
    if (unavailable(services, req, res, 'métricas desativadas: defina JACKETT_TEST_TOKEN')) return;
    const admission = services.diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error });
    try {
      return res.json({ ...services.metrics.snapshot(), logLevel: services.log.level(), cache: services.cache.snapshot() });
    } finally {
      admission.release();
    }
  };

  const dashboardStatus = asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'dashboard desativado: defina JACKETT_TEST_TOKEN')) return;
    const admission = services.diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error });
    try {
      const [account, indexers] = await Promise.all([
        Promise.race([services.debrid.accountStatus(), accountTimeout(services)]) as Promise<any>,
        services.jackettCatalog.load(),
      ]);
      const accounts = await services.debrid.dashboardAccounts(account);
      const metricSnapshot = services.metrics.snapshot();
      const hits = metricSnapshot.counters['cache.hit'] || 0;
      const misses = metricSnapshot.counters['cache.miss'] || 0;
      const metadataTiming = metricSnapshot.timers['search.metadata'];
      const memory = process.memoryUsage();
      const resolvers = services.brResolvers.RESOLVERS.map((resolver) => {
        // Medição do /test-resolver.json quando existe: ausente significa
        // "nunca medido neste processo" — inventar null/false aqui confundiria
        // nunca-medido com medição falha.
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
      const c1Counters = metricSnapshot.counters;
      return res.json({
        generatedAt: new Date().toISOString(),
        // Observabilidade I0: BR na primeira (e FRIA) resposta. `responses` é o
        // denominador — uma resposta por primeira build COLD concluída dentro
        // do prazo (SWR, prefetch e recaches tardios ficam de fora; build que
        // estourou o deadline cai no `search.deadline`). Mede por FONTES (não
        // buscas) e distingue "BR veio e foi ocultado" (brFound/brHidden) de
        // "BR nunca veio" (brFound baixo); brVisible é quanto realmente foi
        // entregue na abertura e brLate é só o DELTA positivo que os recaches
        // tardios agregam acima do máximo já visto (nunca o total repetido).
        // Pré-requisito de qualquer tuning no invariante 1
        // (PLANO_MELHORIAS: meça antes de mexer no orçamento).
        searchFirst: {
          responses: c1Counters['search.first.responses'] || 0,
          brFound: c1Counters['search.first.brFound'] || 0,
          brCached: c1Counters['search.first.brCached'] || 0,
          brHidden: c1Counters['search.first.brHidden'] || 0,
          brVisible: c1Counters['search.first.brVisible'] || 0,
          brLate: c1Counters['search.first.brLate'] || 0,
        },
        general: {
          ok: true,
          version: services.config.version,
          uptimeS: metricSnapshot.uptimeS,
          memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
          services: {
            addon: true,
            jackett: indexers.length > 0,
            debrid: Boolean(account?.ok),
            resolvers: resolvers.filter((item) => item.embedded).length,
          },
          search: {
            deadlineMetadata: metricSnapshot.counters['search.deadline.metadata'] || 0,
            deadlineProviders: metricSnapshot.counters['search.deadline.providers'] || 0,
            metadataAvgMs: metadataTiming?.avgMs ?? null,
            metadataP95Ms: metadataTiming?.p95Ms ?? null,
            metadataMaxMs: metadataTiming?.maxMs ?? null,
          },
        },
        metrics: metricSnapshot,
        cache: {
          ...services.cache.snapshot(),
          persistent: services.config.cache.persist,
          hits,
          misses,
          hitRate: hits + misses > 0 ? hits / (hits + misses) : null,
          swrServed: metricSnapshot.counters['search.swr.served'] || 0,
        },
        debrid: { active: services.debrid.current()?.id || null, account, accounts, services: services.debrid.SERVICES },
        autofetch: { ...services.autofetch.snapshot(), ...services.providers.autofetchStatus() },
        releaseIndex: releaseIndexStatus(services),
        harvest: services.harvester.status(),
        f3: brCoverage.status(),
        magnetdb: services.magnetdb.status(),
        catalog: services.debrid.catalogStatusEnv(),
        indexers: indexers.map((indexer: any) => ({
          ...indexer,
          breaker: services.jackett.breakerSnapshot(indexer.id),
          flagSlow: indexer.status?.state === 'slow',
        })),
        resolvers,
      });
    } finally {
      admission.release();
    }
  });

  // O guard de token fica aqui, na frente do despacho (PLANO_MELHORIAS §5.8):
  // 503/401 antes de qualquer leitura de ação. A allowlist, o `confirm` das
  // destrutivas e a execução por mapa de ações moram em dashboard-actions.ts.
  const dashboardAction = asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'dashboard desativado pelo operador', { ok: false })) return;
    await dispatchDashboardAction(services, req, res);
  });

  const testIndexer = asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'diagnóstico desativado pelo operador', { ok: false })) return;
    const admission = services.diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error });
    try {
      const id = String(req.query.id || '');
      const catalog = await services.jackettCatalog.load();
      if (!catalog.some((indexer) => indexer.id === id)) {
        return res.status(400).json({ ok: false, error: 'indexador desconhecido' });
      }
      const query = req.query.q ? String(req.query.q).slice(0, 80) : '';
      const type = req.query.type === 'series' ? 'series' : 'movie';
      return res.json(await services.jackett.test(id, query, type));
    } finally {
      admission.release();
    }
  });

  // Mesmo esqueleto do test-indexer: token no header (nunca ?token=), gate
  // global e 400 para id fora da lista. A diferença é o alvo: o resolvedor BR
  // embutido, medido direto (br-resolvers.probe) sem passar pelo Jackett —
  // por isso resultado é gravado no Map do painel e não em indexerStatus.
  const testResolver = asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'diagnóstico desativado pelo operador', { ok: false })) return;
    const admission = services.diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error });
    try {
      const id = String(req.query.id || '');
      const query = req.query.q ? String(req.query.q).slice(0, 80) : '';
      const probe = await services.brResolvers.probe(id, query);
      if (!probe) {
        return res.status(400).json({ ok: false, error: 'resolvedor desconhecido' });
      }
      lastResolverProbes.set(id, {
        status: probe.ok ? 'ok' : 'error',
        checkedAt: new Date().toISOString(),
        lastMs: probe.ms,
        lastError: probe.error,
        results: probe.results,
      });
      services.metrics.count(probe.ok ? 'resolvers.probe.ok' : 'resolvers.probe.fail');
      const payload: Record<string, unknown> = {
        resolver: probe.resolver,
        ok: probe.ok,
        results: probe.results,
        ms: probe.ms,
        host: probe.host,
      };
      if (probe.error) payload.error = probe.error;
      return res.json(payload);
    } finally {
      admission.release();
    }
  });

  const debridStatus = asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'diagnóstico desativado pelo operador', { ok: false })) return;
    const admission = services.diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error });
    try {
      const status = await Promise.race([services.debrid.accountStatus(), accountTimeout(services)]) as any;
      if (status?.service === 'realdebrid') {
        const rd = {
          ledger: services.rdLedger.status(),
          oracle: {
            enabled: services.config.debrid.rdOracle.enabled,
            stremthru: Boolean(services.config.debrid.rdOracle.stremthruUrl),
            torrentio: Boolean(services.config.debrid.rdOracle.torrentio),
          },
          gate: services.rdGate.status(),
          warm: services.rdWarmer.status(),
        };
        return res.json({ ...status, rd });
      }
      return res.json(status);
    } finally {
      admission.release();
    }
  });

  // P5 — /stream-trace.json (leitura offline + live read-only): handler
  // extraído para src/routes/stream-trace.ts ao estourar a catraca (dividir,
  // não bless). Contratos: recompute nunca reescreve/rede; live só TB/PM pelo
  // método cru, gateado por sonda (knob + kill-switch + conta); payload sem
  // streams/hash/chave.
  const streamTrace = makeStreamTraceHandler(services);

  return { metrics, dashboardStatus, dashboardAction, testIndexer, testResolver, debridStatus, streamTrace };
}

export { makeDiagnosticHandlers };
