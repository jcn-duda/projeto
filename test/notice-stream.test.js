const { test } = require('node:test');
const assert = require('node:assert');

const { buildStreams } = require('../src/providers');
const { hasExplicitForeignAudio } = require('../src/utils/format');
const debrid = require('../src/debrid');
const runtime = require('../src/runtime');
const config = require('../src/config');

const A = 'a'.repeat(40);

// O aviso só existe para explicar uma lista que ficaria vazia. Os três estados
// são excludentes e a ordem importa: "já mandei baixar" é mais preciso que
// "cortei por cache", que é mais preciso que "ainda não achei".
async function build(raw, { season = 1, episode = 1, cached = [], cachedOnly = true } = {}) {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = 'https://addon.teste';
  debrid.checkCached = async () => ({ cached: new Set(cached), known: true });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
    debridCachedOnly: cachedOnly,
    autoFetchBr: false,
  };
  try {
    return await runtime.run({ opts: userOpts, encoded: 'segcfg' }, () =>
      buildStreams(raw, {
        meta: null,
        titles: null,
        season,
        episode,
        isDemo: false,
        searchKey: `aviso-${Math.random()}`,
      }));
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
  }
}

const episodio = (extra = {}) => ({
  title: 'Lost Girl S01E01 HDTV XviD',
  infoHash: A,
  seeders: 1,
  indexer: 'thepiratebay',
  ...extra,
});

test('série sem nenhum candidato avisa que a temporada está sendo procurada', async () => {
  const streams = await build([]);
  assert.equal(streams.length, 1);
  assert.match(streams[0].name, /procurando a temporada/);
  // Não pode parecer tocável: cliente que aceita infoHash tentaria dar play.
  assert.equal(streams[0].url, undefined);
  assert.equal(streams[0].infoHash, undefined);
  assert.ok(streams[0].externalUrl);
});

test('filme sem candidato NÃO recebe aviso: não há busca de pack para prometer', async () => {
  const streams = await build([], { season: null, episode: null });
  assert.deepEqual(streams, []);
});

test('candidato cortado pelo cachedOnly avisa quantos ficaram de fora', async () => {
  const streams = await build([episodio()]);
  assert.equal(streams.length, 1);
  assert.match(streams[0].name, /1 resultado\(s\) fora do cache/);
});

test('com fonte tocável não há aviso nenhum', async () => {
  const streams = await build([episodio()], { cached: [A] });
  assert.equal(streams.length, 1);
  assert.doesNotMatch(streams[0].name, /procurando a temporada|fora do cache/);
});

// Gatilho da busca tardia de pack: a saúde do episódio é seeders E idioma.
// Medido em Lost Girl S01E01 — um "FRENCH HDTV" de 12 seeders passava do piso
// sozinho e desligava o pack, deixando a lista em francês, holandês e 272p.
test('release estrangeira não conta como candidato saudável', () => {
  const saudavel = (title, seeders) =>
    seeders >= config.search.packMinSeeders && !hasExplicitForeignAudio(title);

  assert.equal(saudavel('Lost Girl S01E01 FRENCH HDTV XviD-Scaph', 12), false);
  assert.equal(saudavel('Lost Girl S01E01 VOSTFR HDTV', 30), false);
  // MULTI e DUAL carregam a faixa original: continuam valendo como saudáveis.
  assert.equal(saudavel('Lost Girl S01E01 MULTI 1080p', 12), true);
  assert.equal(saudavel('Lost Girl S01E01 DUAL 1080p', 12), true);
  // Marca PT tem precedência sobre a lista de idiomas.
  assert.equal(saudavel('Lost Girl S01E01 1080p Dublado FRENCH', 12), true);
  // Sem marca de idioma, quem manda é o piso de seeders.
  assert.equal(saudavel('Lost Girl S01E01 720p HDTV', 12), true);
  assert.equal(saudavel('Lost Girl S01E01 720p HDTV', 1), false);
});
