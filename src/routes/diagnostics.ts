import { asyncRoute } from './async.js';
import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';
import { dispatchDashboardAction } from './dashboard-actions.js';
import * as brCoverage from '../utils/br-coverage.js';

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
    accountSufficient: counters['search.account.sufficient'] || 0,
    fastPaths: counters['search.fastPath'] || 0,
  };
}

function unavailable(services: AppServices, req: express.Request, res: express.Response, message: string, shape: Record<string, unknown> = {}) {
  if (!services.config.jackett.testToken) {
    res.status(503).json({ ...shape, error: message });
    return true;
  }
  if (!services.authorized(services.config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
    res.status(401).json({ ...shape, error: 'token de diagnóstico inválido' });
    return true;
  }
  return false;
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
      const resolvers = services.brResolvers.RESOLVERS.map((resolver) => ({
        id: resolver.name,
        label: resolver.name,
        port: resolver.port + services.config.resolvers.portOffset,
        embedded: services.config.resolvers.embedded,
        domain: services.brResolvers.activeSite(resolver.name),
      }));
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

  return { metrics, dashboardStatus, dashboardAction, testIndexer, debridStatus };
}

export { makeDiagnosticHandlers };
