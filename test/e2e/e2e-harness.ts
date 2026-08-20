// Rodada 2: checagem ligada; o harness é consumido pelos tiers tipados.
import http from 'node:http';
// O app montado é o REAL (src/app.js): o harness parou de manter uma cópia das
// rotas do addon.js — divergência silenciosa era o risco da cópia.
import { createApp } from '../../src/app.js';
import * as runtime from '../../src/runtime.js';
import { verifyResolve, signResolve } from '../../src/utils/sign.js';
import * as cache from '../../src/utils/cache.js';

/**
 * Resposta HTTP falsa do harness, compatível com o contrato mínimo do fetch.
 */
interface HarnessResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: {
    get(name: string): string | null;
    has(name: string): boolean;
  };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Item aceito por makeTorznabXml; o XML padrão preenche o que faltar. */
interface TorznabItem {
  cdata?: boolean;
  title?: string;
  guid?: string;
  infoHash?: string;
  magnet?: string;
  size?: number;
  seeders?: number;
  peers?: number;
  tracker?: string;
  indexer?: string;
  pubDate?: string;
}

/** Rota do dublê de fetch: matcher + resposta (valor cru ou função). */
type MockRouteHandler = (url: string, init?: RequestInit, call?: HarnessCallRecord) => unknown;
interface MockRoute {
  match: string | RegExp | ((url: string, init?: RequestInit) => boolean);
  handler: unknown;
}

/** Chamada capturada pelo dublê, exposta em mockFetch.calls. */
interface HarnessCallRecord {
  url: string;
  init?: RequestInit;
  started: number;
  method: string;
  headers: RequestInit['headers'];
  body: RequestInit['body'];
  finished?: number;
}

/** Dublê de fetch com histórico de chamadas. */
interface MockFetch {
  (url: string | URL | Request, init?: RequestInit): Promise<HarnessResponse>;
  calls: HarnessCallRecord[];
  clearCalls(): void;
}

/** Resultado de createTestServer().request(...). */
interface HarnessRequestResult {
  status: number;
  ok: boolean;
  headers: {
    get(name: string): string | string[] | null;
    has(name: string): boolean;
    raw: http.IncomingHttpHeaders;
  };
  text: string;
  /** any de propósito: os testes acessam campos arbitrários do JSON. */
  json: any;
}

/**
 * Cria uma resposta HTTP falsa compatível com fetch nativo.
 */
function fakeResponse(body: unknown, { status = 200, headers = {}, location = null }: { status?: number; headers?: Record<string, string>; location?: string | null } = {}): HarnessResponse {
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
function makeTorznabXml(items: TorznabItem[] = []): string {
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
function createMockFetch(routes: MockRoute[] = []): MockFetch {
  const calls: HarnessCallRecord[] = [];

  const fetchImpl: MockFetch = async (url, init) => {
    const urlStr = String(url);
    const callRecord: HarnessCallRecord = {
      url: urlStr,
      init,
      started: Date.now(),
      method: (init?.method || 'GET').toUpperCase(),
      headers: init?.headers,
      body: init?.body,
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
            const res = await (route.handler as MockRouteHandler)(urlStr, init, callRecord);
            const maybe = res as { ok?: unknown; json?: unknown } | null;
            if (maybe && maybe.ok !== undefined && typeof maybe.json === 'function') {
              return res as HarnessResponse;
            }
            return fakeResponse(res);
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
async function withMockFetch<T>(
  routesOrHandler: MockRoute | MockRoute[] | MockFetch,
  fn: (mockFetch: MockFetch) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  const mockFetch = typeof routesOrHandler === 'function'
    ? routesOrHandler
    : createMockFetch(Array.isArray(routesOrHandler) ? routesOrHandler : [routesOrHandler]);

  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  cache.clear();

  try {
    return await fn(mockFetch);
  } finally {
    cache.clear();
    globalThis.fetch = realFetch;
  }
}

/**
 * Cria a aplicação Express REAL do addon (mesma fábrica do addon.js). O
 * parâmetro antigo `configOverrides` é aceito por compatibilidade de chamada,
 * mas as rotas não têm mais estado para configurar: cada createApp() já nasce
 * com gates próprios.
 */
function createTestApp({ configOverrides = {} } = {}) {
  void configOverrides;
  return createApp().app;
}

/**
 * Cria um servidor HTTP de teste efêmero na porta 0 com cliente HTTP nativo.
 */
async function createTestServer(app?: any) {
  const application = app || createTestApp();
  const server = http.createServer(application);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('servidor de teste sem endereço válido');
  }
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method: string, reqPath: string, { headers = {}, body = null }: { headers?: Record<string, string | number>; body?: unknown } = {}): Promise<HarnessRequestResult> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(`${baseUrl}${reqPath.startsWith('/') ? '' : '/'}${reqPath}`);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: method.toUpperCase(),
        headers: { ...headers },
      };

      let reqBody: string | null = null;
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
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const text = rawBuffer.toString('utf-8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          const status = res.statusCode ?? 0;

          resolve({
            status,
            ok: status >= 200 && status < 300,
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

const encodeConfig = runtime.encode;
const decodeConfig = runtime.decode;

export {
  fakeResponse,
  makeTorznabXml,
  makeCinemetaMeta,
  makeTmdbFind,
  createMockFetch,
  withMockFetch,
  createTestApp,
  createTestServer,
  encodeConfig,
  decodeConfig,
  signResolve,
  verifyResolve,
};
