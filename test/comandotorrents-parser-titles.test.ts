import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import comando from '../comandotorrents-resolver/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: any) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

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

