// Endurecimento do adaptador Vaca (revisão da Fase 1), contra fixtures reais
// e variantes ADVERSÁRIAS sintéticas derivadas delas (sem rede):
//
//   - Host safety/SSRF: loc de sitemap, URL de obra e movie-links derivados de
//     conteúdo do site só valem no host do site — host de fora (loopback,
//     metadado de nuvem, host de protetor como página) é rejeitado ANTES do
//     fetch, na descoberta e no processamento.
//   - IMDb ancorado: só a ficha técnica ("Avaliação da IMDb: <a>") liga o tt à
//     obra; recomendação enganosa, dupla ficha e tt solto NÃO viram imdb.
//   - Política FlareSolverr: o crawl usa o caminho DIRETO do perfil — desafio
//     é erro (gatilho de pausa futuro), nunca fallback; nenhum teste aqui vê
//     uma chamada ao solver (:8191).
//   - Descoberta parcial no contrato (complete/failures), erro de layout e
//     multi-release com hashes distintos.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createResolver } from '../resolvers/profiles/vacatorrent.js';
import { createVacaCrawlSite } from '../src/providers/crawl-sites/vaca.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import { createPageProcessor } from '../src/providers/crawl-page.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';
import type { CrawlSite, CrawlUrlRow } from '../src/providers/crawl-types.js';

const store = await import('../src/utils/crawl-store.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'crawl', 'vaca');
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

const SITE = 'https://vaqueirofilmes.com';
const PAGE_TORRENT = `${SITE}/pt/movie/expresso-do-amanha/`;
const PAGE_STREAMING = `${SITE}/pt/movie/diario-de-um-banana-2-rodrick-e-o-cara/`;
const LINKS_STREAMING = `${SITE}/movie-links/54688/`;
/** btih REAL da resposta final capturada; ALT é o segundo magnet sintético. */
const REAL_BTIH = 'bd30a6e0dcb86fcff13de9939364384623746072';
const ALT_BTIH = '0123456789abcdef0123456789abcdef01234567';

function resolverSurface(): VacaResolverSurface {
  return createResolver({ port: 0, selfUrl: 'http://127.0.0.1:0', siteUrl: SITE, extraProtectors: [] });
}

/** Rota: string (200), objeto (status cru para desafio/403) ou função do corpo. */
type StubRoute = string | { body: string; status?: number } | (() => string);

function stubRoutes(routes: Record<string, StubRoute>): FetchStub {
  return stubFetch((url) => {
    for (const [match, route] of Object.entries(routes)) {
      if (url.includes(match)) {
        const body = typeof route === 'function' ? route() : typeof route === 'string' ? route : route.body;
        const status = typeof route === 'object' && 'status' in route ? (route.status ?? 200) : 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: () => null },
          text: async () => body,
          json: async () => { try { return JSON.parse(body); } catch { return {}; } },
        };
      }
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

const flareChallenge = () => JSON.stringify({ status: 'ok', solution: { status: 200, url: SITE, response: CHALLENGE_403.body, cookies: [], userAgent: 'UA' } });
const CHALLENGE_403 = {
  body: '<html><head><title>Just a moment...</title></head><body>'
    + '<script>window._cf_chl_opt = {"cvId":"3","cZone":"vaqueirofilmes.com"}</script>'
    + 'Verifique se você é humano — challenges.cloudflare.com</body></html>',
  status: 403,
};

const MINI_SITEMAP = `<?xml version="1.0"?><urlset>
  <url><loc>${SITE}/pt/movie/filme-a/</loc><lastmod>2026-09-25T01:00:00+00:00</lastmod></url>
</urlset>`;

function miniIndex(extraSitemaps: string): string {
  return `<?xml version="1.0"?><sitemapindex>
  <sitemap><loc>${SITE}/movie-sitemap12.xml</loc><lastmod>2026-09-25T00:00:00+00:00</lastmod></sitemap>${extraSitemaps}
</sitemapindex>`;
}

describe('crawl-sites/vaca host safety: descoberta não busca host de fora (SSRF)', () => {
  test('loc de movie-sitemap em host estranho no índice é descartado sem fetch', async () => {
    const extra = `
  <sitemap><loc>http://127.0.0.1:8191/movie-sitemap14.xml</loc><lastmod>2026-09-25T00:00:00+00:00</lastmod></sitemap>
  <sitemap><loc>http://169.254.169.254/movie-sitemap15.xml</loc><lastmod>2026-09-25T00:00:00+00:00</lastmod></sitemap>
  <sitemap><loc>//evil.example/movie-sitemap16.xml</loc><lastmod>2026-09-25T00:00:00+00:00</lastmod></sitemap>`;
    const stub = stubRoutes({
      'sitemap_index.xml': () => miniIndex(extra),
      'movie-sitemap12.xml': () => MINI_SITEMAP,
    });
    try {
      const disc = await createVacaCrawlSite(resolverSurface()).discover();
      assert.equal(disc.complete, true, 'entrada rejeitada por host é ruído, não fonte falha');
      assert.deepEqual(disc.failures, []);
      assert.equal(disc.urls.length, 1, 'só o sitemap legítimo entrou');
      const fetched = stub.calls.map((c) => c.url);
      assert.ok(!fetched.some((u) => u.includes('127.0.0.1')), 'loopback nunca é buscado');
      assert.ok(!fetched.some((u) => u.includes('169.254.169.254')), 'metadado de nuvem nunca é buscado');
      assert.ok(!fetched.some((u) => u.includes('evil.example')), 'host relativo estranho nunca é buscado');
    } finally {
      stub.restore();
    }
  });

  test('URL de obra em host estranho dentro do sitemap não entra na fila', async () => {
    const poisoned = `<?xml version="1.0"?><urlset>
      <url><loc>${SITE}/pt/movie/filme-a/</loc><lastmod>2026-09-25T01:00:00+00:00</lastmod></url>
      <url><loc>https://evil.example/pt/movie/coringa/</loc><lastmod>2026-09-25T02:00:00+00:00</lastmod></url>
      <url><loc>http://127.0.0.1:7000/pt/movie/admin/</loc><lastmod>2026-09-25T03:00:00+00:00</lastmod></url>
    </urlset>`;
    const stub = stubRoutes({
      'sitemap_index.xml': () => miniIndex(''),
      'movie-sitemap12.xml': () => poisoned,
    });
    try {
      const disc = await createVacaCrawlSite(resolverSurface()).discover();
      assert.equal(disc.urls.length, 1);
      assert.equal(new URL(disc.urls[0].url).hostname, 'vaqueirofilmes.com');
      assert.ok(stub.calls.every((c) => !c.url.includes('evil.example') && !c.url.includes('127.0.0.1')),
        'nenhum fetch sai do host do site');
    } finally {
      stub.restore();
    }
  });
});

describe('crawl-sites/vaca host safety: fetchWork só processa página do site', () => {
  test('host estranho (metadado de nuvem) é rejeitado ANTES de qualquer fetch', async () => {
    const stub = stubRoutes({});
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork('http://169.254.169.254/pt/movie/x/'),
        /blocked_host/,
      );
      assert.equal(stub.calls.length, 0, 'nenhum fetch acontece');
    } finally {
      stub.restore();
    }
  });

  test('host de PROTETOR não serve de página: só host candidato do site', async () => {
    const stub = stubRoutes({});
    try {
      // `assertAllowedUrl` sozinho ACEITA protetor (o transporte precisa); a
      // trava do crawl é a de cima: página exige host do site.
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork('https://systemtech.space/pt/movie/x/'),
        /blocked_host:systemtech\.space/,
      );
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });

  test('movie-links apontando para host estranho é erro, não no-torrent, e nunca é buscado', async () => {
    const poisonedPage = fixture('movie-page-torrent.html')
      .replace('https://vaqueirofilmes.com/movie-links/61616/', 'http://evil.example/movie-links/61616/');
    const stub = stubRoutes({ [PAGE_TORRENT]: () => poisonedPage });
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT),
        /blocked_host:evil\.example/,
      );
      assert.equal(stub.calls.length, 1, 'só a página da obra foi buscada');
      assert.ok(stub.calls.every((c) => !c.url.includes('evil.example')), 'o href estranho nunca é buscado');
    } finally {
      stub.restore();
    }
  });
});

describe('crawl-sites/vaca: IMDb ancorado na ficha técnica', () => {
  test('tt de recomendação ANTES da ficha não engana: o âncora vence', async () => {
    const decoy = '<div class="relacionados"><h3>Você pode gostar</h3>'
      + '<a href="https://www.imdb.com/title/tt0111161/" target="_blank">Um Sonho de Liberdade</a></div>';
    const page = fixture('movie-page-streaming.html').replace('<div id="main">', `${decoy}<div id="main">`);
    const stub = stubRoutes({
      [PAGE_STREAMING]: () => page,
      [LINKS_STREAMING]: () => fixture('movie-links-streaming.html'),
    });
    try {
      const result = await createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_STREAMING);
      assert.equal(result.status, 'no-torrent');
      assert.equal(result.imdb, 'tt1650043', 'o primeiro imdb.com do HTML era de OUTRA obra');
    } finally {
      stub.restore();
    }
  });

  test('duas fichas com tt distintos = ambíguo → null (obra errada é pior que nenhuma)', async () => {
    const secondCard = '<li><b>Avaliação da IMDb:</b> '
      + '<a href="https://www.imdb.com/title/tt0111161/" target="_blank" rel="noopener noreferrer">9.3</a></li>';
    const page = fixture('movie-page-streaming.html').replace('</body>', `${secondCard}</body>`);
    const stub = stubRoutes({
      [PAGE_STREAMING]: () => page,
      [LINKS_STREAMING]: () => fixture('movie-links-streaming.html'),
    });
    try {
      const result = await createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_STREAMING);
      assert.equal(result.imdb, null, 'ambíguo nunca vira chute');
      assert.equal(result.status, 'no-torrent');
    } finally {
      stub.restore();
    }
  });

  test('tt solto SEM ficha técnica não vira imdb', async () => {
    const page = fixture('movie-page-streaming.html')
      .replace('<li><b>Avaliação da IMDb:</b> <a href="https://www.imdb.com/title/tt1650043/" target="_blank" rel="noopener noreferrer">6.6</a></li>',
        '<a href="https://www.imdb.com/title/tt1650043/">IMDb</a>');
    const stub = stubRoutes({
      [PAGE_STREAMING]: () => page,
      [LINKS_STREAMING]: () => fixture('movie-links-streaming.html'),
    });
    try {
      const result = await createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_STREAMING);
      assert.equal(result.imdb, null, 'sem âncora, um link solto pode ser de recomendação');
    } finally {
      stub.restore();
    }
  });
});

describe('crawl-sites/vaca: desafio Cloudflare escalona ao Flare UMA vez', () => {
  test('página atrás de desafio Cloudflare: escalona ao Flare e, ainda desafiada, é ERRO', async () => {
    const stub = stubRoutes({ [PAGE_TORRENT]: CHALLENGE_403, ':8191/v1': flareChallenge });
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT),
        /desafio Cloudflare/,
      );
      const fetched = stub.calls.map((c) => c.url);
      assert.equal(fetched.filter((u) => u.includes(':8191')).length, 1, 'uma resolução pelo solver, sem laço');
    } finally {
      stub.restore();
    }
  });

  test('sitemap com desafio vira falha da rodada (parcial) depois de UMA tentativa no Flare', async () => {
    const extra = `
  <sitemap><loc>${SITE}/movie-sitemap13.xml</loc><lastmod>2026-09-25T00:00:00+00:00</lastmod></sitemap>`;
    const stub = stubRoutes({
      'sitemap_index.xml': () => miniIndex(extra),
      'movie-sitemap12.xml': () => MINI_SITEMAP,
      'movie-sitemap13.xml': CHALLENGE_403,
      ':8191/v1': flareChallenge,
    });
    try {
      const disc = await createVacaCrawlSite(resolverSurface()).discover();
      assert.equal(disc.complete, false, 'uma fonte falhou = parcial');
      assert.equal(disc.failures.length, 1);
      assert.match(disc.failures[0], /movie-sitemap13\.xml: .*desafio Cloudflare/);
      assert.equal(disc.urls.length, 1, 'a fonte que respondeu segue válida');
      assert.equal(stub.calls.filter((c) => c.url.includes(':8191')).length, 1, 'uma resolução pelo solver');
    } finally {
      stub.restore();
    }
  });
});

describe('crawl-sites/vaca: layout e multi-release', () => {
  test('página sem <h1> é erro de layout (backoff do motor), nunca obra sem nome', async () => {
    const stub = stubRoutes({ [PAGE_TORRENT]: () => '<html lang="pt-BR"><body><p>manutenção</p></body></html>' });
    try {
      const result = await createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT);
      assert.equal(result.status, 'error');
      assert.match(result.error || '', /layout/);
      assert.equal(result.releases, undefined);
      assert.equal(stub.calls.length, 1, 'sem <h1> não há segunda busca');
    } finally {
      stub.restore();
    }
  });

  test('dois botões com magnets distintos = duas releases; dedupe fica no hash igual', async () => {
    const stub = stubRoutes({
      [PAGE_TORRENT]: () => fixture('movie-page-torrent.html'),
      [`${SITE}/movie-links/61616/`]: () => fixture('movie-links-torrent.html'),
      'go.php?id=4jcc': () => fixture('protector-processar.html'),
      'go.php?id=rwis': () => `<html><body><a href="magnet:?xt=urn:btih:${ALT_BTIH}&dn=segundo">magnet</a></body></html>`,
      't.co/SFsPRm91bg': () => fixture('protector-tco.html'),
      'systemtech.space/enc/relay.php': () => fixture('protector-final-magnet.txt'),
      'vacadb.org': () => fixture('protector-final-magnet.txt'),
    });
    try {
      const result = await createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT);
      assert.equal(result.status, 'done');
      assert.equal(result.releases?.length, 2, 'os DOIS hashes entram');
      const hashes = result.releases!.map((r) => /urn:btih:([a-z0-9]+)/i.exec(r.magnet || '')?.[1]);
      assert.ok(hashes.includes(REAL_BTIH), 'magnet real da cadeia');
      assert.ok(hashes.includes(ALT_BTIH), 'segundo magnet distinto');
      // Cada release carrega o rótulo do PRÓPRIO botão (tamanho distingue).
      assert.ok(result.releases!.some((r) => /2\.33 GB/.test(r.title || '')));
      assert.ok(result.releases!.some((r) => /2\.26 GB/.test(r.title || '')));
    } finally {
      stub.restore();
    }
  });
});

describe('crawl-sites/vaca: gate-2 com download direto (Drive) → no-torrent', () => {
  test('todos os botões levam ao Drive = no-torrent na 1ª passada (sem erro retentável)', async () => {
    // Página final REAL (Blade Trinity, 2026-09-26): o data-link base64 é um
    // link do Google Drive. Antes caía em no_magnet e gastava 3 tentativas.
    const stub = stubRoutes({
      [PAGE_TORRENT]: () => fixture('movie-page-torrent.html'),
      [`${SITE}/movie-links/61616/`]: () => fixture('movie-links-torrent.html'),
      'go.php': () => fixture('protector-final-drive.html'),
    });
    try {
      const result = await createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT);
      assert.equal(result.status, 'no-torrent', 'download direto não é torrent nem erro');
      assert.equal(result.releases, undefined);
      assert.ok(stub.calls.some((c) => c.url.includes('go.php')), 'protetor foi consultado');
    } finally {
      stub.restore();
    }
  });

  test('Drive num botão e magnet no outro: o magnet entra (página done)', async () => {
    const stub = stubRoutes({
      [PAGE_TORRENT]: () => fixture('movie-page-torrent.html'),
      [`${SITE}/movie-links/61616/`]: () => fixture('movie-links-torrent.html'),
      'go.php?id=4jcc': () => fixture('protector-final-drive.html'),
      'go.php?id=rwis': () => `<html><body><a href="magnet:?xt=urn:btih:${ALT_BTIH}&dn=segundo">magnet</a></body></html>`,
    });
    try {
      const result = await createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT);
      assert.equal(result.status, 'done');
      assert.equal(result.releases?.length, 1);
    } finally {
      stub.restore();
    }
  });
});

describe('crawl-sites/vaca: protetor Link inválido ou expirado → no-torrent', () => {
  test('HTTP 400 + texto real: todos os botões expirados = no-torrent (sem retry)', async () => {
    // Texto REAL do protetor; status 400. Cadeia: página → movie-links → go.php.
    const stub = stubRoutes({
      [PAGE_TORRENT]: () => fixture('movie-page-torrent.html'),
      [`${SITE}/movie-links/61616/`]: () => fixture('movie-links-torrent.html'),
      'go.php': { body: 'Link inválido ou expirado', status: 400 },
    });
    try {
      const vaca = createVacaCrawlSite(resolverSurface());
      const result = await vaca.fetchWork(PAGE_TORRENT);
      assert.equal(result.status, 'no-torrent', 'magnet morto não é erro retentável');
      assert.equal(result.releases, undefined);
      assert.ok(stub.calls.some((c) => c.url.includes('go.php')), 'protetor foi consultado');

      // processPage: no-torrent terminal → tries fica 0 (não gasta maxTries).
      store.resetForTests();
      store.open(undefined, { forceMemory: true });
      store.engine().upsertUrls('vacatorrent', [{ url: PAGE_TORRENT, lastmod: '', kind: 'movie' }], 1);
      const row = store.engine().takeNext('vacatorrent', 10) as CrawlUrlRow;
      const site: CrawlSite = {
        id: 'vacatorrent', label: 'Vaca',
        discover: async () => ({ urls: [], complete: true, failures: [] }),
        fetchWork: async () => result,
      };
      const outcome = await createPageProcessor()(site, row, { dryRun: true, maxTries: 3 });
      assert.equal(outcome.kind, 'no-torrent');
      const saved = store.engine().getUrl('vacatorrent', PAGE_TORRENT);
      assert.equal(saved?.status, 'no-torrent');
      assert.equal(saved?.tries, 0, 'no-torrent não incrementa tries (sem 3 retries)');
    } finally {
      stub.restore();
      store.resetForTests();
    }
  });

  test('mistura expirado + rede continua erro retentável', async () => {
    // Isolamento: página/links pela camada de fetch (crawlFetch não despacha pelo surface); protetor pela costura surface.
    const stub = stubRoutes({
      [PAGE_TORRENT]: () => fixture('movie-page-torrent.html'),
      [`${SITE}/movie-links/61616/`]: () => fixture('movie-links-torrent.html'),
    });
    let n = 0;
    const surface: VacaResolverSurface = {
      ...resolverSurface(),
      extractMovieLinks: () => `${SITE}/movie-links/61616/`,
      parseDownloadLinks: () => [
        { url: 'https://systemtech.space/enc/go.php?id=a', quality: 1080, size: '1 GB', audio: 'dual', source: null, episode: null },
        { url: 'https://systemtech.space/enc/go.php?id=b', quality: 720, size: '700 MB', audio: 'dual', source: null, episode: null },
      ],
      fetchFollowingAllowed: async () => { if (++n === 1) throw new Error('protector_link_expired'); throw new Error('timeout'); },
    };
    try {
      await assert.rejects(() => createVacaCrawlSite(surface).fetchWork(PAGE_TORRENT), /timeout|protector_link_expired/);
    } finally { stub.restore(); }
  });
});
