import { asyncRoute } from './async.js';
import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';

// CSS/JS extraídos dos HTML (Fase 3, PLANO_MELHORIAS §5.9). A lista é FECHADA
// de propósito: publicPath() junta o nome ao diretório público, então aceitar
// nome arbitrário vindo da URL abriria leitura fora de public/ (traversal).
const PAGE_ASSETS = [
  'configure.css',
  'configure-app.js',
  'dashboard.css',
  'dashboard-core.js',
  'dashboard-panels.js',
  'dashboard-status.js',
];

function makePublicHandlers(services: AppServices) {
  const sendConfigure = (_: express.Request, res: express.Response) => res.sendFile(services.publicPath('configure.html'));
  const sendDashboard = (_: express.Request, res: express.Response) => res.sendFile(services.publicPath('dashboard.html'));
  // Os HTML referenciam os assets por caminho absoluto porque a página responde
  // tanto em /configure quanto em /:userConfig/configure.
  const sendPageAsset = (name: string) => (_: express.Request, res: express.Response) => res.sendFile(services.publicPath(name));

  const defaults = asyncRoute(async (_req, res) => {
    const { debridApiKey, ...safe } = services.runtime.defaults();
    const jackettIndexers = await services.jackettCatalog.load();
    res.json({
      ...safe,
      jackettIndexersSelected: safe.jackettIndexers,
      jackettIndexers,
      debridApiKey: '',
      services: services.debrid.SERVICES,
      addonName: services.config.addonName,
      indexerTestEnabled: Boolean(services.config.jackett.testToken),
      sealKeyEnabled: services.secretBox.enabled(),
    });
  });

  const seal = (req: express.Request, res: express.Response) => {
    if (!services.secretBox.enabled()) {
      return res.status(503).json({ error: 'RESOLVE_SECRET não configurado' });
    }
    const admission = services.sealGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error });
    try {
      const sealed = services.runtime.sealSegment(String(req.body || '').trim());
      if (!sealed) return res.status(400).json({ error: 'configuração inválida' });
      return res.json({ segment: sealed });
    } finally {
      admission.release();
    }
  };

  return { sendConfigure, sendDashboard, sendPageAsset, pageAssets: PAGE_ASSETS, defaults, seal };
}

export { makePublicHandlers };
