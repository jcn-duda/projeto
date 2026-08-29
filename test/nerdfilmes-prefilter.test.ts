import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Pré-filtro do resolver NerdFilmes.
 *
 * O WordPress casa por conteúdo e devolve posts "parecidos" para query curta:
 * buscar "show bar" trazia 5 posts irrelevantes (O Rei do Show, O Mago do
 * Kremlin, Only Murders in the Building, A Filha do Palhaço e SDL), estourados
 * em ~16 releases na tela manual do Jackett. O pré-filtro do resolver recusa o
 * que claramente não é a obra ANTES de gastar MAX_POSTS e de pagar os
 * protetores de link. Estes testes cobrem os helpers EXPORTADOS do resolver
 * (matchesResolverQuery, normalizeSeasonValue, matchesSeasonSeason e
 * selectSearchPosts) — sem rede: as funções são puras, e o único teste que
 * sobe o servidor stubba o fetch com fixtures.
 *
 * Semântica alinhada ao matchesName do addon (src/utils/format.js), portada
 * localmente porque o contêiner standalone copia só o server.js. O addon
 * continua autoritativo: o pré-filtro só derruba o que com certeza não é a
 * obra (não endurece spin-off/ano/episódio além disso).
 */
import nerd from '../nerdfilmes-resolver/server.js';

// Helper para montar o HTML de busca no mesmo formato que parsePosts espera
// (article.col > .image > a[title]).
function searchHtml(posts: any) {
  return posts
    .map(
      ({ title, url }: any) =>
        `<article class="col"><div class="image"><a title="${title}" href="${url}"></a></div></article>`,
    )
    .join('');
}

// Post de detalhe com um botão de magnet direto (layout novo do site).
const POST_HTML = `
  <h3>DUAL ÁUDIO</h3>
  <p>EPISÓDIO 01</p>
  <p><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=ep01.1080p">1080p Dublado</a></p>
`;

// Os 5 posts reais da busca "show bar" (capturados ao vivo em 2026-08-16).
const SHOW_BAR_POSTS = [
  'O Rei do Show (2017)',
  'O Mago do Kremlin (2026)',
  'Only Murders in the Building 3ª Temporada (2023)',
  'A Filha do Palhaço (2024)',
  'SDL: A Batalha Musical (2024)',
];

// Cache do resolver persiste entre testes; fixtures usam URLs únicas, mas
// limpar garante que um teste não herda resultado do anterior.
beforeEach(() => {
  nerd.cache.clear();
  nerd.inFlight.clear();
});

// 1. Os 5 posts reais de "show bar" são rejeitados.
test('nerdfilmes pré-filtro: os 5 posts reais de "show bar" são rejeitados', () => {
  for (const title of SHOW_BAR_POSTS) {
    // "show bar" → tokens pedidos ["show", "bar"]; só "O Rei do Show" tem 1/2
    // (0,5 < 0,6) e os outros 0 — todos caem no corte de cobertura.
    assert.equal(nerd.matchesResolverQuery({ title }, 'show bar'), false, title);
  }

  // A mesma decisão no pipeline: o filtro zera o lixo ANTES do slice.
  const html = searchHtml(
    SHOW_BAR_POSTS.map((title, i) => ({ title, url: `https://www.xnerdfilmes.net/lixo-${i}/` })),
  );
  assert.deepEqual(nerd.selectSearchPosts(html, 'show bar', null), []);
});

// 1b. O /resolve do nerd por índice de botão resolve o magnet DIRETO do post.
// Regressão do item 9 passo 4: a migração para o núcleo release-format passou a
// chamar magnetButtonCacheKey no resolveButton sem importá-lo — o ReferenceError
// derrubava /resolve e /dl com 502, e NENHUM teste exercitava o caminho (o
// resolveButton é interno do perfil, então o teste vai pela rota HTTP real).
test('nerdfilmes /resolve?i=0: magnet direto do post (import de magnetButtonCacheKey)', async () => {
  const realFetch = global.fetch;
  global.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith('/casa-1/')) {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => POST_HTML };
    }
    throw new Error(`fetch inesperado: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const server = nerd.createServer() as http.Server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode as number, body }));
        })
        .on('error', reject);
    });

  try {
    const url = encodeURIComponent('https://www.xnerdfilmes.net/casa-1/');
    const res = await get(`/resolve?url=${url}&i=0`);
    assert.equal(res.status, 200, 'resolve com botão índice 0 responde 200');
    assert.match(
      res.body,
      /^magnet:\?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01\.1080p$/,
      'corpo é o magnet direto do botão 0 normalizado',
    );
  } finally {
    global.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// 2. A Casa do Dragão (temporadas) passa; Caverna do Dragão e A Arte do Amor não.
test('nerdfilmes pré-filtro: A Casa do Dragão passa; Caverna do Dragão e A Arte do Amor não', () => {
  const query = 'A Casa do Dragão';
  // Tokens pedidos viram ["casa", "dragao"] (artigos "a"/"do" ficam de fora).
  assert.equal(
    nerd.matchesResolverQuery({ title: 'A Casa do Dragão 1ª Temporada (2022)' }, query),
    true,
  );
  assert.equal(
    nerd.matchesResolverQuery({ title: 'A Casa do Dragão 2ª Temporada (2024)' }, query),
    true,
  );
  // "Caverna do Dragão" só casa "dragao" (1/2) e "A Arte do Amor" nada (0/2).
  assert.equal(
    nerd.matchesResolverQuery({ title: 'Caverna do Dragão: Coleção Completa (1983)' }, query),
    false,
  );
  assert.equal(nerd.matchesResolverQuery({ title: 'A Arte do Amor (2024)' }, query), false);
});

// 3. Query EN "Rick and Morty" casa com o título PT; o spin-off O Anime segue
//    passando no pré-filtro (o corte fino é do addon, que tem allNames).
test('nerdfilmes pré-filtro: query EN "Rick and Morty" casa com título PT e o spin-off continua passando', () => {
  const query = 'Rick and Morty';
  // Tokens pedidos ["rick", "and", "morty"]: "and" não casa no título PT, mas
  // 2/3 = 0,667 ≥ 0,6 — razão inteira, nunca pedaço de palavra.
  assert.equal(nerd.matchesResolverQuery({ title: 'Rick e Morty 6ª Temporada (2022)' }, query), true);
  assert.equal(
    nerd.matchesResolverQuery({ title: 'Rick e Morty: O Anime 1ª Temporada (2024)' }, query),
    true,
    'o spin-off NÃO é rejeitado no resolver — quem decide é o addon',
  );
});

// 4. Artigos, acentos, sequência em pt ("O Auto da Compadecida 2") e título
//    curto legítimo passam.
test('nerdfilmes pré-filtro: artigos, acentos, O Auto da Compadecida 2 e título curto passam', () => {
  // Artigo inicial nos dois lados e sequência: "2" sobra mas não derruba.
  assert.equal(
    nerd.matchesResolverQuery({ title: 'O Auto da Compadecida 2 (2024)' }, 'O Auto da Compadecida 2'),
    true,
  );
  // Acento some na normalização NFD (Coração → coracao), dos dois lados.
  assert.equal(nerd.matchesResolverQuery({ title: 'O Coração de Fogo (2024)' }, 'Coração de Fogo'), true);
  // Título curto de uma palavra: "bar" É o título, não ruído a descartar.
  assert.equal(nerd.matchesResolverQuery({ title: 'Bar (2020)' }, 'Bar'), true);
  // Query que só sobra com ruído curto continua casando por token inteiro.
  assert.equal(nerd.matchesResolverQuery({ title: 'O Coração de Fogo (2024)' }, 'O coração de fogo'), true);
});

// 5. O ano final da query não participa da cobertura: filme com ano BR ±2 passa.
test('nerdfilmes pré-filtro: o ano final da query não participa da cobertura (±2)', () => {
  // O ano é contexto de lançamento, não título: "Coringa 2019" vira só
  // ["coringa"] antes de medir cobertura.
  assert.deepEqual(nerd.stripTrailingYears(['coringa', '2019']), ['coringa']);
  assert.deepEqual(nerd.computeWantedTokens('Coringa 2019'), ['coringa']);

  // Ano do post pode divergir do ano da query (lançamento nacional ±2): a
  // cobertura mede o título, nunca o ano.
  assert.equal(nerd.matchesResolverQuery({ title: 'Coringa (2019)' }, 'Coringa 2019'), true);
  assert.equal(nerd.matchesResolverQuery({ title: 'Coringa (2020)' }, 'Coringa 2019'), true);
  assert.equal(nerd.matchesResolverQuery({ title: 'Coringa (2021)' }, 'Coringa 2019'), true);

  // "Blade Runner 2049 2017": o 2049 é PARTE do título, não ano de lançamento —
  // o strip remove só o 2017 e o 2049 permanece na cobertura.
  assert.deepEqual(nerd.computeWantedTokens('Blade Runner 2049 2017'), ['blade', 'runner', '2049']);
  assert.equal(
    nerd.matchesResolverQuery({ title: 'Blade Runner 2049 (2017)' }, 'Blade Runner 2049 2017'),
    true,
  );

  // Filme cujo TÍTULO é um ano ("1917"): a query "1917 2019" remove só o 2019
  // e o título-ano fica na cobertura.
  assert.deepEqual(nerd.computeWantedTokens('1917 2019'), ['1917']);
  assert.equal(nerd.matchesResolverQuery({ title: '1917 (2019)' }, '1917 2019'), true);

  // Query manual só com o ano ("1917", "2012") preserva o token: não é seguro
  // decidir que ele é ruído, e querer lista vazia aceitaria QUALQUER post.
  assert.deepEqual(nerd.computeWantedTokens('1917'), ['1917']);
  assert.deepEqual(nerd.computeWantedTokens('2012'), ['2012']);
  // ...mas o token preservado continua filtrando: post aleatório não casa.
  assert.equal(nerd.matchesResolverQuery({ title: 'O Mago do Kremlin (2026)' }, '1917'), false);
  assert.equal(nerd.matchesResolverQuery({ title: 'O Rei do Show (2017)' }, '2012'), false);
});

// 6. requestedSeason chega em três formas (array do match, string, número).
test('nerdfilmes pré-filtro: normalizeSeasonValue aceita match array, string e número', () => {
  // O array é o que `rawQuery.match(...)` devolve: valor útil em [1].
  assert.equal(nerd.normalizeSeasonValue(['S02', '2']), 2);
  assert.equal(nerd.normalizeSeasonValue(['S2', '2']), 2);
  assert.equal(nerd.normalizeSeasonValue('2'), 2);
  assert.equal(nerd.normalizeSeasonValue(2), 2);
  // Fora dos casos válidos, null = sem filtro (não rejeitar tudo por NaN).
  assert.equal(nerd.normalizeSeasonValue('abc'), null);
  assert.equal(nerd.normalizeSeasonValue(''), null);
  assert.equal(nerd.normalizeSeasonValue(0), null);
  assert.equal(nerd.normalizeSeasonValue(-1), null);
  assert.equal(nerd.normalizeSeasonValue(NaN), null);
  assert.equal(nerd.normalizeSeasonValue([]), null);

  // O filtro em si usa o valor normalizado em qualquer das formas.
  const title = 'A Casa do Dragão 2ª Temporada (2024)';
  assert.equal(nerd.matchesSeasonSeason({ title }, ['S02', '2']), true);
  assert.equal(nerd.matchesSeasonSeason({ title }, '2'), true);
  assert.equal(nerd.matchesSeasonSeason({ title }, 2), true);
  // Temporada marcada errada morre; sem marcador (teste 7) passa.
  assert.equal(nerd.matchesSeasonSeason({ title: 'A Casa do Dragão 1ª Temporada (2022)' }, 2), false);
});

// 7. Post sem marcador de temporada passa (pack/desconhecido, como o
//    matchesEpisode do addon).
test('nerdfilmes pré-filtro: post sem marcador de temporada passa', () => {
  assert.equal(nerd.matchesSeasonSeason({ title: 'A Casa do Dragão (2022)' }, 2), true);
  assert.equal(nerd.matchesSeasonSeason({ title: 'A Casa do Dragão 1ª Temporada (2022)' }, 2), false);
});

// 8. A temporada entra ANTES do slice(MAX_POSTS): se o slice viesse primeiro,
//    5 posts de temporadas erradas tomariam as vagas e a temporada pedida
//    (que veio depois) sumiria.
test('nerdfilmes pré-filtro: a temporada entra antes do slice(MAX_POSTS)', () => {
  const wrong = [
    'A Casa do Dragão 3ª Temporada (2024)',
    'A Casa do Dragão 4ª Temporada (2025)',
    'A Casa do Dragão 5ª Temporada (2026)',
    'A Casa do Dragão 6ª Temporada (2027)',
    'A Casa do Dragão 7ª Temporada (2028)',
  ];
  const right = [
    'A Casa do Dragão 2ª Temporada (2024)',
    'A Casa do Dragão 2ª Temporada (2025)',
  ];
  const posts = [
    ...wrong.map((title, i) => ({ title, url: `https://www.xnerdfilmes.net/errada-${i}/` })),
    ...right.map((title, i) => ({ title, url: `https://www.xnerdfilmes.net/certa-${i}/` })),
  ];
  // O array do match é o que a rota passa de verdade (handleApi/handleSearch).
  const selected = nerd.selectSearchPosts(searchHtml(posts), 'A Casa do Dragão', ['S02', '2']);

  assert.equal(selected.length, 2, 'as duas temporadas 2ª sobrevivem ao slice');
  assert.deepEqual(
    selected.map((post) => post.title),
    right,
  );
});

// 9. O filtro de título entra ANTES do slice(MAX_POSTS): posts relevantes
//    depois de vários lixos ainda entram.
test('nerdfilmes pré-filtro: o título entra antes do slice(MAX_POSTS)', () => {
  const posts = [
    ...SHOW_BAR_POSTS.map((title, i) => ({ title, url: `https://www.xnerdfilmes.net/lixo-${i}/` })),
    { title: 'A Casa do Dragão 1ª Temporada (2022)', url: 'https://www.xnerdfilmes.net/casa-1/' },
    { title: 'A Casa do Dragão 2ª Temporada (2024)', url: 'https://www.xnerdfilmes.net/casa-2/' },
  ];

  const selected = nerd.selectSearchPosts(searchHtml(posts), 'A Casa do Dragão', null);

  assert.equal(selected.length, 2, 'os 5 lixos são cortados antes de gastar as vagas');
  assert.deepEqual(
    selected.map((post) => post.title),
    ['A Casa do Dragão 1ª Temporada (2022)', 'A Casa do Dragão 2ª Temporada (2024)'],
  );
});

// 10. Os DOIS caminhos (/search e /api) aplicam o mesmo helper — sem rede:
//     o fetch é stubado com fixtures e o servidor escuta em loopback.
test('nerdfilmes pré-filtro: /search e /api aplicam o mesmo helper (fetch stubado)', async () => {
  const posts = [
    ...SHOW_BAR_POSTS.map((title, i) => ({ title, url: `https://www.xnerdfilmes.net/lixo-${i}/` })),
    { title: 'A Casa do Dragão 1ª Temporada (2022)', url: 'https://www.xnerdfilmes.net/casa-1/' },
  ];
  const search = searchHtml(posts);

  // Só o post relevante tem página de detalhe registrada: se algum lixo passar
  // pelo filtro, o fetch stubado lança e a rota responde 502 — o teste falha.
  const realFetch = global.fetch;
  global.fetch = (async (input: any) => {
    // fetchText chama fetch(URL) com um objeto URL, não string; String()
    // normaliza os dois casos (e Request) para o href completo.
    const url = String(input);
    if (url.includes('/?s=')) {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => search };
    }
    if (url.endsWith('/casa-1/')) {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => POST_HTML };
    }
    throw new Error(`fetch inesperado: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const server = nerd.createServer() as http.Server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode as number, body }));
        })
        .on('error', reject);
    });

  try {
    const q = encodeURIComponent('A Casa do Dragão');
    const [searchRes, apiRes] = await Promise.all([
      get(`/search?q=${q}`),
      get(`/api?t=search&q=${q}`),
    ]);

    // Tupla explicita: sem ela o literal mistura string com o corpo e o
    // loop nao enxerga status/body.
    const checks: [string, { status: number; body: string }, string][] = [
      ['/search', searchRes, 'class="release"'],
      ['/api', apiRes, '<item>'],
    ];
    for (const [label, res, marker] of checks) {
      assert.equal(res.status, 200, `${label} responde 200 (nenhum lixo pediu fetch)`);
      assert.match(res.body, /A Casa do Dragão 1ª Temporada \(2022\)/, `${label} mantém o post relevante`);
      for (const garbage of SHOW_BAR_POSTS) {
        assert.doesNotMatch(
          res.body,
          new RegExp(garbage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `${label} corta ${garbage}`,
        );
      }
      assert.equal(
        (res.body.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length,
        1,
        `${label} expande exatamente 1 release (só o post relevante)`,
      );
    }
  } finally {
    global.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});