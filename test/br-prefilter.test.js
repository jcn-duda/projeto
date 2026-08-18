const { test } = require('node:test');
const assert = require('node:assert/strict');

const resolvers = {
  bludv: require('../bludv-resolver/server'),
  comandotorrents: require('../comandotorrents-resolver/server'),
  nerdfilmes: require('../nerdfilmes-resolver/server'),
  torrentdosfilmes: require('../torrentdosfilmes-resolver/server'),
};

// O pré-filtro por query só derruba o catálogo quando a query NÃO parece
// gênero: buscar "filmes de terror" casa "Listão De Filmes – Ação,Terror,…"
// em 100% dos tokens e o post volta inteiro (verificado ao vivo no
// torrentdosfilmes). Por isso o corte por ESTRUTURA do título é separado e
// roda no parsePosts, independente do que foi pesquisado.
const genreQueries = ['filmes de terror', 'aventura e guerra', 'filmes acao'];

const catalog = 'Listão De Filmes – Ação,Terror,Aventura,Guerra,Drama,Comedia';

function htmlFor(name, posts) {
  if (name === 'bludv') return posts.map((p) => `<div class="post"><div class="title"><a href="${p.url}">${p.title}</a></div></div>`).join('');
  if (name === 'comandotorrents') return posts.map((p) => `<article class="blog-view"><h2 class="entry-title"><a href="${p.url}">${p.title}</a></h2></article>`).join('');
  if (name === 'nerdfilmes') return posts.map((p) => `<article class="col"><div class="image"><a href="${p.url}" title="${p.title}"></a></div></article>`).join('');
  return posts.map((p) => `<div class="title"><a href="${p.url}">${p.title}</a></div>`).join('');
}

for (const [name, resolver] of Object.entries(resolvers)) {
  test(`${name}: post-catálogo não passa pelo pré-filtro de obra`, () => {
    assert.equal(resolver.matchesResolverQuery({ title: catalog }, 'Jornada nas Estrelas O Filme'), false);
  });

  test(`${name}: ano final da query não derruba release legítima`, () => {
    assert.deepEqual(resolver.stripTrailingYears(['coringa', '2019']), ['coringa']);
    assert.equal(resolver.matchesResolverQuery({ title: 'Coringa (2020)' }, 'Coringa 2019'), true);
  });

  test(`${name}: temporada divergente cai e post sem temporada passa`, () => {
    assert.equal(resolver.matchesSeasonSeason({ title: 'A Casa do Dragão 1ª Temporada' }, ['S02', '2']), false);
    assert.equal(resolver.matchesSeasonSeason({ title: 'A Casa do Dragão' }, ['S02', '2']), true);
  });

  test(`${name}: filtros acontecem antes do limite de posts`, () => {
    const posts = [
      ...Array.from({ length: 5 }, (_, i) => ({ title: `${catalog} ${i}`, url: `https://site.test/lixo-${i}` })),
      { title: 'A Casa do Dragão 2ª Temporada', url: 'https://site.test/certa' },
    ];
    const selected = resolver.selectSearchPosts(htmlFor(name, posts), 'A Casa do Dragão', ['S02', '2']);
    assert.deepEqual(selected.map((post) => post.title), ['A Casa do Dragão 2ª Temporada']);
  });

  test(`${name}: catálogo cai pela estrutura do título, com ou sem entidade HTML`, () => {
    assert.equal(resolver.isGenericListPost(catalog), true);
    assert.equal(resolver.isGenericListPost('Listão De Filmes &#8211; Ação,Terror&#8230;'), true);
  });

  test(`${name}: query de gênero não reabre o catálogo`, () => {
    for (const query of genreQueries) {
      // O pré-filtro por query sozinho deixa passar — é o buraco que motivou
      // o corte estrutural.
      assert.equal(resolver.matchesResolverQuery({ title: catalog }, query), true, query);
      // Já o parsePosts derruba o post antes de qualquer expansão de botão.
      const html = htmlFor(name, [{ title: catalog, url: 'https://site.test/listao' }]);
      assert.deepEqual(resolver.selectSearchPosts(html, query), [], query);
    }
  });

  test(`${name}: título que só contém "lista" sobrevive`, () => {
    assert.equal(resolver.isGenericListPost('A Lista de Schindler'), false);
    assert.equal(resolver.isGenericListPost('Lista de Filmes do Cliente'), false);
  });
}
