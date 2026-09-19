import { asyncRoute } from './async.js';
import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';
import { dispatchDashboardAction } from './dashboard-actions.js';
import * as brCoverage from '../utils/br-coverage.js';
import { unavailable, makeStreamTraceHandler } from './stream-trace.js';
import { computeStatusPayload, accountTimeout } from './dashboard-status-blocks.js';

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
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error, reason: admission.reason });
    try {
      return res.json({ ...services.metrics.snapshot(), logLevel: services.log.level(), cache: services.cache.snapshot() });
    } finally {
      admission.release();
    }
  };

  const dashboardStatus = asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'dashboard desativado: defina JACKETT_TEST_TOKEN')) return;
    const admission = services.diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error, reason: admission.reason });
    try {
      const blocosParam = req.query.blocos != null ? String(req.query.blocos) : null;
      const result = await computeStatusPayload({ services, lastResolverProbes }, blocosParam);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error, allowed: result.allowed });
      }
      return res.json(result.data);
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
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error, reason: admission.reason });
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
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error, reason: admission.reason });
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
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error, reason: admission.reason });
    try {
      const status = await accountTimeout(services, services.debrid.accountStatus()) as any;
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
