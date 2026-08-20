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

describe('ComandoTorrents Parser: Title Cleaning & SEO Normalization', () => {
  test('cleanPostTitle: limpa resoluções, codecs, áudio e ruídos de SEO preservando pontuação legítima', () => {
    const cases = [
      {
        input: 'Deadpool & Wolverine Torrent – (2024) Dual Áudio 5.1 / Dublado WEB-DL 1080p / 4K Download Grátis Completo',
        expected: 'Deadpool & Wolverine (2024)',
      },
      {
        input: 'Blade Runner 2049 Torrent (2017) BluRay 1080p / 4K UHD 2160p Dual Áudio 7.1',
        expected: 'Blade Runner 2049 (2017)',
      },
      {
        input: '1917 Torrent – (2019) 1080p / 4K IMAX Dual Áudio 5.1 / Dublado BluRay',
        expected: '1917 (2019)',
      },
      {
        input: '2001: Uma Odisséia no Espaço Torrent (1968) 4K Ultra HD 2160p Remux Dublado',
        expected: '2001: Uma Odisséia no Espaço (1968)',
      },
      {
        input: 'WALL-E Torrent (2008) 1080p 3D Dual Áudio 5.1 Download',
        expected: 'WALL-E (2008)',
      },
      {
        input: 'X-Men &#8211; Dias de um Futuro Esquecido Torrent (2014) 1080p Dublado',
        expected: 'X-Men – Dias de um Futuro Esquecido (2014)',
      },
    ];

    for (const c of cases) {
      assert.equal(comando.cleanPostTitle(c.input), c.expected);
    }
  });

  test('releaseTitle: remove ruídos de SEO e formata tags corretamente', () => {
    const rawPost = 'Furiosa: Uma Saga Mad Max Torrent (2024) Dual Áudio 5.1 / Dublado WEB-DL 1080p / 4K Download Grátis';
    const link = { quality: 1080, source: 'WEB-DL', audio: 'dublado', size: '2.4 GB', episode: null };

    const title = comando.releaseTitle(rawPost, link);
    assert.equal(title, 'Furiosa: Uma Saga Mad Max (2024) [1080p WEB-DL DUBLADO 2.4 GB]');
  });

  test('releaseTitle: limpa delimitadores órfãos ao remover fonte redundante', () => {
    const rawPost = 'Alien: Romulus Torrent (2024) BluRay 1080p & 4K Dublado Download';
    const link = { quality: 2160, source: 'BLU-RAY', audio: 'dublado', size: '18.4 GB', episode: null };

    const title = comando.releaseTitle(rawPost, link);
    assert.equal(title, 'Alien: Romulus (2024) [2160p BLU-RAY DUBLADO 18.4 GB]');
  });

  test('releaseTitle: inclui marcador de episódio E01 para séries', () => {
    const rawPost = 'The Boys 4ª Temporada Torrent (2024) WEB-DL 1080p Dual Áudio';
    const link = { quality: 1080, source: 'WEB-DL', audio: 'dublado', size: '1.4 GB', episode: 1 };

    const title = comando.releaseTitle(rawPost, link);
    assert.equal(title, 'The Boys 4ª Temporada (2024) E01 [1080p WEB-DL DUBLADO 1.4 GB]');
  });

  test('releaseTitle: gera opção de numeração quando tamanho está ausente', () => {
    const rawPost = 'Interestelar Torrent (2014) BluRay 1080p Dublado';
    const link = { quality: 1080, source: 'BLU-RAY', audio: 'dublado', size: null, episode: null };

    const title = comando.releaseTitle(rawPost, link, 2 as any);
    assert.equal(title, 'Interestelar (2014) [1080p BLU-RAY DUBLADO opção 3]');
  });
});

describe('ComandoTorrents Parser: Feed Generation & Query Normalization', () => {
  test('searchPageHtml: formata linhas HTML com sentinela 1 KB quando tamanho é nulo', () => {
    const items = [
      {
        post: { url: 'https://comandotorrents.to/filme-1/', title: 'Filme 1' },
        link: { quality: 1080, audio: 'dublado', size: null, source: 'WEB-DL', episode: null },
        index: 0,
      },
    ];
    const html = comando.searchPageHtml(items);
    assert.ok(html.includes('<div class="size">1 KB</div>'));
    assert.ok(html.includes('<div class="seeders">1</div>'));
    assert.ok(html.includes('/resolve?url=https%3A%2F%2Fcomandotorrents.to%2Ffilme-1%2F&amp;i=0'));
  });

  test('normalizeQuery: remove SxxEyy, colons e preserva títulos válidos', () => {
    assert.equal(comando.normalizeQuery('Fallout S01E05'), 'Fallout');
    assert.equal(comando.normalizeQuery('The Last of Us: Season 1'), 'The Last of Us Season 1');
    assert.equal(comando.normalizeQuery('S1m0ne 2002'), 'S1m0ne 2002');
  });

  test('parseSize: converte unidades em português com precisão', () => {
    assert.equal(comando.parseSize('52.4 GB'), Math.round(52.4 * 1024 ** 3));
    assert.equal(comando.parseSize('2,8 GB'), Math.round(2.8 * 1024 ** 3));
    assert.equal(comando.parseSize('950 MB'), 950 * 1024 ** 2);
    assert.equal(comando.parseSize('1.5 TB'), Math.round(1.5 * 1024 ** 4));
    assert.equal(comando.parseSize('500 KB'), 500 * 1024);
    assert.equal(comando.parseSize('invalido'), null);
  });
});


describe('ComandoTorrents Parser: isGenericListPost (índices genéricos)', () => {
  test('rejeita cards de índice genérico do catálogo', () => {
    const generic = [
      'Lista De Filmes – Ação, Terror, Aventura, Guerra, Drama, Comédia',
      'Listão de Filmes Dublado – Ação,Terror,Aventura,Guerra,Drama,Comédia… Torrent Download BDRip',
      'Lista de Séries',
      'Índice de Filmes',
    ];
    for (const title of generic) {
      assert.equal(comando.isGenericListPost(title), true, `deve rejeitar índice genérico: ${title}`);
    }
  });

  test('rejeita variações de acento, caixa e separador do mesmo índice', () => {
    const variations = [
      // caixa baixa / alta do título com enumeração de gêneros
      'lista de filmes – ação, terror, aventura, guerra, drama, comédia',
      'LISTA DE FILMES – AÇÃO, TERROR, AVENTURA, GUERRA, DRAMA, COMÉDIA',
      // forma mínima sem a enumeração de gêneros
      'Lista de Filmes',
      'LISTA DE FILMES',
      // séries com e sem acento, com e sem enumeração
      'Lista de Séries',
      'lista de séries',
      'LISTA DE SÉRIES',
      'Lista de Series',
      'Lista de Séries – Terror e Suspense',
      // índice com e sem acento
      'Índice de Filmes',
      'índice de filmes',
      'Indice de Filmes',
      'INDICE DE FILMES',
      // separadores alternativos (hífen, travessão, dois-pontos)
      'Lista De Filmes - Ação, Terror, Aventura, Guerra, Drama, Comédia',
      'Lista de Filmes: Ação, Terror, Aventura, Guerra, Drama, Comédia',
    ];
    for (const title of variations) {
      assert.equal(comando.isGenericListPost(title), true, `deve rejeitar variação: ${title}`);
    }
  });

  test('aceita releases normais', () => {
    const releases = [
      'Deadpool & Wolverine Torrent – (2024) Dual Áudio 5.1 / Dublado WEB-DL 1080p / 4K',
      'The Boys 4ª Temporada Torrent (2024) WEB-DL 1080p Dual Áudio',
      'Furiosa: Uma Saga Mad Max Torrent (2024) Dual Áudio 5.1 / Dublado WEB-DL 1080p / 4K',
      'Alien: Romulus Torrent (2024) BluRay 1080p & 4K Dublado',
    ];
    for (const title of releases) {
      assert.equal(comando.isGenericListPost(title), false, `deve aceitar release normal: ${title}`);
    }
  });

  test('aceita títulos em que "Lista" faz parte do nome real, não do índice', () => {
    const real = [
      'Lista de Schindler (1993)',
      'A Lista de Schindler Torrent (1993) 1080p Dublado',
      'Lista de Filmes do Cliente', // curadoria específica, não índice do catálogo
    ];
    for (const title of real) {
      assert.equal(comando.isGenericListPost(title), false, `deve aceitar título real: ${title}`);
    }
  });

  test('aceita entrada vazia ou sem título (defensivo)', () => {
    assert.equal(comando.isGenericListPost(''), false);
    assert.equal(comando.isGenericListPost(null as any), false);
    assert.equal(comando.isGenericListPost(undefined), false);
  });
});

describe('ComandoTorrents Parser: Integração — índice genérico vs MAX_POSTS', () => {
  let server: any;
  let port: any;
  let originalFetch: any;

  // Mesmo default do server.js; se o env estiver setado os dois leem igual.
  const MAX_POSTS = Number(process.env.MAX_POSTS || 5);

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    comando.searchCache.clear();
    comando.postCache.clear();
    comando.magnetCache.clear();
    comando.inFlight.clear();

    // Página de busca do WordPress com o card de índice genérico em PRIMEIRO
    // lugar (pior caso: sem filtro ele roubaria a vaga 0) e exatamente
    // MAX_POSTS releases reais depois.
    const genericCard = `
      <article class="post blog-view type-post">
        <h2 class="entry-title">
          <a href="https://comandotorrents.to/lista-de-filmes/" title="Lista De Filmes – Ação, Terror, Aventura, Guerra, Drama, Comédia">Lista De Filmes – Ação, Terror, Aventura, Guerra, Drama, Comédia</a>
        </h2>
      </article>`;
    const realCards = Array.from({ length: MAX_POSTS }, (_, i) => `
      <article class="post blog-view type-post">
        <h2 class="entry-title">
          <a href="https://comandotorrents.to/filme-real-${i + 1}/" title="Filme Real ${i + 1} Torrent (2024) 1080p Dublado WEB-DL">Filme Real ${i + 1} Torrent (2024) 1080p Dublado WEB-DL</a>
        </h2>
      </article>`).join('');

    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;
      if (u.includes('/?s=')) {
        return {
          ok: true,
          status: 200,
          text: async () => `<html><body>${genericCard}${realCards}</body></html>`,
        };
      }
      if (u.includes('comandotorrents.to/')) {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <div class="entry-content">
              <h3>DUBLADO</h3>
              <p>1080p (2.0 GB)</p>
              <a href="https://systemads1.com/go/btn">Download</a>
            </div>
          `,
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    server = comando.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const requestHttp = (pathname: string) =>
    new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
    });

  test('GET /search: card genérico não ocupa vaga antes de MAX_POSTS', async () => {
    const res = await requestHttp(`/search?q=${encodeURIComponent('Filme Real')}`);
    assert.equal(res.status, 200);

    assert.ok(
      !res.body.includes('Lista De Filmes'),
      'o índice genérico não pode entrar no feed (ele apareceria antes de MAX_POSTS)',
    );

    for (let i = 1; i <= MAX_POSTS; i += 1) {
      assert.ok(
        res.body.includes(`Filme Real ${i}`),
        `release real ${i} deve estar presente — o genérico não pode ter roubado a vaga`,
      );
    }
  });
});
