/**
 * Efeitos do play quando o adaptador está em rustServices.
 * O catch antigo do /resolve não roda: 451 tem de chegar no ledger do
 * Real-Debrid aqui, e nunca vira markBad (esconderia fonte tocável noutro debrid).
 * Cache em memória (setup-env); sem rede e sem conta real.
 */
import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as releaseIndex from '../src/utils/release-index.js';
import * as rdLedger from '../src/debrid/rd-ledger.js';
import { accountScope } from '../src/utils/request-key.js';
import { flushNativeStreamStores } from '../src/utils/streams-store-native.js';
import { BlockedError, DubLieError, EpisodePickError } from '../src/debrid/common.js';
import { applyResolveEffects, type ResolveApplyContext } from '../src/debrid/rust-resolve-apply.js';
import { createStreamsBridge } from './helpers/streams-bridge.js';

const API_KEY = 'chave-de-teste-resolve-apply';
const HASH_RD = 'a1'.repeat(20);
const HASH_AD = 'b2'.repeat(20);
const HASH_EP = 'c3'.repeat(20);
const HASH_BARE = 'd4'.repeat(20);
const HASH_CONTROL = 'e5'.repeat(20);
const IMDB_HIT = 'tt424242';
const IMDB_MISS = 'tt424243';
const IMDB_LIE = 'tt424244';

function counter(name: string): number {
  const counters = metrics.snapshot().counters as Record<string, number>;
  return counters[name] || 0;
}

function stubServices() {
  const cleared: string[] = [];
  const counts: string[] = [];
  const services: ResolveApplyContext['services'] = {
    cache: {
      clearNamespace(namespace: string) {
        cleared.push(namespace);
        return 0;
      },
    },
    metrics: {
      count(name: string) {
        counts.push(name);
      },
    },
    log: { info() {}, warn() {} },
  };
  return { services, cleared, counts };
}

function ctx(
  adapterId: string,
  infoHash: string,
  services: ResolveApplyContext['services'],
  imdbId = '',
  season: number | null = null,
  episode: number | null = null,
): ResolveApplyContext {
  return { adapterId, apiKey: API_KEY, infoHash, imdbId, season, episode, services };
}

function streamKey(imdbId: string, season: number, episode: number): string {
  return `${prefix('streams')}series:${imdbId}:S${season}:E${episode}:fixture`;
}

test('451 no Real-Debrid anota o ledger uma vez e não marca magnet bad', () => {
  assert.equal(config.debrid.rdLedger.enabled, true);
  assert.ok(config.debrid.rdLedger.blockedTtl > 0);
  assert.equal(config.magnetDb.enabled, true);
  assert.ok(config.magnetDb.badTtl > 0);

  cache.clearNamespace('rdc');
  rdLedger.reset();
  metrics.reset();
  // O banco está armado: se o 451 virasse bad, isBad ficaria true.
  magnetdb.markBad('realdebrid', API_KEY, HASH_CONTROL);
  assert.equal(magnetdb.isBad('realdebrid', API_KEY, HASH_CONTROL), true);
  magnetdb.forgetBad('realdebrid', API_KEY, HASH_CONTROL);
  metrics.reset();

  const stub = stubServices();
  applyResolveEffects(
    new BlockedError('o debrid bloqueou este conteúdo por motivo legal'),
    ctx('realdebrid', HASH_RD, stub.services),
  );

  assert.equal(rdLedger.peek(HASH_RD), 'blocked');
  assert.equal(counter('debrid.rd.ledger.blocked'), 1);
  assert.equal(counter('debrid.rd.ledger.noted'), 1);
  assert.equal(magnetdb.isBad('realdebrid', API_KEY, HASH_RD), false);
  assert.equal(counter('magnetdb.bad.set'), 0);
});

test('451 noutro debrid não chama noteBlocked', () => {
  cache.clearNamespace('rdc');
  rdLedger.reset();
  metrics.reset();

  const stub = stubServices();
  applyResolveEffects(
    new BlockedError('o debrid bloqueou este conteúdo por motivo legal'),
    ctx('alldebrid', HASH_AD, stub.services),
  );

  assert.equal(rdLedger.peek(HASH_AD), 'unknown');
  assert.equal(counter('debrid.rd.ledger.blocked'), 0);
  assert.equal(counter('debrid.rd.ledger.noted'), 0);
  assert.equal(magnetdb.isBad('alldebrid', API_KEY, HASH_AD), false);
  assert.equal(counter('magnetdb.bad.set'), 0);
});

test('EpisodePickError com prova marca missing e pede a invalidação da obra ao store nativo', async () => {
  assert.equal(config.releaseIndex.enabled, true);
  assert.ok(config.releaseIndex.ttl > 0);
  const key = streamKey(IMDB_HIT, 2, 5);
  // A lista pronta é do `streams.db` (F4.2(c)): o efeito tem que alcançar o
  // store NATIVO, não um L1 que recusa escrita de `streams`.
  const bridge = createStreamsBridge({
    entries: [{ type: 'series', id: `${IMDB_HIT}:2:5`, key, cache: { partial: false } }],
  });
  try {
    metrics.reset();

    const stub = stubServices();
    applyResolveEffects(
      new EpisodePickError({
        wantedSeason: 2,
        wantedEpisode: 5,
        declaredSeasons: [2],
        declaredEpisodes: [4],
        sample: 'ep.mkv',
      }),
      ctx('premiumize', HASH_EP, stub.services, IMDB_HIT, 2, 5),
    );

    assert.equal(releaseIndex.isMissing(IMDB_HIT, { season: 2, episode: 5 }, HASH_EP), true);
    assert.equal(counter('search.idx.miss'), 1);
    assert.equal(counter('search.idx.missSeason'), 0);
    // Métrica de PEDIDO: o Node não tem mais a contagem de entradas removidas.
    assert.ok(stub.counts.includes('resolve.streamsInvalidated.obra.requested'));
    await flushNativeStreamStores();
    assert.equal(bridge.has(key), false, 'a obra saiu do streams.db pela ponte');
    assert.equal(rdLedger.peek(HASH_EP), 'unknown');
    assert.equal(magnetdb.isBad('premiumize', API_KEY, HASH_EP), false);
  } finally {
    bridge.restore();
  }
});

test('EpisodePickError sem prova não invalida cache nem marca índice', async () => {
  const key = streamKey(IMDB_MISS, 1, 1);
  const bridge = createStreamsBridge({
    entries: [{ type: 'series', id: `${IMDB_MISS}:1:1`, key, cache: { partial: false } }],
  });
  try {
    metrics.reset();

    const stub = stubServices();
    applyResolveEffects(
      new EpisodePickError(),
      ctx('premiumize', HASH_BARE, stub.services, IMDB_MISS, 1, 1),
    );

    assert.equal(releaseIndex.isMissing(IMDB_MISS, { season: 1, episode: 1 }, HASH_BARE), false);
    assert.equal(counter('search.idx.miss'), 0);
    assert.equal(counter('search.idx.missSeason'), 0);
    await flushNativeStreamStores();
    assert.equal(bridge.has(key), true, 'sem prova, a obra continua no store');
    assert.equal(stub.cleared.length, 0);
    assert.equal(stub.counts.length, 0);
    assert.equal(magnetdb.isBad('premiumize', API_KEY, HASH_BARE), false);
  } finally {
    bridge.restore();
  }
});

// Era coberto pela rota Node do `/resolve` (apagada na fase 2): o play que
// provou release EN grava `lie`, destrava o `adprot` da conta e invalida a
// obra da dica. Os dois casos da rota viraram este — mesmo efeito, sem HTTP.
test('DubLieError marca lie, destrava o adprot da conta e invalida a obra', async () => {
  assert.equal(config.magnetDb.enabled, true);
  const hash = 'a7'.repeat(20);
  const key = streamKey(IMDB_LIE, 1, 1);
  const markerKey = `${prefix('adprot')}alldebrid:${accountScope(API_KEY)}:${hash}`;
  cache.set(markerKey, { acceptedAt: Date.now(), readyAt: null }, 3600);
  assert.ok(cache.peek(markerKey), 'precondição: retenção durável de pé');
  const bridge = createStreamsBridge({
    entries: [{ type: 'series', id: `${IMDB_LIE}:1:1`, key, cache: { partial: false } }],
  });
  try {
    const stub = stubServices();
    applyResolveEffects(
      new DubLieError({ videoCount: 1, matchedGroup: 'WEB', sample: 'Movie.2024.1080p.WEB.mkv' }),
      ctx('alldebrid', hash, stub.services, IMDB_LIE, 1, 1),
    );

    assert.equal(magnetdb.isLie('alldebrid', API_KEY, hash), true, 'a mentira vai para o banco de magnets');
    assert.equal(cache.get(markerKey), null, 'a prova de release EN destrava a proteção durável');
    assert.ok(stub.counts.includes('resolve.streamsInvalidated.obra.requested'));
    await flushNativeStreamStores();
    assert.equal(bridge.has(key), false, 'streams da obra da dica foram invalidados no store nativo');
  } finally {
    bridge.restore();
  }
});
