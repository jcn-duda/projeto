import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// vacatorrent-resolver é CommonJS (module.exports = resolver) e consta no
// exclude do tsconfig (como os 4 shims irmãos) — o `server.d.ts` local declara
// as exportações. O @ts-ignore cobre só a fronteira de interop CommonJS/ESM.
// @ts-ignore
import vaca from '../vacatorrent-resolver/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'vacatorrent', name), 'utf8');

describe('VacaTorrent Parser: search JSON (admin-ajax / search_posts)', () => {
  test('parseSearchJson: extrai obras reais do JSON de "dia d"', () => {
    const works = vaca.parseSearchJson(fixture('search-dia-d.json'));

    assert.ok(Array.isArray(works));
    assert.ok(works.length >= 1);
    assert.equal(works[0].title, 'Um Dia de Sorte em Nova York');
    assert.equal(works[0].type, 'Filme');
    assert.equal(works[0].year, 2025);
    assert.equal(works[0].url, 'https://vaqueirofilmes.com/pt/movie/um-dia-de-sorte-em-nova-york/');
    assert.equal(works[0].poster, 'https://vaqueirofilmes.com/wp-content/uploads/2026/07/poster-1453422-150x150.webp');
    assert.equal(works[0].idioma, 'Português | Inglês');
  });

  test('parseSearchJson: parseia "Extermínio" com acento e múltiplas obras', () => {
    const works = vaca.parseSearchJson(fixture('search-exterminio.json'));
    assert.ok(works.length >= 4);
    assert.ok(works.some((w: any) => w.title === 'Extermínio'));
    assert.ok(works.every((w: any) => w.type === 'Filme'));
  });

  test('parseSearchJson: tolera JSON vazio e entradas sem obrigatórios', () => {
    assert.deepEqual(vaca.parseSearchJson('[]'), []);
    assert.deepEqual(vaca.parseSearchJson(''), []);
    assert.deepEqual(vaca.parseSearchJson('nan'), []);
  });
});

describe('VacaTorrent Parsers: filme com tamanho real (movie-links)', () => {
  const base = 'https://vaqueirofilmes.com/movie-links/60009/';

  test('parseDownloadLinks: ignora seção Assistir (players) e preserva Download com size real', () => {
    const links = vaca.parseDownloadLinks(fixture('movie-links.html'), base);

    assert.equal(links.length, 1, 'somente o botão systemtech de Download; players embed ignorados');
    assert.ok(links[0].url.startsWith('https://systemtech.space/enc/go.php?id='), 'href real do protetor');
    assert.equal(links[0].size, '2.54 GB', 'tamanho REAL do rótulo (não sentinela 1 KB)');
    assert.equal(links[0].quality, 1080);
    assert.equal(links[0].audio, 'dual', '"Português | Inglês" classifica como DUAL');
  });
});

describe('VacaTorrent Parser: normalizeQuery (ano e SxxEyy)', () => {
  test('normalizeQuery: remove SxxEyy e ano de 4 dígitos, preserva título', () => {
    assert.equal(vaca.normalizeQuery('Outer Banks S05'), 'Outer Banks');
    assert.equal(vaca.normalizeQuery('Outer Banks S05E02'), 'Outer Banks');
    assert.equal(vaca.normalizeQuery('Um Dia de Sorte em Nova York 2025'), 'Um Dia de Sorte em Nova York');
    assert.equal(vaca.normalizeQuery('Extermínio 2002'), 'Extermínio');
    assert.equal(vaca.normalizeQuery('The Last of Us: Season 1'), 'The Last of Us Season 1');
  });
});

describe('VacaTorrent Parser: nextProtectedUrl (protetor systemtech)', () => {
  const base = 'https://systemtech.space/enc/go.php?id=x&pub=PUB_fBL3F0';

  test('nextProtectedUrl: casa const next do go.php e decodifica q= youtube redirect -> t.co', () => {
    const next = vaca.nextProtectedUrl(fixture('go.php.html'), base);
    assert.equal(next, 'https://t.co/SFsPRm91bg');
  });

  test('nextProtectedUrl: não casa quando não há const next nem protetor permitido', () => {
    assert.equal(vaca.nextProtectedUrl('<html>sem next</html>', base), null);
    assert.equal(vaca.nextProtectedUrl('', base), null);
  });

  test('nextProtectedUrl: casa var URL_ETAPA2 JSON-escaped e devolve URL absoluta (vacadb.org)', () => {
    // O gate-2 da vacadb.org emite var URL_ETAPA2 com a URL JSON-escaped (\/);
    // des-escapar o slash, resolver contra a base e seguir para o host de
    // passagem (assert-only, como t.co) — o resolvedor replica o salto por HTTP
    // em vez de pagar o contador client-side (~50s) de teatro.
    const html = 'var URL_ETAPA2 = "https:\\/\\/vacadb.org\\/enc2\\/receber.php?enc=abc123&pub=PUB_x";';
    const next = vaca.nextProtectedUrl(html, 'https://vacadb.org/torta-suja/');
    assert.equal(next, 'https://vacadb.org/enc2/receber.php?enc=abc123&pub=PUB_x');
  });

  test('nextProtectedUrl: casa const next com destino t.co (salto aceito / assert-only no processar.php)', () => {
    const html = 'const next = "https:\\/\\/t.co\\/SFsPRm91bg";';
    const next = vaca.nextProtectedUrl(html, 'https://systemtech.space/enc/processar.php');
    assert.equal(next, 'https://t.co/SFsPRm91bg');
  });

  test('nextProtectedUrl: rejeita youtube redirect quando destino aponta para host malicioso / não permitido', () => {
    const html = 'const next = "https:\\/\\/www.youtube.com\\/redirect?q=https%3A%2F%2Fevil-domain.com%2Fvirus";';
    const next = vaca.nextProtectedUrl(html, 'https://systemtech.space/enc/go.php');
    assert.equal(next, null, 'não deve aceitar domínio fora de protector/assert-only via youtube');
  });

  test('nextProtectedUrl: resolve youtube redirect com caminho relativo sobre o protetor', () => {
    const html = 'const next = "https:\\/\\/www.youtube.com\\/redirect?q=%2Fenc%2Frelay.php%3Fenc%3D123";';
    const next = vaca.nextProtectedUrl(html, 'https://systemtech.space/enc/processar.php');
    assert.equal(next, 'https://systemtech.space/enc/relay.php?enc=123');
  });

  test('nextProtectedUrl: aceita declarações var/let e aspas simples com host assert-only', () => {
    assert.equal(
      vaca.nextProtectedUrl("var next = 'https://t.co/SFsPRm91bg';", 'https://systemtech.space/enc/processar.php'),
      'https://t.co/SFsPRm91bg',
    );
    assert.equal(
      vaca.nextProtectedUrl('let next = "https:\\/\\/t.co\\/SFsPRm91bg";', 'https://systemtech.space/enc/processar.php'),
      'https://t.co/SFsPRm91bg',
    );
  });

  test('nextProtectedUrl: aceita template literals com crases (backticks), window.next e atribuição direta', () => {
    assert.equal(
      vaca.nextProtectedUrl('const next = `https://t.co/SFsPRm91bg`;', 'https://systemtech.space/enc/processar.php'),
      'https://t.co/SFsPRm91bg',
      'deve aceitar template literals com crase',
    );
    assert.equal(
      vaca.nextProtectedUrl('window.next = "https://t.co/SFsPRm91bg";', 'https://systemtech.space/enc/processar.php'),
      'https://t.co/SFsPRm91bg',
      'deve aceitar window.next',
    );
    assert.equal(
      vaca.nextProtectedUrl('next = "https://t.co/SFsPRm91bg";', 'https://systemtech.space/enc/processar.php'),
      'https://t.co/SFsPRm91bg',
      'deve aceitar atribuição direta a next',
    );
  });

  test('nextProtectedUrl: atributo HTML não é atribuição — isca em data-next não vence o next real', () => {
    // O laço devolve o PRIMEIRO destino válido. Uma isca em atributo, colocada
    // antes do script, sequestraria o salto se `next` casasse dentro dela — e
    // este é o ramo que aceita host assert-only.
    const isca = '<a data-next="https://t.co/ISCA0000000">baixar</a>';
    const real = 'const next = "https://t.co/SFsPRm91bg";';
    assert.equal(
      vaca.nextProtectedUrl(`${isca}\n${real}`, 'https://systemtech.space/enc/processar.php'),
      'https://t.co/SFsPRm91bg',
      'o next do script vence a isca do atributo',
    );
    assert.equal(
      vaca.nextProtectedUrl(isca, 'https://systemtech.space/enc/processar.php'),
      null,
      'sozinha, a isca em atributo não vira salto',
    );
    assert.equal(
      vaca.nextProtectedUrl('meunext = "https://t.co/ISCA0000000";', 'https://systemtech.space/enc/processar.php'),
      null,
      'sufixo colado (meunext) não é o next',
    );
  });

  test('nextProtectedUrl: preserva parâmetros com caractere de percentagem no redirect do youtube', () => {
    const html = 'const next = "https:\\/\\/www.youtube.com\\/redirect?q=https%3A%2F%2Ft.co%2Fsearch%3Fq%3D100%25";';
    const next = vaca.nextProtectedUrl(html, 'https://systemtech.space/enc/processar.php');
    assert.equal(next, 'https://t.co/search?q=100%');
  });

  test('nextProtectedUrl: resolve caminho relativo local de const next no protetor', () => {
    const html = 'const next = "/enc/processar.php?id=xyz";';
    const next = vaca.nextProtectedUrl(html, 'https://systemtech.space/enc/go.php');
    assert.equal(next, 'https://systemtech.space/enc/processar.php?id=xyz');
  });

  test('nextProtectedUrl: previne auto-loop quando next aponta para o próprio baseUrl ou fragmento/hash', () => {
    const baseUri = 'https://systemtech.space/enc/processar.php';
    assert.equal(vaca.nextProtectedUrl(`const next = "${baseUri}";`, baseUri), null);
    assert.equal(vaca.nextProtectedUrl(`const next = "${baseUri}#sec";`, baseUri), null);
    assert.equal(vaca.nextProtectedUrl('const next = "#";', baseUri), null);
  });

  test('nextProtectedUrl: ignora atribuição sentinela inicial e captura atribuição válida subsequente', () => {
    const html = '<script>let next = "#"; next = "https:\\/\\/t.co\\/SFsPRm91bg";</script>';
    const next = vaca.nextProtectedUrl(html, 'https://systemtech.space/enc/processar.php');
    assert.equal(next, 'https://t.co/SFsPRm91bg');
  });

  test('nextProtectedUrl: aceita crases (backticks) em URL_ETAPA2', () => {
    const html = 'var URL_ETAPA2 = `https://vacadb.org/enc2/receber.php?enc=abc123&pub=PUB_x`;';
    const next = vaca.nextProtectedUrl(html, 'https://vacadb.org/torta-suja/');
    assert.equal(next, 'https://vacadb.org/enc2/receber.php?enc=abc123&pub=PUB_x');
  });

  test('nextProtectedUrl: aceita salto para host assert-only via meta refresh', () => {
    const html = '<meta http-equiv="refresh" content="0;url=https://t.co/SFsPRm91bg">';
    const next = vaca.nextProtectedUrl(html, 'https://systemtech.space/enc/processar.php');
    assert.equal(next, 'https://t.co/SFsPRm91bg');
  });
});

describe('VacaTorrent Parser: extractMagnet (data-link base64 do gate-2 vacadb)', () => {
  test('extractMagnet: decodifica o magnet em base64 no atributo data-link do body', () => {
    // No body da pasta final o magnet viaja como <body data-link="<base64>">;
    // decodificar e validar contra magnet:?xt=urn:btih: antes de devolver.
    const magnet = 'magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&tr=udp%3A%2F%2Ftracker.openbittorrent.com%2Fannounce';
    const b64 = Buffer.from(magnet).toString('base64');
    const html = `<body data-link="${b64}">`;
    assert.equal(vaca.extractMagnet(html), magnet, 'extrai o magnet decodificado do base64');
  });

  test('extractMagnet: devolve null com payload vazio, malformado ou sem magnet válido', () => {
    assert.equal(vaca.extractMagnet(''), null);
    assert.equal(vaca.extractMagnet('<body data-link="not-base64-not-magnet">'), null);
    assert.equal(vaca.extractMagnet('<body data-link="aHR0cHM6Ly9leGFtcGxlLmNvbQ==">'), null);
  });
});

describe('VacaTorrent Parser: allowlist (assertAllowedUrl)', () => {
  test('assertAllowedUrl: aceita host candidato do site e protetores systemtech/t.co', () => {
    assert.doesNotThrow(() => vaca.assertAllowedUrl('https://vaqueirofilmes.com/pt/movie/um-dia-de-sorte-em-nova-york/'));
    assert.doesNotThrow(() => vaca.assertAllowedUrl('https://vacatorrentmov.com/pt/'));
    assert.doesNotThrow(() => vaca.assertAllowedUrl('https://systemtech.space/enc/go.php?id=x&pub=PUB_fBL3F0'));
    assert.doesNotThrow(() => vaca.assertAllowedUrl('https://t.co/SXsPRm91bg'));
    assert.doesNotThrow(() => vaca.assertAllowedUrl('https://vacadb.org/enc2/receber.php?enc=x'));
  });

  test('assertAllowedUrl: rejeita domínio desconhecido e protocolo inválido', () => {
    assert.throws(() => vaca.assertAllowedUrl('https://evil-site.com/malware'), /blocked_host/);
    assert.throws(() => vaca.assertAllowedUrl('ftp://vaqueirofilmes.com/x'), /unsupported_protocol/);
    assert.throws(() => vaca.assertAllowedUrl('javascript:alert(1)'), /unsupported_protocol/);
  });

  test('isDetailHost / isProtectorHost: distingue host de detalhe de protetor', () => {
    assert.equal(vaca.isDetailHost('vaqueirofilmes.com'), true);
    assert.equal(vaca.isDetailHost('systemtech.space'), false);
    assert.equal(vaca.isProtectorHost('systemtech.space'), true);
    assert.equal(vaca.isProtectorHost('t.co'), false, 't.co é apenas salto aceito, não descoberta de protetor');
    assert.equal(vaca.isProtectorHost('vacadb.org'), false, 'vacadb.org é apenas salto aceito (assert-only), não descoberta de protetor');
    assert.equal(vaca.isAssertOnlyHost('t.co'), true, 't.co é host de salto aceito');
    assert.equal(vaca.isAssertOnlyHost('vacadb.org'), true, 'vacadb.org é host de salto aceito');
    assert.equal(vaca.isAssertOnlyHost('systemtech.space'), false, 'systemtech.space é protetor completo, não assert-only');
  });
});

describe('VacaTorrent Parser: batch com título REAL distinto da série buscada', () => {
  const base = 'https://vaqueirofilmes.com/batch/batch-sacrificio-paràs5/';

  test('extractBatchTitle: título vem do .bl-hero-title (real), não da série que linkou', () => {
    const title = vaca.extractBatchTitle(fixture('batch.html'));
    assert.ok(title && title.includes('Sacrifício de Sangue'), `título real do batch: ${title}`);
  });

  test('parseDownloadLinks do batch: hero real NÃO é o nome da série buscada', () => {
    const title = vaca.extractBatchTitle(fixture('batch.html'));
    const links = vaca.parseDownloadLinks(fixture('batch.html'), base, { season: 5, realTitle: title || null });
    assert.ok(links.length >= 1);
    assert.ok(links[0].url.startsWith('https://systemtech.space/enc/go.php?id='));

    const release = vaca.releaseTitle({ title: 'Outer Banks', year: 2020 }, links[0], 0);
    assert.ok(release.includes('Sangue S05'), `título real deve estar na release: ${release}`);
    assert.ok(!release.includes('Outer Banks'), `batch errado não pode levar o nome da série buscada: ${release}`);
  });

  test('releaseTitle: filme re-injeta o ano e formata tags', () => {
    const release = vaca.releaseTitle(
      { title: 'Um Dia de Sorte em Nova York', year: 2025 },
      { quality: 1080, source: 'WEB-DL', audio: 'dual', size: '2.54 GB', episode: null },
    );
    assert.ok(release.includes('Um Dia de Sorte em Nova York (2025)'), release);
    assert.ok(release.includes('DUAL'), release);
    assert.ok(release.includes('2.54 GB'), release);
  });
});

describe('VacaTorrent Parser: searchPageHtml (feed do Jackett)', () => {
  test('searchPageHtml: formata linha com tamanho real e seeders=1', () => {
    const items = [
      {
        post: { url: 'https://vaqueirofilmes.com/ml/um-dia-2225/', title: 'Um Dia de Sorte em Nova York', year: 2025, poster: null },
        link: { quality: 1080, audio: 'dual', size: '2.54 GB', source: null, episode: null },
        index: 0,
        count: 1,
      },
    ];
    const html = vaca.searchPageHtml(items);
    assert.ok(html.includes('<div class="size">2.54 GB</div>'));
    assert.ok(html.includes('<div class="seeders">1</div>'));
    assert.ok(html.includes('/resolve?url='));
    assert.ok(html.includes('Um Dia de Sorte em Nova York (2025)'));
  });
});

describe('VacaTorrent: browse do cardigann (query vazia)', () => {
  test('searchPosts(""): usa termo amplo no AJAX (o AJAX não lista sem termo) e devolve releases', async () => {
    let ajaxUrl = '';
    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;
      if (u.includes('admin-ajax.php')) {
        ajaxUrl = u;
        return { ok: true, status: 200, text: async () => fixture('search-dia-d.json') };
      }
      if (u.includes('um-dia-de-sorte-em-nova-york')) {
        return { ok: true, status: 200, text: async () => fixture('movie-page.html') };
      }
      if (u.includes('movie-links')) {
        return { ok: true, status: 200, text: async () => fixture('movie-links.html') };
      }
      throw new Error(`fetch inesperado: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const items = await vaca.searchPosts('');
    assert.ok(ajaxUrl.includes('s=de'), 'browse usa termo amplo do acervo como prova de vida');
    assert.ok(items.length >= 1, 'browse devolve ao menos uma release');
    assert.ok(items[0].post.title.includes('Um Dia de Sorte'), 'obra do JSON vira release com o título preservado');
  });
});