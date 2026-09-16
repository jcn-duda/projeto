import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { asyncRoute } from './async.js';
import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';

// CSS dos painéis (Fase 3, PLANO_MELHORIAS §5.9). A lista é FECHADA de propósito:
// publicPath() junta o nome ao diretório público, então aceitar nome arbitrário
// vindo da URL abriria leitura fora de public/ (traversal). O JS dos painéis saiu
// de src/public: /configure e /dashboard agora são ESM nativo emitido por
// tsconfig.client.json, servido pela CLIENT_ASSETS abaixo.
const PAGE_ASSETS = [
  'configure.css',
  'configure-components.css',
  'dashboard-tokens.css',
  'dashboard.css',
  'painel-tokens.css',
  'painel.css',
];

// Entry e filhos dos clientes ESM (/configure, /dashboard e /painel; fontes em
// src/client/<nome>, emitidos por tsconfig.client.json para
// dist/src/public/client/). A lista é FECHADA: o caminho vem da URL e é juntado
// ao diretório público — nome arbitrário abriria leitura fora de public/
// (traversal). Os entries, com o ?v= corrente, vão immutable; os filhos saem
// no-cache para o ETag/304 pegar o deploy-skew sem congelar módulo velho.
const CLIENT_ENTRIES = new Set([
  'client/configure/entry.js',
  'client/dashboard/entry.js',
  'client/painel/entry.js',
]);
const CLIENT_ASSETS = [
  'client/configure/entry.js',
  'client/configure/state.js',
  'client/configure/dom.js',
  'client/configure/keys.js',
  'client/configure/limits.js',
  'client/configure/indexers.js',
  'client/configure/view.js',
  'client/configure/seal.js',
  'client/configure/init.js',
  'client/dashboard/entry.js',
  'client/dashboard/hooks.js',
  'client/dashboard/state.js',
  'client/dashboard/core.js',
  'client/dashboard/render.js',
  'client/dashboard/probes.js',
  'client/dashboard/general.js',
  'client/dashboard/af-stall.js',
  'client/dashboard/f3.js',
  'client/dashboard/timers.js',
  'client/dashboard/catalog-panel.js',
  'client/dashboard/catalog-render.js',
  'client/dashboard/catalog-actions.js',
  'client/dashboard/panels.js',
  'client/dashboard/panels-l2.js',
  'client/dashboard/panels-index.js',
  'client/dashboard/status-issues.js',
  'client/dashboard/status-actions.js',
  'client/dashboard/status-root.js',
  'client/dashboard/magnets.js',
  'client/dashboard/autofetch.js',
  'client/dashboard/autofetch-actions.js',
  'client/dashboard/harvest.js',
  'client/dashboard/harvest-actions.js',
  'client/dashboard/harvest-debrid.js',
  'client/dashboard/nav.js',
  'client/dashboard/health.js',
  'client/dashboard/debrid-test.js',
  'client/dashboard/trace.js',
  'client/dashboard/boot.js',
  'client/painel/vendor/preact.js',
  'client/painel/entry.js',
  'client/painel/app.js',
  'client/painel/kit.js',
];

function makePublicHandlers(services: AppServices) {
  // Fingerprint do CONTEÚDO dos assets (e não da versão do package/manifest, que
  // não muda a cada deploy): a URL só muda quando o arquivo muda. Restart sem
  // rebuild mantém a URL e o cache do cliente continua válido — que é o correto;
  // deploy que muda o asset muda a URL junto. Lido uma vez por app: o addon serve
  // de dist/ e os arquivos não mudam no decorrer do processo.
  const fingerprint = createHash('sha256');
  for (const name of [...PAGE_ASSETS, ...CLIENT_ASSETS]) {
    fingerprint.update(fs.readFileSync(services.publicPath(name)));
  }
  const assetVersion = fingerprint.digest('hex').slice(0, 10);

  // ETag de CONTEÚDO por módulo do cliente. O ETag padrão do sendFile é por stat
  // (mtime/tamanho): um rebuild sem mudança de código rebaixaria o módulo de
  // novo. O hash do byte só muda quando o conteúdo muda — é ele que sustenta o
  // no-cache + 304 dos filhos.
  const clientEtags = new Map<string, string>();
  for (const name of CLIENT_ASSETS) {
    const hash = createHash('sha256').update(fs.readFileSync(services.publicPath(name))).digest('hex').slice(0, 32);
    clientEtags.set(name, '"' + hash + '"');
  }

  // O HTML sai da memória, sempre fresco, referenciando os assets com
  // ?v=<hash>. É isso que elimina o skew de deploy: HTML novo só aponta para
  // URLs que o cache do browser ainda não tem. As duas páginas agora apontam
  // para um único entry ESM (`/client/<nome>/entry.js`), fora do padrão dos
  // assets de topo.
  const sendVersionedHtml = (name: string) => {
    const html = fs
      .readFileSync(services.publicPath(name), 'utf8')
      // A aspa de fechamento faz parte do PADRÃO (e não só da substituição):
      // sem ela o match parava no `.css` sem consumir a aspa, a substituição
      // acrescentava outra e o HTML saía `href="/dashboard.css?v=abc""`. Casar a
      // aspa também ancora o fim real do valor.
      .replace(/((?:src|href)="\/(?:configure|dashboard|painel)[-\w]*\.(?:css|js))"/g, `$1?v=${assetVersion}"`)
      // Os entries dos clientes são aninhados (`/client/<nome>/entry.js`), fora
      // do padrão acima. Eles também carregam o fingerprint corrente — e os seus
      // imports relativos (filhos) são resolvidos pelo browser a partir deles.
      .replace(/(src="\/client\/(?:configure|dashboard|painel)\/entry\.js)"/g, `$1?v=${assetVersion}"`);
    // O HTML é a raiz do acoplamento (inline ↔ módulos) e aponta para o
    // fingerprint vigente: um HTML velho no cache do cliente chamaria URLs ?v=
    // antigas e o boot ficaria preso numa versão que o deploy já não serve.
    // `no-store` fecha as duas portas — memória e disco do browser.
    return (_: express.Request, res: express.Response) => {
      res.set('Cache-Control', 'no-store');
      return res.type('html').send(html);
    };
  };
  const sendConfigure = sendVersionedHtml('configure.html');
  const sendDashboard = sendVersionedHtml('dashboard.html');
  const sendPainel = sendVersionedHtml('painel.html');

  // Os HTML referenciam os assets por caminho absoluto porque a página responde
  // tanto em /configure quanto em /:userConfig/configure. A rota ignora a query
  // — o Express casa pelo path — então `?v=` não precisa (e não deve) constar da
  // allowlist. maxAge ALTO + `immutable` só é seguro quando a URL carrega o
  // fingerprint CORRENTE: o cache então só devolve o byte-idêntico. Sem a query
  // (ou com valor arbitrário) o mesmo path aponta para conteúdo mutável e
  // `immutable` congelaria isso por um ano — esse acesso cai no maxAge curto.
  const sendPageAsset = (name: string) => (req: express.Request, res: express.Response) => {
    if (req.query.v === assetVersion) {
      return res.sendFile(services.publicPath(name), { maxAge: '365d', immutable: true });
    }
    return res.sendFile(services.publicPath(name), { maxAge: '30d' });
  };

  // Assets dos clientes ESM. O entry versionado é imutável (a URL muda com o
  // conteúdo). Filhos e o entry sem o fingerprint corrente saem no-cache com
  // ETag de CONTEÚDO + 304: o browser revalida em todo boot sem baixar de novo, e
  // um rebuild sem mudança de código não força o download. Sem isso, um filho
  // velho de 30 dias emparelharia com HTML novo no deploy.
  const sendClientAsset = (name: string) => (req: express.Request, res: express.Response) => {
    if (CLIENT_ENTRIES.has(name) && req.query.v === assetVersion) {
      return res.sendFile(services.publicPath(name), { maxAge: '365d', immutable: true });
    }
    const etag = clientEtags.get(name);
    res.set('Cache-Control', 'no-cache');
    if (etag) {
      res.set('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
    }
    // `etag:false`/`lastModified:false`: o send não sobrescreve o ETag de conteúdo
    // com o baseado em stat (que muda a cada build).
    return res.sendFile(services.publicPath(name), { cacheControl: false, etag: false, lastModified: false } as any);
  };

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

  return { sendConfigure, sendDashboard, sendPainel, sendPageAsset, pageAssets: PAGE_ASSETS, clientAssets: CLIENT_ASSETS, sendClientAsset, defaults, seal };
}

export { makePublicHandlers, PAGE_ASSETS, CLIENT_ASSETS };
