const http = require('node:http');
const path = require('path');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const config = require('../../src/config');
const { findStreams } = require('../../src/providers');
const debrid = require('../../src/debrid');
const runtime = require('../../src/runtime');
const { verifyResolve, signResolve } = require('../../src/utils/sign');
const jackettCatalog = require('../../src/providers/jackett-catalog');
const jackett = require('../../src/providers/jackett');
const { authorized, createDiagnosticGate } = require('../../src/utils/diagnostic-guard');
const secretBox = require('../../src/utils/secret-box');
const metrics = require('../../src/utils/metrics');
const cache = require('../../src/utils/cache');
const log = require('../../src/utils/logger');

const CONFIGURE_PAGE = path.join(__dirname, '..', '..', 'src', 'public', 'configure.html');
const LOGO_PAGE = path.join(__dirname, '..', '..', 'src', 'public', 'logo.svg');

/**
 * Cria uma resposta HTTP falsa compatível com fetch nativo.
 */
function fakeResponse(body, { status = 200, headers = {}, location = null } = {}) {
  const normalizedHeaders = new Map();
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      normalizedHeaders.set(k.toLowerCase(), v);
    }
  }
  if (location) {
    normalizedHeaders.set('location', location);
  }

  const isJson = typeof body === 'object' && body !== null && !(body instanceof Buffer);
  const textContent = isJson ? JSON.stringify(body) : String(body ?? '');

  if (!normalizedHeaders.has('content-type')) {
    normalizedHeaders.set('content-type', isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8');
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : status === 302 ? 'Found' : 'Status',
    headers: {
      get: (name) => normalizedHeaders.get(String(name).toLowerCase()) ?? null,
      has: (name) => normalizedHeaders.has(String(name).toLowerCase()),
    },
    json: async () => (isJson ? body : JSON.parse(textContent)),
    text: async () => textContent,
  };
}

/**
 * Cria um gerador de XML Torznab com suporte a CDATA e atributos padrão.
 */
function makeTorznabXml(items = []) {
  const itemBlocks = items.map((it) => {
    const title = it.cdata ? `<![CDATA[${it.title}]]>` : it.title || 'Torrent Item';
    const guid = it.guid || it.infoHash || 'item-' + Math.random().toString(36).slice(2);
    const link = it.magnet || (it.infoHash ? `magnet:?xt=urn:btih:${it.infoHash}&dn=${encodeURIComponent(it.title || 'Torrent')}` : '');
    const size = it.size ?? 1024 * 1024 * 500;
    const seeders = it.seeders ?? 10;
    const peers = it.peers ?? 5;
    const tracker = it.tracker || it.indexer || 'indexer';
    const pubDate = it.pubDate || new Date().toUTCString();

    return `
    <item>
      <title>${title}</title>
      <guid>${guid}</guid>
      <link>${link}</link>
      <pubDate>${pubDate}</pubDate>
      <size>${size}</size>
      <enclosure url="${link}" length="${size}" type="application/x-bittorrent" />
      <torznab:attr name="seeders" value="${seeders}" />
      <torznab:attr name="peers" value="${peers}" />
      <torznab:attr name="infohash" value="${it.infoHash || ''}" />
      <torznab:attr name="indexer" value="${tracker}" />
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Torznab Feed</title>
    ${itemBlocks}
  </channel>
</rss>`;
}

/**
 * Cria metadados Cinemeta padrão para testes.
 */
function makeCinemetaMeta(id, { name = 'Test Title', type = 'movie', year = '2024' } = {}) {
  return {
    meta: {
      id,
      type,
      name,
      year: String(year),
      genres: ['Action', 'Drama'],
      poster: 'https://images.metahub.space/poster/medium/' + id + '/img.jpg',
      background: 'https://images.metahub.space/background/medium/' + id + '/img.jpg',
    },
  };
}

/**
 * Cria resposta do TMDB para testes.
 */
function makeTmdbFind(id, { ptTitle = 'Título em Português' } = {}) {
  return {
    movie_results: [
      {
        id: 12345,
        title: ptTitle,
        original_title: 'Original Title',
        release_date: '2024-01-01',
      },
    ],
    tv_results: [
      {
        id: 54321,
        name: ptTitle,
        original_name: 'Original TV Title',
        first_air_date: '2024-01-01',
      },
    ],
  };
}

/**
 * Gerenciador de Mock Fetch configurável com suporte a rotas e histórico de chamadas.
 */
function createMockFetch(routes = []) {
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    const urlStr = String(url);
    const callRecord = {
      url: urlStr,
      init,
      started: Date.now(),
      method: (init.method || 'GET').toUpperCase(),
      headers: init.headers || {},
      body: init.body,
    };
    calls.push(callRecord);

    try {
      // 1. Verifica rotas explícitas configuradas
      for (const route of routes) {
        let match = false;
        if (typeof route.match === 'string') {
          match = urlStr.includes(route.match);
        } else if (route.match instanceof RegExp) {
          match = route.match.test(urlStr);
        } else if (typeof route.match === 'function') {
          match = route.match(urlStr, init);
        }

        if (match) {
          if (typeof route.handler === 'function') {
            const res = await route.handler(urlStr, init, callRecord);
            return res.ok !== undefined && typeof res.json === 'function' ? res : fakeResponse(res);
          }
          return fakeResponse(route.handler);
        }
      }

      // 2. Handlers padrão para endpoints conhecidos
      if (urlStr.includes('v3-cinemeta.strem.io/meta/')) {
        const idMatch = urlStr.match(/\/meta\/(movie|series)\/(tt\d+)/);
        const type = idMatch ? idMatch[1] : 'movie';
        const id = idMatch ? idMatch[2] : 'tt1254207';
        return fakeResponse(makeCinemetaMeta(id, { type }));
      }

      if (urlStr.includes('api.themoviedb.org/3/find/')) {
        const idMatch = urlStr.match(/\/find\/(tt\d+)/);
        const id = idMatch ? idMatch[1] : 'tt1254207';
        return fakeResponse(makeTmdbFind(id));
      }

      if (urlStr.includes('/results/torznab') || urlStr.includes('/api/v2.0/indexers/')) {
        return fakeResponse(makeTorznabXml([]), { headers: { 'content-type': 'application/xml' } });
      }

      if (urlStr.includes('/api/v1/search')) {
        return fakeResponse([]);
      }

      return fakeResponse({ ok: true });
    } finally {
      callRecord.finished = Date.now();
    }
  };

  fetchImpl.calls = calls;
  fetchImpl.clearCalls = () => { calls.length = 0; };
  return fetchImpl;
}

/**
 * Executa uma função assíncrona com interceptação global do fetch e isolamento de cache.
 */
async function withMockFetch(routesOrHandler, fn) {
  const realFetch = globalThis.fetch;
  const mockFetch = typeof routesOrHandler === 'function' && routesOrHandler.calls
    ? routesOrHandler
    : createMockFetch(Array.isArray(routesOrHandler) ? routesOrHandler : [routesOrHandler]);

  globalThis.fetch = mockFetch;
  cache.clear();

  try {
    return await fn(mockFetch);
  } finally {
    cache.clear();
    globalThis.fetch = realFetch;
  }
}

/**
 * Cria a aplicação Express do Addon com todos os middlewares e rotas idênticos ao addon.js.
 */
function createTestApp({ configOverrides = {} } = {}) {
  const app = express();
  const diagnosticGate = createDiagnosticGate();
  const sealGate = createDiagnosticGate({
    limit: 600,
    maxConcurrent: 4,
    rateMessage: 'muitos pedidos de selo; tente de novo em instantes',
    busyMessage: 'selo ocupado; tente de novo em instantes',
  });

  const manifest = {
    id: config.addonId,
    version: config.version,
    name: config.addonName,
    description: 'Adom Power-Movie Test Addon',
    logo: 'https://www.stremio.com/website/stremio-logo-small.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      adult: false,
      configurable: true,
      configurationRequired: false,
    },
  };

  const builder = new addonBuilder(manifest);

  builder.defineStreamHandler(async (args) => {
    try {
      const { streams, partial } = await findStreams({ type: args.type, id: args.id });
      if (!streams.length || partial) {
        return { streams, cacheMaxAge: 0 };
      }
      return {
        streams,
        cacheMaxAge: config.cacheTtl,
        staleRevalidate: config.cacheTtl * 4,
        staleError: 86400,
      };
    } catch (err) {
      log.error('[stream-test]', err);
      return { streams: [], cacheMaxAge: 0 };
    }
  });

  const addonInterface = builder.getInterface();

  async function resolveHandler(req, res) {
    const infoHash = String(req.params.infoHash || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
      return res.status(400).send('infoHash inválido');
    }
    if (debrid.current()) {
      const ep = req.query.s != null && req.query.e != null ? `?s=${req.query.s}&e=${req.query.e}` : '';
      if (!verifyResolve(infoHash, ep, req.query.sig)) {
        return res.status(403).send('assinatura inválida');
      }
    }
    try {
      const link = await debrid.resolveLink(infoHash, {
        season: req.query.s ? Number(req.query.s) : null,
        episode: req.query.e ? Number(req.query.e) : null,
      });
      if (!link) return res.status(404).send('nenhum arquivo de vídeo no torrent');
      return res.redirect(302, link);
    } catch (err) {
      log.error('[resolve-test]', err.message);
      return res.status(502).send('falha ao resolver no debrid');
    }
  }

  const sendConfigure = (_, res) => res.sendFile(CONFIGURE_PAGE);

  app.get('/health', (_, res) => res.json({ ok: true }));
  app.get('/logo.svg', (_, res) => res.sendFile(LOGO_PAGE));
  app.get('/', (_, res) => res.redirect(302, '/configure'));
  app.get('/configure', sendConfigure);

  app.get('/defaults.json', async (_, res) => {
    const { debridApiKey, ...safe } = runtime.defaults();
    const jackettIndexers = await jackettCatalog.load();
    res.json({
      ...safe,
      jackettIndexersSelected: safe.jackettIndexers,
      jackettIndexers,
      debridApiKey: '',
      services: debrid.SERVICES,
      addonName: config.addonName,
      indexerTestEnabled: Boolean(config.jackett.testToken),
      sealKeyEnabled: secretBox.enabled(),
    });
  });

  app.post('/seal-config', express.text({ type: () => true, limit: '16kb' }), (req, res) => {
    if (!secretBox.enabled()) {
      return res.status(503).json({ error: 'RESOLVE_SECRET não configurado' });
    }
    const admission = sealGate.enter('global');
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error });

    try {
      const sealed = runtime.sealSegment(String(req.body || '').trim());
      if (!sealed) return res.status(400).json({ error: 'configuração inválida' });
      return res.json({ segment: sealed });
    } finally {
      admission.release();
    }
  });

  app.get('/metrics.json', (req, res) => {
    if (!config.jackett.testToken) {
      return res.status(503).json({ error: 'métricas desativadas: defina JACKETT_TEST_TOKEN' });
    }
    if (!authorized(config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
      return res.status(401).json({ error: 'token de diagnóstico inválido' });
    }
    return res.json({
      ...metrics.snapshot(),
      logLevel: log.level(),
      cache: { entries: cache.size(), maxEntries: cache.MAX_ENTRIES },
    });
  });

  app.get('/test-indexer.json', async (req, res) => {
    if (!config.jackett.testToken) {
      return res.status(503).json({ ok: false, error: 'diagnóstico desativado pelo operador' });
    }
    if (!authorized(config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
      return res.status(401).json({ ok: false, error: 'token de diagnóstico inválido' });
    }
    const admission = diagnosticGate.enter('global');
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error });

    try {
      const id = String(req.query.id || '');
      const catalog = await jackettCatalog.load();
      if (!catalog.some((indexer) => indexer.id === id)) {
        return res.status(400).json({ ok: false, error: 'indexador desconhecido' });
      }
      const query = req.query.q ? String(req.query.q).slice(0, 80) : '';
      const type = req.query.type === 'series' ? 'series' : 'movie';
      return res.json(await jackett.test(id, query, type));
    } finally {
      admission.release();
    }
  });

  app.get('/resolve/:infoHash', resolveHandler);
  app.use(getRouter(addonInterface));

  app.use('/:userConfig', (req, res, next) => {
    const parsed = runtime.decode(req.params.userConfig);
    if (!parsed) return res.status(404).send('configuração inválida');
    runtime.run({ opts: parsed, encoded: req.params.userConfig }, () => next());
  });

  app.get('/:userConfig/configure', sendConfigure);
  app.get('/:userConfig/resolve/:infoHash', resolveHandler);
  app.use('/:userConfig', getRouter(addonInterface));

  return app;
}

/**
 * Cria um servidor HTTP de teste efêmero na porta 0 com cliente HTTP nativo.
 */
async function createTestServer(app) {
  const application = app || createTestApp();
  const server = http.createServer(application);

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method, reqPath, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(`${baseUrl}${reqPath.startsWith('/') ? '' : '/'}${reqPath}`);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: method.toUpperCase(),
        headers: { ...headers },
      };

      let reqBody = null;
      if (body !== null && body !== undefined) {
        if (typeof body === 'object' && !(body instanceof Buffer)) {
          reqBody = JSON.stringify(body);
          if (!options.headers['content-type']) options.headers['content-type'] = 'application/json';
        } else {
          reqBody = String(body);
        }
        options.headers['content-length'] = Buffer.byteLength(reqBody);
      }

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const text = rawBuffer.toString('utf-8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }

          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: {
              get: (name) => res.headers[String(name).toLowerCase()] ?? null,
              has: (name) => String(name).toLowerCase() in res.headers,
              raw: res.headers,
            },
            text,
            json,
          });
        });
      });

      req.on('error', reject);
      if (reqBody) req.write(reqBody);
      req.end();
    });
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    server,
    port,
    baseUrl,
    request,
    close,
  };
}

module.exports = {
  fakeResponse,
  makeTorznabXml,
  makeCinemetaMeta,
  makeTmdbFind,
  createMockFetch,
  withMockFetch,
  createTestApp,
  createTestServer,
  encodeConfig: runtime.encode,
  decodeConfig: runtime.decode,
  signResolve,
  verifyResolve,
};
