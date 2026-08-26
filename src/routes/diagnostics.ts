import { asyncRoute } from './async.js';
import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';
import { errorMessage } from '../utils/logger.js';
import { streamsCacheScope } from '../utils/request-key.js';

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
      return res.json({
        generatedAt: new Date().toISOString(),
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
        magnetdb: services.magnetdb.status(),
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

  const dashboardAction = asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'dashboard desativado pelo operador', { ok: false })) return;
    const action = String(req.body?.action || '');
    if (!['sweep-dead', 'clear-cache', 'harvester-pause', 'harvester-drain', 'test-all-indexers', 'refresh-inventory', 'warm-pause', 'warm-resume', 'warm-drain'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'ação desconhecida' });
    }
    if (['clear-cache', 'sweep-dead'].includes(action) && req.body?.confirm !== true) {
      return res.status(400).json({ ok: false, error: 'confirmation_required' });
    }
    const admission = services.diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error });
    try {
      if (action === 'clear-cache') {
        const entriesBefore = services.cache.size();
        const scope = req.body?.scope;
        let removed = entriesBefore;
        let appliedScope: { kind: 'global' | 'namespace' | 'installation'; namespace?: string } = { kind: 'global' };
        if (scope != null) {
          if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
            return res.status(400).json({ ok: false, error: 'escopo de cache inválido' });
          }
          const namespace = typeof scope.namespace === 'string' ? scope.namespace : '';
          const installation = scope.installation === true;
          if (namespace && installation) {
            return res.status(400).json({ ok: false, error: 'escolha namespace ou instalação, não os dois' });
          }
          if (namespace) {
            if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(namespace)) {
              return res.status(400).json({ ok: false, error: 'namespace de cache inválido' });
            }
            removed = services.cache.clearNamespace(namespace);
            appliedScope = { kind: 'namespace', namespace };
          } else if (installation) {
            if (!services.runtime.prefix()) {
              return res.status(400).json({ ok: false, error: 'escopo por instalação exige URL configurada' });
            }
            const suffix = `:${streamsCacheScope(services.runtime.opts())}`;
            removed = services.cache.clearWhere((key) => key.startsWith('streams:') && key.endsWith(suffix));
            appliedScope = { kind: 'installation' };
          } else {
            return res.status(400).json({ ok: false, error: 'escopo de cache inválido' });
          }
        } else {
          services.cache.clear();
        }
        services.metrics.count('dashboard.cache.clear');
        return res.json({ ok: true, action, scope: appliedScope, removed, entriesBefore, entriesAfter: services.cache.size() });
      }
      if (action === 'harvester-pause') {
        const paused = services.harvester.setPaused(Boolean(req.body?.paused));
        services.metrics.count(paused ? 'dashboard.harvest.pause' : 'dashboard.harvest.resume');
        services.log.info(`[dashboard] colhedor ${paused ? 'pausado' : 'retomado'}`);
        return res.json({ ok: true, action, paused });
      }
      if (action === 'harvester-drain') {
        const result = await services.harvester.drain();
        services.metrics.count('dashboard.harvest.drain', result.drained);
        services.log.info(`[dashboard] fila do colhedor drenada: ${result.drained} obra(s)`);
        return res.json({ ok: true, action, ...result });
      }
      if (action === 'warm-pause') {
        services.rdWarmer.setPaused(true);
        services.metrics.count('dashboard.rd.warm.pause');
        services.log.info('[dashboard] warmer RD pausado');
        return res.json({ ok: true, action, paused: true });
      }
      if (action === 'warm-resume') {
        services.rdWarmer.setPaused(false);
        services.metrics.count('dashboard.rd.warm.resume');
        services.log.info('[dashboard] warmer RD retomado');
        return res.json({ ok: true, action, paused: false });
      }
      if (action === 'warm-drain') {
        const max = typeof req.body?.max === 'number' && Number.isFinite(req.body.max) && req.body.max > 0
          ? Math.trunc(req.body.max)
          : undefined;
        const result = await services.rdWarmer.drain(max);
        services.metrics.count('dashboard.rd.warm.drain', result.processed);
        services.log.info(`[dashboard] warmer RD drenado: ${result.processed} item(ns) processado(s), ${result.queueRemaining} restante(s)`);
        return res.json({ ok: true, action, ...result });
      }
      if (action === 'refresh-inventory') {
        const result = services.debrid.refreshInventory();
        services.metrics.count('dashboard.inventory.refresh');
        services.log.info(`[dashboard] memo de inventário invalidado: ${result.refreshed} conta(s)`);
        return res.json({ ok: true, action, ...result });
      }
      if (action === 'test-all-indexers') {
        const catalog = await services.jackettCatalog.load();
        const results: any[] = [];
        for (const indexer of catalog) {
          try {
            results.push({ id: indexer.id, ...(await services.jackett.test(indexer.id, '', 'movie')) });
          } catch (err: unknown) {
            results.push({ id: indexer.id, ok: false, error: errorMessage(err) });
          }
        }
        const okCount = results.filter((result) => result.ok).length;
        services.log.info(`[dashboard] teste sequencial de ${results.length} indexador(es) concluído`);
        services.metrics.count('dashboard.indexers.test-all');
        return res.json({ ok: true, action, results, total: results.length, okCount, downCount: results.length - okCount });
      }
      const result = (await services.debrid.sweepDeadCurrent()) ?? (await services.debrid.sweepDeadEnv());
      services.metrics.count('dashboard.sweep-dead');
      return res.json({
        ok: result != null,
        action,
        result,
        error: result == null ? 'varredura indisponível: o debrid ativo não implementa varredura, ou ela está desligada' : undefined,
      });
    } finally {
      admission.release();
    }
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
