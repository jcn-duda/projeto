// Fase 1: pool global Torrentio. Contrato do src/providers/torrentio.ts testado
// com fetch falso e config mutável (igual ao jackett-provider.test.ts): endpoint
// público SEM segmento/config/credencial de debrid, parsing/limpeza do `title`,
// dedupe por hash e circuit breaker local (falha abre, cooldown meia-abre).
// O módulo é importável sem subir servidor e nada aqui toca rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import * as torrentio from '../src/providers/torrentio.js';
import { collectRaw } from '../src/providers/search-orchestrator.js';
import { filterRelevantRaw } from '../src/utils/format.js';
import * as runtime from '../src/runtime.js';
import { stubFetch } from './helpers/stub.js';
import type { RawItem } from '../types/domain.js';

// Emojis da linha de metadados do Torrentio por escape \u{...}: a fonte guarda
// os caracteres literais; aqui os mesmos valores, para não depender de
// codificação de console/pipeline no momento da gravação do arquivo.
const META_USER = '\u{1F464}'; // 👤 seeders
const META_DISK = '\u{1F4BE}'; // 💾 tamanho
const META_GEAR = '\u{2699}\u{FE0F}'; // ⚙️ fonte

const HASH_LOWER = 'a'.repeat(40);
const HASH_UPPER = HASH_LOWER.toUpperCase();

function okPayload(streams: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ streams }) };
}

/** Item cru como o Torrentio devolve no array `streams`. */
function stream(title: string, opts: { infoHash?: string; fileIdx?: number; name?: string } = {}) {
  return { title, infoHash: opts.infoHash ?? HASH_LOWER, name: opts.name, fileIdx: opts.fileIdx };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('filme monta URL pública sem segmento/config/credencial', async () => {
  const stub = stubFetch((url) => {
    assert.ok(url.startsWith(config.torrentio.url), 'URL precisa começar no host público do torrentio');
    assert.match(url, /\/stream\/movie\/tt6791350\.json$/, 'rota de filme precisa casar /stream/movie/<id>.json');
    // Credencial/config não podem aparecer: nada do usuário sai do processo.
    assert.equal(url.includes('realdebrid='), false, 'sem segmento de config do Torrentio na URL');
    assert.equal(url.includes('apiKey'), false, 'sem credencial de debrid no endpoint');
    return okPayload([]);
  });
  try {
    const out = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.deepEqual(out, []);
    assert.equal(stub.calls.length, 1, 'uma única consulta para o filme');
  } finally {
    stub.restore();
  }
});

test('série monta /stream/series/<id>:<S>:<E>.json sem config', async () => {
  const stub = stubFetch((url) => {
    assert.match(url, /\/stream\/series\/tt6791350:3:1\.json$/, 'rota série com season:episode');
    assert.equal(url.includes('realdebrid='), false, 'URL série sem config/debrid');
    return okPayload([]);
  });
  try {
    await torrentio.search({ type: 'series', imdbId: 'tt6791350', season: 3, episode: 1 });
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('endpoint sem dados suficientes não sai de rede (filme sem imdbId / série sem episode)', async () => {
  const stub = stubFetch((url) => {
    assert.fail('não deve haver rede quando a URL de endpoint é inválida: ' + url);
    return okPayload([]);
  });
  try {
    const movie = await torrentio.search({ type: 'movie', imdbId: '' });
    assert.deepEqual(movie, []);
    const noEp = await torrentio.search({ type: 'series', imdbId: 'tt6791350', season: 3 });
    assert.deepEqual(noEp, []);
    assert.equal(stub.calls.length, 0, 'nenhuma rede em endpoint inválido');
  } finally {
    stub.restore();
  }
});

test('parser preserva linhas de arquivo/anotação e remove a linha de metadados', async () => {
  const meta = META_USER + ' 1,234 ' + META_DISK + ' 2.4 GB ' + META_GEAR + ' Torrentio';
  const payload = [
    stream(meta + '\nGuardiões da Galáxia Vol. 3 (2023) [4K] [Dual] [RD+]\narquivo1.mkv\narquivo2.mkv', {
      infoHash: HASH_UPPER,
      fileIdx: 2,
    }),
  ];
  const stub = stubFetch(() => okPayload(payload));
  try {
    const out = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.equal(out.length, 1);
    const item = out[0]!;
    // A linha de arquivo e os anotações sobrevivem; só a linha 👤💾⚙️ sai.
    assert.equal(
      item.title,
      'Guardiões da Galáxia Vol. 3 (2023) [4K] [Dual] [RD+]\n' + 'arquivo1.mkv\n' + 'arquivo2.mkv',
      'title preserva arquivo/anotação e perde só a linha de metadados',
    );
    assert.equal(item.seeders, 1234, 'seeders extraídos com separador de milhar');
    assert.equal(item.size!, Math.round(2.4 * 1024 ** 3), 'tamanho em bytes');
    assert.equal(item.tracker, 'Torrentio', 'rótulo de origem é o que vem depois do gear');
    assert.equal(item.indexer, 'torrentio', 'indexer identifica o provider agregador');
    assert.equal(item.fileIdx, 2, 'fileIdx preservado inteiro');
    assert.equal(item.infoHash, HASH_LOWER, 'hash normalizado para minúsculas');
  } finally {
    stub.restore();
  }
});

test('item sem hash válido não entra no resultado', async () => {
  const payload = [
    stream('Não deixa passar', { infoHash: 'não-é-hash', fileIdx: 0 }),
    stream('Coisa boa', { infoHash: 'abc' }),
  ];
  const stub = stubFetch(() => okPayload(payload));
  try {
    const out = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.equal(out.length, 0, 'hash inválido nunca vira release');
  } finally {
    stub.restore();
  }
});

test('dedupe por hash: o mesmo infoHash só sai uma vez', async () => {
  const payload = [
    stream('Guardians of the Galaxy Vol. 3 (2023) 1080p', { infoHash: HASH_LOWER }),
    stream('Guardians of the Galaxy Vol. 3 (2023) 4K', { infoHash: HASH_LOWER }),
    stream('Outro (2023)', { infoHash: 'b'.repeat(40) }),
  ];
  const stub = stubFetch(() => okPayload(payload));
  try {
    const out = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.equal(out.length, 2, 'primeiro de cada hash vence');
    assert.equal(new Set(out.map((i) => i.infoHash)).size, 2);
  } finally {
    stub.restore();
  }
});

test('collectRaw inclui torrentio no fan-out selecionado pela config selada', async () => {
  const originalEnabled = config.torrentio.enabled;
  const payload = [stream('Guardians of the Galaxy Vol. 3 (2023) 1080p')];
  const stub = stubFetch((url) => {
    assert.match(url, /torrentio.*\/stream\/movie\/tt6791350\.json$/);
    return okPayload(payload);
  });
  const requestOpts = {
    ...runtime.normalize(null),
    providers: ['torrentio'],
    debridService: '',
    debridApiKey: '',
  };
  try {
    config.torrentio.enabled = true;
    const result = await runtime.run({ opts: requestOpts, encoded: 'torrentio-fanout' }, () =>
      collectRaw(
        'Guardians of the Galaxy Vol. 3 2023',
        'movie',
        'tt6791350',
        null,
        { names: ['Guardians of the Galaxy Vol. 3'], year: 2023, isSeries: false, season: null, episode: null },
        null,
        null,
        Date.now() + 3000,
      ));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].indexer, 'torrentio');
    assert.equal(stub.calls.length, 1);
  } finally {
    config.torrentio.enabled = originalEnabled;
    stub.restore();
    torrentio._resetBreaker();
  }
});

test('HTTP não-ok e timeout falham ABERTO ([]), sem derrubar a busca', async () => {
  const stubHttp = stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
  try {
    const out = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.deepEqual(out, [], 'HTTP 503 vira lista vazia, nunca erro');
  } finally {
    stubHttp.restore();
  }

  torrentio._resetBreaker();
  const stubTimeout = stubFetch(() => { throw new Error('aborted: timeout'); });
  try {
    const out = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.deepEqual(out, [], 'timeout vira lista vazia, nunca erro');
  } finally {
    stubTimeout.restore();
    torrentio._resetBreaker();
  }
});

test('circuit breaker abre após o limiar e bloqueia as consultas seguintes', async () => {
  const original = { ...config.torrentio };
  torrentio._resetBreaker();
  const stub = stubFetch(() => { throw new Error('servidor morreu'); });
  try {
    config.torrentio.breakerFailures = 2;
    config.torrentio.breakerCooldown = 60_000; // cooldown longo: aberto de verdade

    await torrentio.search({ type: 'movie', imdbId: 'tt6791350' }); // falha 1
    await torrentio.search({ type: 'movie', imdbId: 'tt6791350' }); // falha 2 → abre
    assert.equal(stub.calls.length, 2, 'duas chamadas reais antes da abertura');

    const out = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.deepEqual(out, []);
    assert.equal(stub.calls.length, 2, 'aberto não faz nova chamada de rede');
  } finally {
    config.torrentio = { ...original };
    stub.restore();
    torrentio._resetBreaker();
  }
});

test('circuit breaker meia-abre após cooldown e reinicia ao acertar', async () => {
  const original = { ...config.torrentio };
  torrentio._resetBreaker();
  let shouldFail = true;
  const stub = stubFetch(() => shouldFail
    ? Promise.reject(new Error('host público fora'))
    : okPayload([stream('Guardians of the Galaxy Vol. 3 (2023)')]));
  try {
    config.torrentio.breakerFailures = 1;
    config.torrentio.breakerCooldown = 5;

    await torrentio.search({ type: 'movie', imdbId: 'tt6791350' }); // falha 1 → abre
    assert.equal(stub.calls.length, 1, 'primeira falha abre o circuito');

    const blocked = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.deepEqual(blocked, []);
    assert.equal(stub.calls.length, 1, 'ainda no cooldown: nada de rede');

    await sleep(60);
    shouldFail = false;
    const out = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.equal(out.length, 1, 'meia-aberta deixa passar uma tentativa');
    assert.equal(stub.calls.length, 2);

    const nex = await torrentio.search({ type: 'movie', imdbId: 'tt6791350' });
    assert.equal(nex.length, 1, 'após o acerto o circuito fecha de novo');
    assert.equal(stub.calls.length, 3);
  } finally {
    config.torrentio = { ...original };
    stub.restore();
    torrentio._resetBreaker();
  }
});

// ---------- Regressão de precisão: o lixo do Torrentio não vira release. ----------
// O Torrentio público cataloga cursos/treinos ("Coach Red Pill Video Pack",
// "Matt Smith Mobility Toolkit") que NÃO têm relação com a obra pedida. Eles
// atravessam mapStream (hash válido, título existe), então quem barra é o filtro
// de relevância dos indexers. Guardiões = tt6791350 (Guardiões da Galáxia Vol. 3,
// 2023). Passam os títulos pelo MESMO filterRelevantRaw da busca real; se o
// filtro NÃO barrar, o teste falha e o defeito é reportado (não se muda src/).
const GUARDIANS_NAMES = ['Guardians of the Galaxy Vol. 3', 'Guardiões da Galáxia Vol. 3'];
const GUARDIANS_MATCH = { names: GUARDIANS_NAMES, year: 2023, isSeries: false, season: null, episode: null };

test('filtro real de tt6791350 barra os cursos-lixo e mantém releases válidas', () => {
  const junk: RawItem[] = [
    { title: 'Coach Red Pill Video Pack', infoHash: 'c'.repeat(40), seeders: 12, size: 1024 ** 3 },
    { title: 'Matt Smith Mobility Toolkit', infoHash: 'd'.repeat(40), seeders: 3, size: 512 * 1024 ** 2 },
  ];
  const good: RawItem = { title: 'Guardiões da Galáxia Vol. 3 (2023) [1080p] [Dual]', infoHash: 'e'.repeat(40) };

  const relevant = filterRelevantRaw([...junk, good], GUARDIANS_MATCH);
  assert.deepEqual(
    relevant.map((r) => r.infoHash),
    [good.infoHash],
    'esperava só a release válida; cursos do Torrentio não podem entrar na lista de Guardiões',
  );
});
