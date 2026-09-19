import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Persistência desligada ANTES dos requires: o app real abre o módulo de
// cache e o data/cache.db do repo não pode ser tocado pelos testes.
process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import { WorkPickError, EpisodePickError, NoVideoError } from '../src/debrid/common.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as releaseIndex from '../src/utils/release-index.js';
import type { DebridAdapter } from '../types/domain.js';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';

const HASH = 'f'.repeat(40);

// Adaptador fake registrado no registry real
const FAKE_ADAPTER = {
  id: 'fakebrid',
  label: 'FakeBridge',
  short: 'FK',
  cacheCheck: true,
  keyUrl: null as unknown as string,
  checkCached: async () => new Set<string>(),
  resolveLink: async () => 'https://fake.test/dl/video.mp4',
} as DebridAdapter;

function hmacSig(secret: any, payload: any) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

let server: any;
const saved: Record<string, string> = {};

before(async () => {
  // O debrid e o token de diagnóstico efetivos vêm do .env do operador; os
  // testes decidem tudo pelo segmento de config, então o ambiente precisa
  // nascer neutro (e voltar ao que era no after).
  saved.debridService = config.debrid.service;
  saved.debridApiKey = config.debrid.apiKey;
  saved.resolveSecret = config.debrid.resolveSecret;
  saved.testToken = config.jackett.testToken;
  saved.jackettApiKey = config.jackett.apiKey;
  saved.publicUrl = config.debrid.publicUrl;
  config.debrid.service = '';
  config.debrid.apiKey = '';
  config.debrid.resolveSecret = '';
  config.jackett.testToken = '';
  // O mock intercepta o fetch, mas sem chave o jackett.search aborta antes
  // de perguntar ("JACKETT_API_KEY não configurada").
  config.jackett.apiKey = 'test-jackett-key';
  // O manifest só aponta para /logo.png quando há PUBLIC_URL; sem ela cai no
  // logo genérico do Stremio. Fixar aqui tira o teste da dependência do .env.
  config.debrid.publicUrl = 'https://addon.teste';

  debrid.BY_ID.set(FAKE_ADAPTER.id, FAKE_ADAPTER);
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  debrid.BY_ID.delete(FAKE_ADAPTER.id);
  config.debrid.service = saved.debridService;
  config.debrid.apiKey = saved.debridApiKey;
  config.debrid.resolveSecret = saved.resolveSecret;
  config.jackett.testToken = saved.testToken;
  config.jackett.apiKey = saved.jackettApiKey;
  config.debrid.publicUrl = saved.publicUrl;
});
test('/resolve rejeita hash malformado com 400', async () => {
  const res = await server.request('GET', '/resolve/nao-eh-hash');
  assert.equal(res.status, 400);
  assert.equal(res.text, 'infoHash inválido');
});

test('/resolve com debrid ativo exige assinatura: sem sig ou sig errada dá 403', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });

  const semSig = await server.request('GET', `/${cfg}/resolve/${HASH}`);
  assert.equal(semSig.status, 403);
  assert.equal(semSig.text, 'assinatura inválida');

  const sigErrada = await server.request('GET', `/${cfg}/resolve/${HASH}?sig=${'0'.repeat(64)}`);
  assert.equal(sigErrada.status, 403);
});

test('/resolve com sig válido redireciona 302 para o link do debrid', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  // Sem RESOLVE_SECRET o segredo efetivo é a própria chave do segmento.
  const sig = hmacSig('fake-key', HASH);

  const res = await server.request('GET', `/${cfg}/resolve/${HASH}?sig=${sig}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://fake.test/dl/video.mp4');
});

test('/resolve cobre temporada/episódio na assinatura', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const ep = '?s=1&e=2';

  // Sig do hash puro não vale para o pedido com episódio — e vice-versa.
  const sigSemEp = hmacSig('fake-key', HASH);
  const errada = await server.request('GET', `/${cfg}/resolve/${HASH}${ep}&sig=${sigSemEp}`);
  assert.equal(errada.status, 403);

  const sigComEp = hmacSig('fake-key', `${HASH}${ep}`);
  const certa = await server.request('GET', `/${cfg}/resolve/${HASH}${ep}&sig=${sigComEp}`);
  assert.equal(certa.status, 302);
});

test('/resolve devolve 502 quando o debrid lança e 404 quando não há vídeo', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const sig = hmacSig('fake-key', HASH);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => {
      throw new Error('serviço fora do ar');
    };
    const falha = await server.request('GET', `/${cfg}/resolve/${HASH}?sig=${sig}`);
    assert.equal(falha.status, 502);
    assert.equal(falha.text, 'falha ao resolver no debrid');

    FAKE_ADAPTER.resolveLink = async () => null;
    const semVideo = await server.request('GET', `/${cfg}/resolve/${HASH}?sig=${sig}`);
    // null não distingue "sem vídeo" de "ainda baixando": o texto é honesto
    // sobre a dúvida, e nada entra no banco de magnets (teste abaixo).
    assert.equal(semVideo.status, 404);
    assert.equal(semVideo.text, 'o torrent ainda está baixando no debrid');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve devolve 404 com mensagem de pack quando pickFile lança WorkPickError', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hint = JSON.stringify({ n: ['O Poderoso Chefão', 'The Godfather'], y: 1972, p: 1 });
  // A assinatura cobre a dica CRUA (não URL-encoded).
  const sig = hmacSig('fake-key', `${HASH}&w=${hint}`);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new WorkPickError(); };
    const res = await server.request('GET', `/${cfg}/resolve/${HASH}?w=${encodeURIComponent(hint)}&sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'não foi possível identificar este filme dentro do pack');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve devolve 404 quando pickFile não identifica episódio no pack', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const sig = hmacSig('fake-key', `${HASH}?s=1&e=5`);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new EpisodePickError(); };
    const res = await server.request('GET', `/${cfg}/resolve/${HASH}?s=1&e=5&sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'este episódio não foi encontrado no pack');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve: EpisodePickError com evidência grava miss no índice da obra', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashMiss = 'e'.repeat(40);
  // A dica carrega o `i` (imdbId) — é ele que permite gravar a evidência no
  // índice da obra, escopada ao episódio pedido.
  const hint = JSON.stringify({ n: ['True Detective'], y: 2014, i: 'tt7700009' });
  const sig = hmacSig('fake-key', `${hashMiss}?s=1&e=5&w=${hint}`);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => {
      throw new EpisodePickError({
        wantedSeason: 1,
        wantedEpisode: 5,
        declaredSeasons: [1],
        declaredEpisodes: [7],
        sample: 'True.Detective.S01E07.1080p.WEB.mkv',
      });
    };
    const res = await server.request('GET', `/${cfg}/resolve/${hashMiss}?s=1&e=5&w=${encodeURIComponent(hint)}&sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'este episódio não foi encontrado no pack');
    assert.equal(
      releaseIndex.isMissing('tt7700009', { season: 1, episode: 5 }, hashMiss),
      true,
      'a prova "este hash não serve este episódio" fica no índice',
    );
    // Prova fina: o mesmo hash continua valendo para os outros episódios.
    assert.equal(releaseIndex.isMissing('tt7700009', { season: 1, episode: 7 }, hashMiss), false);
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

// Banco de magnets no /resolve: só a falha DETERMINÍSTICA (NoVideoError) grava
// bad; null (transitório), pick falho e erro de rede não condenam o hash.
// Cada caso usa hash próprio para não contaminar o estado entre testes.
test('/resolve: null NÃO grava bad no banco de magnets', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashNull = 'a'.repeat(40);
  const sig = hmacSig('fake-key', hashNull);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => null;
    const res = await server.request('GET', `/${cfg}/resolve/${hashNull}?sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(
      magnetdb.isBad('fakebrid', 'fake-key', hashNull),
      false,
      'null é transitório na maioria dos adaptadores — gravar era blacklists de torrent bom',
    );
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve: NoVideoError grava bad e devolve 404 honesto', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashBad = 'b'.repeat(40);
  const sig = hmacSig('fake-key', hashBad);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new NoVideoError(); };
    const res = await server.request('GET', `/${cfg}/resolve/${hashBad}?sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(res.text, 'nenhum arquivo de vídeo no torrent');
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashBad), true, 'listagem com arquivos e nenhum vídeo é prova');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve: WorkPickError e EpisodePickError não gravam nada', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashWork = 'c'.repeat(40);
  const hashEp = 'd'.repeat(40);
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    FAKE_ADAPTER.resolveLink = async () => { throw new WorkPickError(); };
    await server.request('GET', `/${cfg}/resolve/${hashWork}?sig=${hmacSig('fake-key', hashWork)}`);
    FAKE_ADAPTER.resolveLink = async () => { throw new EpisodePickError(); };
    await server.request('GET', `/${cfg}/resolve/${hashEp}?s=1&e=2&sig=${hmacSig('fake-key', `${hashEp}?s=1&e=2`)}`);
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashWork), false, 'o pack pode servir outra obra');
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashEp), false, 'o pack pode servir outro episódio');
  } finally {
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});

test('/resolve: link resolveu grava alive no banco de magnets', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashOk = '1'.repeat(40);
  const sig = hmacSig('fake-key', hashOk);

  const res = await server.request('GET', `/${cfg}/resolve/${hashOk}?sig=${sig}`);
  assert.equal(res.status, 302);
  assert.equal(magnetdb.isAlive('fakebrid', 'fake-key', hashOk), true, 'play resolvido é evidência de vivo + instantâneo');
});

test('/resolve: MAGNET_DB=false desliga a gravação', async () => {
  const cfg = encodeConfig({ ds: 'fakebrid', dk: 'fake-key' });
  const hashOff = '2'.repeat(40);
  const sig = hmacSig('fake-key', hashOff);
  const originalEnabled = config.magnetDb.enabled;
  const originalResolve = FAKE_ADAPTER.resolveLink;

  try {
    config.magnetDb.enabled = false;
    FAKE_ADAPTER.resolveLink = async () => { throw new NoVideoError(); };
    const res = await server.request('GET', `/${cfg}/resolve/${hashOff}?sig=${sig}`);
    assert.equal(res.status, 404);
    assert.equal(magnetdb.isBad('fakebrid', 'fake-key', hashOff), false, 'kill-switch desliga o banco inteiro');
  } finally {
    config.magnetDb.enabled = originalEnabled;
    FAKE_ADAPTER.resolveLink = originalResolve;
  }
});
