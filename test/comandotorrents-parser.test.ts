import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import comando from '../comandotorrents-resolver/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: any) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('ComandoTorrents Parser: Search & Post Extraction', () => {
  test('parsePosts: extrai posts de fixture estendida resolvendo URLs relativas e decodificando entidades', () => {
    const html = fixture('comandotorrents-search-extended.html');
    const posts = comando.parsePosts(html);

    assert.equal(posts.length, 3, 'deve conter exatamente 3 posts únicos (descartando duplicatas e cards sem link)');

    assert.equal(posts[0].url, 'https://comandotorrents.to/deadpool-e-wolverine-2024/');
    assert.equal(posts[0].title, 'Deadpool & Wolverine Torrent – (2024) Dual Áudio 5.1 / Dublado WEB-DL 1080p / 4K');
    assert.equal(posts[0].poster, 'https://comandotorrents.to/wp-content/uploads/2024/07/deadpool-wolverine.jpg');

    assert.equal(posts[1].url, 'https://comandotorrents.to/alien-romulus-2024/');
    assert.equal(posts[1].title, 'Alien: Romulus Torrent (2024) BluRay 1080p & 4K Dublado');
    assert.equal(posts[1].poster, '/wp-content/uploads/2024/08/alien-romulus.jpg');

    assert.equal(posts[2].url, 'https://comandotorrents.to/the-boys-4a-temporada-torrent/');
    assert.equal(posts[2].title, 'The Boys 4ª Temporada Torrent (2024) WEB-DL 1080p Dual Áudio');
  });

  test('parsePosts: ignora blocos de artigo sem link e trata HTML vazio ou malformado', () => {
    assert.deepEqual(comando.parsePosts(''), []);
    assert.deepEqual(comando.parsePosts('<article class="blog-view">Sem titulo</article>'), []);
    assert.deepEqual(comando.parsePosts('<html><body><div>nada</div></body></html>'), []);
  });

  test('parsePosts: ignora URLs malformadas sem lançar exceção e suporta artigos sem fechamento explícito', () => {
    const malformed = `
      <article class="blog-view">
        <h2 class="entry-title"><a href="http://[::1:invalid-uri">Post quebrado</a></h2>
      <article class="blog-view">
        <h2 class="entry-title"><a href="https://comandotorrents.to/post-valido/">Post Válido</a></h2>
    `;
    const posts = comando.parsePosts(malformed);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://comandotorrents.to/post-valido/');
    assert.equal(posts[0].title, 'Post Válido');
  });
});

describe('ComandoTorrents Parser: Complex Movie Download Links', () => {
  const base = 'https://comandotorrents.to/deadpool-e-wolverine-2024/';

  test('parseDownloadLinks: extrai todos os botões de filme complexo com isolamento de áudio e fontes', () => {
    const html = fixture('comandotorrents-movie-complex.html');
    const links = comando.parseDownloadLinks(html, base);

    // 5 botões dublados/dual + 3 botões legendados = 8 botões de download válidos
    assert.equal(links.length, 8, 'links de Telegram e posts relacionados devem ser ignorados');

    // 1. 4K REMUX Dual
    assert.equal(links[0].url, 'https://videosad.net/go/ct-remux4k');
    assert.equal(links[0].quality, 2160);
    assert.equal(links[0].size, '52.4 GB');
    assert.equal(links[0].audio, 'dublado');
    assert.equal(links[0].source, 'REMUX');

    // 2. BluRay 1080p
    assert.equal(links[1].url, 'https://systemads1.com/go/ct-bluray1080');
    assert.equal(links[1].quality, 1080);
    assert.equal(links[1].size, '14.2 GB');
    assert.equal(links[1].audio, 'dublado');
    assert.equal(links[1].source, 'BLU-RAY');

    // 3. WEB-DL 1080p com redirect relativo
    assert.equal(links[2].url, 'https://comandotorrents.to/redirect?to=https%3A%2F%2Fvideosad.net%2Fgo%2Fct-web1080');
    assert.equal(links[2].quality, 1080);
    assert.equal(links[2].size!.replace(',', '.'), '2.8 GB');
    assert.equal(links[2].audio, 'dublado');
    assert.equal(links[2].source, 'WEB-DL');

    // 4. WEB-DL 720p
    assert.equal(links[3].url, 'https://canalfutebol.com/go/ct-web720');
    assert.equal(links[3].quality, 720);
    assert.equal(links[3].size, '1.20 GB');
    assert.equal(links[3].audio, 'dublado');
    assert.equal(links[3].source, 'WEB-DL');

    // 5. Direct Magnet Link
    assert.ok(links[4].url.startsWith('magnet:?xt=urn:btih:1111111111111111111111111111111111111111'));
    assert.equal(links[4].quality, 1080);
    assert.equal(links[4].size, '2.5 GB');
    assert.equal(links[4].audio, 'dublado');

    // 6. 4K WEBRip Legendado
    assert.equal(links[5].url, 'https://systemads.net/go/ct-leg4k');
    assert.equal(links[5].quality, 2160);
    assert.equal(links[5].size, '18.5 GB');
    assert.equal(links[5].audio, 'legendado');
    assert.equal(links[5].source, 'WEBRIP');

    // 7. WEB-DL 1080p Legendado
    assert.equal(links[6].url, 'https://videosad.net/go/ct-leg1080');
    assert.equal(links[6].quality, 1080);
    assert.equal(links[6].size, '2.1 GB');
    assert.equal(links[6].audio, 'legendado');

    // 8. WEB-DL 720p Legendado
    assert.equal(links[7].url, 'https://systemads1.com/go/ct-leg720');
    assert.equal(links[7].quality, 720);
    assert.equal(links[7].size, '950 MB');
    assert.equal(links[7].audio, 'legendado');
  });
});

describe('ComandoTorrents Parser: Episodic Series & Season Pack Resets', () => {
  const base = 'https://comandotorrents.to/the-boys-4a-temporada/';

  test('parseDownloadLinks: rastreia EPISÓDIO 01..08 e zera episódio em TEMPORADA COMPLETA', () => {
    const html = fixture('comandotorrents-series-episodic.html');
    const links = comando.parseDownloadLinks(html, base);

    assert.equal(links.length, 12);

    // Episódios 1 a 8
    for (let i = 0; i < 8; i += 1) {
      assert.equal(links[i].episode, i + 1, `link ${i} deve ser episódio ${i + 1}`);
      assert.equal(links[i].audio, 'dublado');
      assert.equal(links[i].quality, 1080);
    }

    // Packs da temporada dublada
    assert.equal(links[8].episode, null, 'temporada completa deve ter episode=null');
    assert.equal(links[8].size, '11.5 GB');
    assert.equal(links[8].audio, 'dublado');

    assert.equal(links[9].episode, null, 'temporada 4K completa deve ter episode=null');
    assert.equal(links[9].quality, 2160);
    assert.equal(links[9].size, '32.8 GB');

    // Seção Legendada: episódio 1 e pack
    assert.equal(links[10].episode, 1);
    assert.equal(links[10].audio, 'legendado');
    assert.equal(links[10].size, '850 MB');

    assert.equal(links[11].episode, null, 'pack legendado deve ter episode=null');
    assert.equal(links[11].audio, 'legendado');
    assert.equal(links[11].size, '6.8 GB');
  });

  test('parseDownloadLinks: botão explícito de episódio preserva número mesmo com palavra COMPLETO', () => {
    const html = '<a href="https://systemads1.com/go/ep10">EPISÓDIO 10 COMPLETO DUBLADO (1.2 GB)</a>';
    const links = comando.parseDownloadLinks(html, base);
    assert.equal(links.length, 1);
    assert.equal(links[0].episode, 10);
  });

  test('parseDownloadLinks: cabeçalho com Temporada Completa não zera botões subsequentes de episódios individuais', () => {
    const html = `
      <p>Abaixo os links para a Temporada Completa episódio por episódio:</p>
      <a href="https://systemads1.com/go/ep1">EPISÓDIO 01 (1.2 GB)</a>
      <a href="https://systemads1.com/go/ep2">EPISÓDIO 02 (1.2 GB)</a>
    `;
    const links = comando.parseDownloadLinks(html, base);
    assert.equal(links.length, 2);
    assert.equal(links[0].episode, 1);
    assert.equal(links[1].episode, 2);
  });
});

describe('ComandoTorrents Parser: Multi-Season Bundles', () => {
  const base = 'https://comandotorrents.to/breaking-bad-completa/';

  test('parseDownloadLinks: pacotes multi-temporada mantêm episode=null', () => {
    const html = fixture('comandotorrents-series-multiseason.html');
    const links = comando.parseDownloadLinks(html, base);

    assert.equal(links.length, 6);
    assert.deepEqual(
      links.map((l) => l.episode),
      [null, null, null, null, null, null],
      'nenhum botão de temporada completa ou multi-temporada deve conter número de episódio',
    );
    assert.deepEqual(
      links.map((l) => l.audio),
      ['dublado', 'dublado', 'dublado', 'dublado', 'dublado', 'legendado'],
    );
    assert.equal(links[0].size, '64.5 GB');
    assert.equal(links[4].quality, 2160);
  });
});

describe('ComandoTorrents Parser: Subtitled-Only Isolation', () => {
  const base = 'https://comandotorrents.to/parasita-2019/';

  test('parseDownloadLinks: post exclusivamente legendado não é contaminado por sinopse', () => {
    const html = fixture('comandotorrents-legendado-only.html');
    const links = comando.parseDownloadLinks(html, base);

    assert.equal(links.length, 3);
    assert.deepEqual(
      links.map((l) => l.audio),
      ['legendado', 'legendado', 'legendado'],
      'todos os links devem ser estritamente legendados',
    );

    const postTitle = 'Parasita Torrent (2019) Legendado WEB-DL 1080p / 4K';
    for (let i = 0; i < links.length; i += 1) {
      const generated = comando.releaseTitle(postTitle, links[i], i as any);
      assert.ok(generated.includes('LEGENDADO'), `releaseTitle deve conter LEGENDADO: ${generated}`);
      assert.ok(!/DUBLADO|Dual/i.test(generated), `releaseTitle não pode conter DUBLADO ou Dual: ${generated}`);
    }
  });
});
