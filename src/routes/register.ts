import express from 'express';
import { makePublicHandlers } from './public.js';
import { makeDiagnosticHandlers } from './diagnostics.js';
import { makeResolveHandler } from './resolve.js';
import { originOf } from './origin.js';
import { makeAddonRouter } from './addon-router.js';
import type { AddonInterface } from './addon-router.js';
import type { AppServices } from './types.js';

/**
 * Único ponto que monta rotas. A sequência abaixo é contrato: o SDK sem
 * configuração vem antes do overlay, e as rotas específicas vêm antes do SDK
 * com configuração.
 */
function registerRoutes(app: express.Express, services: AppServices, addonInterface: AddonInterface) {
  const publicHandlers = makePublicHandlers(services);
  const diagnosticHandlers = makeDiagnosticHandlers(services);
  const resolveHandler = makeResolveHandler(services);

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/logo.svg', (_req, res) => res.sendFile(services.publicPath('logo.svg')));
  app.get('/logo.png', (_req, res) => res.sendFile(services.publicPath('logo.png')));
  // Assets das páginas (CSS/JS extraídos do HTML inline — Fase 3, §5.9). Rotas
  // explícitas com nome em allowlist, no mesmo padrão do logo; caminho absoluto
  // no HTML porque a página responde em /configure e em /:userConfig/configure.
  for (const asset of publicHandlers.pageAssets) {
    app.get(`/${asset}`, publicHandlers.sendPageAsset(asset));
  }
  app.get('/', (_req, res) => res.redirect(302, '/configure'));
  app.get('/configure', publicHandlers.sendConfigure);
  app.get('/dashboard', publicHandlers.sendDashboard);
  app.get('/autofetch', (_req, res) => res.redirect(302, '/dashboard#autofetch'));
  app.get('/harvester', (_req, res) => res.redirect(302, '/dashboard#colhedor'));
  app.get('/defaults.json', publicHandlers.defaults);
  app.post('/seal-config', express.text({ type: () => true, limit: '16kb' }), publicHandlers.seal);

  app.get('/metrics.json', diagnosticHandlers.metrics);
  app.get('/dashboard-status.json', diagnosticHandlers.dashboardStatus);
  app.post('/dashboard-action.json', express.json({ limit: '4kb' }), diagnosticHandlers.dashboardAction);
  app.get('/test-indexer.json', diagnosticHandlers.testIndexer);
  app.get('/debrid-status.json', diagnosticHandlers.debridStatus);
  app.get('/resolve/:infoHash', resolveHandler);

  app.use((req, _res, next) => services.runtime.run({ origin: originOf(req) }, () => next()));
  app.use(makeAddonRouter(addonInterface));

  app.use('/:userConfig', (req, res, next) => {
    const parsed = services.runtime.decode(req.params.userConfig);
    if (!parsed) return res.status(404).send('configuração inválida');
    services.runtime.run({ opts: parsed, encoded: req.params.userConfig }, () => next());
  });

  app.get('/:userConfig/configure', publicHandlers.sendConfigure);
  app.get('/:userConfig/debrid-status.json', diagnosticHandlers.debridStatus);
  app.get('/:userConfig/dashboard', publicHandlers.sendDashboard);
  app.get('/:userConfig/autofetch', (req, res) => res.redirect(302, `/${req.params.userConfig}/dashboard#autofetch`));
  app.get('/:userConfig/harvester', (req, res) => res.redirect(302, `/${req.params.userConfig}/dashboard#colhedor`));
  app.get('/:userConfig/dashboard-status.json', diagnosticHandlers.dashboardStatus);
  app.post('/:userConfig/dashboard-action.json', express.json({ limit: '4kb' }), diagnosticHandlers.dashboardAction);
  app.get('/:userConfig/test-indexer.json', diagnosticHandlers.testIndexer);
  app.get('/:userConfig/metrics.json', diagnosticHandlers.metrics);
  app.get('/:userConfig/resolve/:infoHash', resolveHandler);
  app.use('/:userConfig', makeAddonRouter(addonInterface));
}

export { registerRoutes };
