import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
  // Teste pontual de conta de debrid (Fase 1): módulo próprio extraído de
  // dashboard-panels.js ao se aproximar do teto de 400 linhas da catraca.
  'dashboard-debrid-test.js',
];

function makePublicHandlers(services: AppServices) {
  // Fingerprint do CONTEÚDO dos assets (e não da versão do package/manifest,
  // que não muda a cada deploy): a URL só muda quando o arquivo muda. Restart
  // sem rebuild mantém a URL e o cache do cliente continua válido — que é o
  // correto; deploy que muda o asset muda a URL junto. Lido uma vez por app:
  // o addon serve de dist/ e os arquivos não mudam no decorrer do processo.
  const fingerprint = createHash('sha256');
  for (const name of PAGE_ASSETS) {
    fingerprint.update(fs.readFileSync(services.publicPath(name)));
  }
  const assetVersion = fingerprint.digest('hex').slice(0, 10);

  // O HTML sai da memória, sempre fresco, referenciando os assets com
  // ?v=<hash>. É isso que elimina o skew de deploy: HTML novo só aponta para
  // URLs que o cache do browser ainda não tem — impossível emparelhar HTML
  // novo com módulo velho, num acoplamento que anda nos dois sentidos (o
  // inline chama funções dos módulos; os módulos buscam IDs declarados no HTML).
  const sendVersionedHtml = (name: string) => {
    const html = fs
      .readFileSync(services.publicPath(name), 'utf8')
      // A aspa de fechamento faz parte do PADRÃO (e não só da substituição):
      // sem ela o match parava no `.css` sem consumir a aspa, a substituição
      // acrescentava outra e o HTML saía `href="/dashboard.css?v=abc""` — o
      // navegador recuperava, mas criava um atributo espúrio chamado `"` em
      // cada uma das 4 tags. Casar a aspa também ancora o fim real do valor.
      .replace(/((?:src|href)="\/(?:configure|dashboard)[-\w]*\.(?:css|js))"/g, `$1?v=${assetVersion}"`);
    return (_: express.Request, res: express.Response) => res.type('html').send(html);
  };
  const sendConfigure = sendVersionedHtml('configure.html');
  const sendDashboard = sendVersionedHtml('dashboard.html');

  // Os HTML referenciam os assets por caminho absoluto porque a página responde
  // tanto em /configure quanto em /:userConfig/configure. maxAge ALTO é seguro
  // porque a URL carrega o hash do conteúdo (?v= acima): o cache só devolve o
  // byte-idêntico. A rota ignora a query — o Express casa pelo path, então
  // `?v=` não precisa (e não deve) constar da allowlist.
  const sendPageAsset = (name: string) => (_: express.Request, res: express.Response) =>
    res.sendFile(services.publicPath(name), { maxAge: '30d' });

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
