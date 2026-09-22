import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { asyncRoute } from './async.js';
import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';
import { stampRelativeImports } from './client-imports.js';

// CSS dos painéis (Fase 3, PLANO_MELHORIAS §5.9). A lista é FECHADA de propósito:
// publicPath() junta o nome ao diretório público, então aceitar nome arbitrário
// vindo da URL abriria leitura fora de public/ (traversal). O JS dos painéis saiu
// de src/public: /configure e /painel agora são ESM nativo emitido por
// tsconfig.client.json, servido pela CLIENT_ASSETS abaixo. O
// `dashboard-tokens.css` permanece na allowlist porque o painel o consome.
const PAGE_ASSETS = [
  'configure.css',
  'configure-components.css',
  'dashboard-tokens.css',
  'painel-tokens.css',
  'painel.css',
  'painel-limpeza.css',
];

// Entry e filhos dos clientes ESM (/configure e /painel; fontes em
// src/client/<nome>, emitidos por tsconfig.client.json para
// dist/src/public/client/). A lista é FECHADA: o caminho vem da URL e é juntado
// ao diretório público — nome arbitrário abriria leitura fora de public/
// (traversal). Os entries, com o ?v= corrente, vão immutable; os filhos saem
// no-cache para o ETag/304 pegar o deploy-skew sem congelar módulo velho.
const CLIENT_ENTRIES = new Set([
  'client/configure/entry.js',
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
  'client/painel/vendor/preact.js',
  'client/painel/entry.js',
  'client/painel/app.js',
  'client/painel/kit.js',
  'client/painel/store.js',
  'client/painel/storage.js',
  'client/painel/core.js',
  'client/painel/fmt.js',
  'client/painel/api.js',
  'client/painel/poll.js',
  'client/painel/action.js',
  'client/painel/confirm.js',
  'client/painel/toast.js',
  'client/painel/form.js',
  'client/painel/limpeza-model.js',
  'client/painel/config-model.js',
  'client/painel/diagnostico-model.js',
  'client/painel/saude-model.js',
  'client/painel/conta-model.js',
  'client/painel/view-saude.js',
  'client/painel/view-conta.js',
  'client/painel/view-gate.js',
  'client/painel/view-config.js',
  'client/painel/view-colhedor.js',
  'client/painel/view-harvest-debrid.js',
  'client/painel/view-sonda.js',
  'client/painel/view-chupim.js',
  'client/painel/view-cache.js',
  'client/painel/view-limpeza.js',
  'client/painel/view-diagnostico.js',
  'client/painel/view-diagnostico-indexer.js',
  'client/painel/view-magnets.js',
  'client/painel/bank-model.js',
  'client/painel/view-magnet-bank.js',
  'client/painel/jev-model.js',
  'client/painel/view-jev.js',
  'client/painel/limpeza/catalogo-model.js',
  'client/painel/limpeza/view-catalogo.js',
  'client/painel/limpeza/view-manutencao.js',
  'client/painel/limpeza/versoes-model.js',
  'client/painel/limpeza/view-versoes.js',
];

function makePublicHandlers(services: AppServices) {
  // Fingerprint do CONTEÚDO dos assets (e não da versão do package/manifest, que
  // não muda a cada deploy): a URL só muda quando o arquivo muda. Restart sem
  // rebuild mantém a URL e o cache do cliente continua válido — que é o correto;
  // deploy que muda o asset muda a URL junto. Lido uma vez por app: o addon serve
  // de dist/ e os arquivos não mudam no decorrer do processo.
  const fingerprint = createHash('sha256');
  // Versão do PIPELINE de entrega, não do conteúdo. O fingerprint nasceu como
  // hash dos bytes em disco, mas o que a URL promete é o corpo SERVIDO — e ele
  // depende também de como servimos. Quando o carimbo de `?v=` nos imports
  // entrou, os arquivos não mudaram: a mesma URL `?v=<hash>` passou a devolver
  // corpo diferente, quebrando a promessa de `immutable`. Em produção a
  // Cloudflare ficou com parte dos módulos na versão velha (imports sem query)
  // e parte na nova, o browser carregou DUAS instâncias do preact e o painel
  // abriu em branco (`Cannot read properties of undefined (reading '__H')`).
  // Suba este número em qualquer mudança na FORMA de servir os assets.
  fingerprint.update('serving-pipeline-v2');
  for (const name of [...PAGE_ASSETS, ...CLIENT_ASSETS]) {
    fingerprint.update(fs.readFileSync(services.publicPath(name)));
  }
  const assetVersion = fingerprint.digest('hex').slice(0, 10);

  // ETag de CONTEÚDO por módulo do cliente. O ETag padrão do sendFile é por stat
  // (mtime/tamanho): um rebuild sem mudança de código rebaixaria o módulo de
  // novo. O hash do byte só muda quando o conteúdo muda — é ele que sustenta o
  // no-cache + 304 dos filhos.
  // Corpo SERVIDO de cada módulo: o do disco com os imports relativos já
  // carimbados com `?v=<assetVersion>`. Feito uma vez no boot (o addon serve de
  // dist/ e os bytes não mudam no processo), então o request não paga nada.
  // Sem o carimbo a URL do filho é a mesma entre deploys e qualquer cache no
  // caminho — CDN, proxy, browser — pode servir módulo velho ao lado de um
  // entry novo; foi o que a Cloudflare fez com `max-age=14400` por cima do
  // nosso `no-cache`.
  const clientBodies = new Map<string, Buffer>();
  const clientEtags = new Map<string, string>();
  for (const name of CLIENT_ASSETS) {
    const raw = fs.readFileSync(services.publicPath(name), 'utf8');
    const body = Buffer.from(stampRelativeImports(raw, assetVersion), 'utf8');
    clientBodies.set(name, body);
    // ETag do corpo SERVIDO, não do arquivo em disco: os dois diferem depois do
    // carimbo, e um ETag do disco faria o 304 confirmar um corpo que não é o
    // que sai na resposta.
    clientEtags.set(name, '"' + createHash('sha256').update(body).digest('hex').slice(0, 32) + '"');
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
      // acrescentava outra e o HTML saía `href="/painel.css?v=abc""`. Casar a
      // aspa também ancora o fim real do valor. A alternação mantém os nomes
      // legados (`configure|dashboard|painel`) só para não perder um asset antigo
      // que ainda apareça no HTML; o dashboard.css não existe mais.
      .replace(/((?:src|href)="\/(?:configure|dashboard|painel)[-\w]*\.(?:css|js))"/g, `$1?v=${assetVersion}"`)
      // Os entries dos clientes são aninhados (`/client/<nome>/entry.js`), fora
      // do padrão acima. Eles também carregam o fingerprint corrente — e os seus
      // imports relativos (filhos) são resolvidos pelo browser a partir deles.
      .replace(/(src="\/client\/(?:configure|painel)\/entry\.js)"/g, `$1?v=${assetVersion}"`);
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
    // Sempre o corpo carimbado (da memória), nunca o arquivo cru: o do disco
    // importaria os filhos sem `?v=` e desfaria o versionamento em cadeia.
    const body = clientBodies.get(name);
    res.type('application/javascript; charset=utf-8');
    // Módulo pedido COM a versão corrente é imutável: essa URL nunca serve
    // outro conteúdo. Vale para entry e filho — agora os dois carregam `?v=`.
    if (req.query.v === assetVersion) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return body ? res.send(body) : res.sendFile(services.publicPath(name));
    }
    const etag = clientEtags.get(name);
    res.set('Cache-Control', 'no-cache');
    if (etag) {
      res.set('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
    }
    if (body) return res.send(body);
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
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error, reason: admission.reason });
    try {
      const sealed = services.runtime.sealSegment(String(req.body || '').trim());
      if (!sealed) return res.status(400).json({ error: 'configuração inválida' });
      return res.json({ segment: sealed });
    } finally {
      admission.release();
    }
  };

  return { sendConfigure, sendPainel, sendPageAsset, pageAssets: PAGE_ASSETS, clientAssets: CLIENT_ASSETS, sendClientAsset, defaults, seal };
}

export { makePublicHandlers, PAGE_ASSETS, CLIENT_ASSETS };
