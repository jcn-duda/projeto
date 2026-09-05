import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { pickBrDubbedCandidate, pickBrDubbedCandidates, pickBrDubbedByTargetQualities, pickAnyDubbedCandidates, uncachedBrHashes, dedupeByHash, pickTopSeededCandidates } from '../src/utils/format.js';
import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import { accountScope } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { applyDebrid } from '../src/providers/index.js';
import type { Stream, DebridAdapter } from '../types/domain.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const stream = (infoHash: any, extra = {}) => ({ infoHash, name: 'Release', ...extra });

test('applyDebrid limita a primeira checagem e mantém resposta não vazia quando cache é desconhecido', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const calls: Array<{ infoHashes: unknown; options?: any }> = [];
  let cacheResult;
  debrid.checkCached = async (infoHashes, options) => {
    calls.push({ infoHashes, options });
    return { cached: new Set(), known: false };
  };
  config.debrid.publicUrl = 'http://addon.test';
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
    debridCachedOnly: true,
    autoFetchBr: false,
  };
  const input = stream(A, {
    name: '1080p\nTorrentio',
    title: 'Filme 1080p',
    sources: ['tracker:test'],
  });

  try {
    const started = Date.now();
    const first = await runtime.run(
      { opts: userOpts, encoded: 'segcfg' },
      () => applyDebrid([input], {
        season: 1,
        episode: 2,
        searchKey: 'busca-fria',
        deadlineAt: started + 2000,
        onCacheResult: (result: any) => { cacheResult = result; },
      } as any),
    ) as Stream[];

    assert.equal(first.length, 1, 'known:false não pode esvaziar a primeira resposta');
    assert.match(first[0].name as string, /^\[PM download\]/);
    assert.match(first[0].url as string, new RegExp('/segcfg/resolve/' + A + '\\?s=1&e=2&sig=[a-f0-9]{64}$'));
    assert.equal(first[0].infoHash, undefined);
    assert.equal(first[0].sources, undefined);
    assert.deepEqual(calls[0].infoHashes, [A]);
    assert.ok(calls[0].options.timeoutMs > 1000 && calls[0].options.timeoutMs <= 1500,
      'teto precisa usar o restante do deadline menos a margem');
    assert.deepEqual(cacheResult, { known: false, needsFullRefresh: true });

    calls.length = 0;
    const late = await runtime.run(
      { opts: userOpts, encoded: 'segcfg' },
      () => applyDebrid([input], { searchKey: 'passe-tardio' } as any),
    ) as Stream[];
    assert.equal(late.length, 1);
    assert.deepEqual(calls[0].options, {}, 'passe tardio usa o timeout completo do adaptador');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
  }
});

test('contrato max4 seleciona candidatos distintos e limita slots por busca', () => {
  assert.equal(typeof pickBrDubbedCandidates, 'function');
  assert.equal(typeof autofetch.acquireSearchSlot, 'function');
  assert.equal(config.debrid.autoFetchMax, 3);

  const one = stream(A, { _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 });
  const duplicate = { ...one, infoHash: A.toUpperCase() };
  const two = stream(B, { _br: true, _dubbed: true, _quality: '720p', _seeders: 2 });
  const three = stream(C, { _br: true, _dubbed: true, _quality: '480p', _seeders: 3 });
  assert.deepEqual(
    pickBrDubbedCandidates([three, duplicate, two, one], new Set([B]), 4)
      .map((s) => (s.infoHash as string).toLowerCase()),
    [A, C],
  );

  const key = 'streams:movie:tt-max4';
  autofetch.releaseSearch(key);
  for (let i = 0; i < 4; i += 1) assert.equal(autofetch.acquireSearchSlot(key, 4), true);
  assert.equal(autofetch.acquireSearchSlot(key, 4), false);
  autofetch.releaseSearch(key);
});

test('pickBrDubbedByTargetQualities: 1 por faixa 1080/720/4K; unknown fora; 720 cacheado libera upgrade', () => {
  const D = 'd'.repeat(40);
  const E = 'e'.repeat(40);
  const a1080 = stream(A, { _br: true, _dubbed: true, _quality: '1080p', _seeders: 5 });
  const a1080b = stream(B, { _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 });
  const c720 = stream(C, { _br: true, _dubbed: true, _quality: '720p', _seeders: 50 });
  const d4k = stream(D, { _br: true, _dubbed: true, _quality: '2160p', _seeders: 9 });
  const eUnk = stream(E, { _br: true, _dubbed: true, _quality: 'sem resolução', _seeders: 99 });

  // limit=3 (≤ nº de faixas): só primários — 2º 1080 e unknown fora.
  assert.deepEqual(
    pickBrDubbedByTargetQualities([eUnk, d4k, c720, a1080b, a1080], new Set(), 3)
      .map((s) => String(s.infoHash).toLowerCase()),
    [A, C, D],
    '1×1080 + 1×720 + 1×4K; unknown e 2º 1080 fora',
  );

  assert.deepEqual(
    pickBrDubbedByTargetQualities([a1080, c720, d4k], new Set([C]), 6)
      .map((s) => String(s.infoHash).toLowerCase()),
    [A, D],
    '720 cacheado → só missing 1080 e 4K',
  );

  // Sem alvo no pool: fallback clássico (unknown/SD).
  const onlyUnk = [
    stream(A, { _br: true, _dubbed: true, _quality: 'sem resolução', _seeders: 2 }),
    stream(B, { _br: true, _dubbed: true, _quality: '480p', _seeders: 1 }),
  ];
  assert.deepEqual(
    pickBrDubbedByTargetQualities(onlyUnk, new Set(), 2).map((s) => String(s.infoHash).toLowerCase()),
    [A, B],
  );
});

test('pickBrDubbedByTargetQualities: limit>3 enche surplus (primários antes, até K/faixa)', () => {
  const D = 'd'.repeat(40);
  const E = 'e'.repeat(40);
  const F = 'f'.repeat(40);
  const a1080 = stream(A, { _br: true, _dubbed: true, _quality: '1080p', _seeders: 5 });
  const a1080b = stream(B, { _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 });
  const c720 = stream(C, { _br: true, _dubbed: true, _quality: '720p', _seeders: 50 });
  const c720b = stream(D, { _br: true, _dubbed: true, _quality: '720p', _seeders: 10 });
  const d4k = stream(E, { _br: true, _dubbed: true, _quality: '2160p', _seeders: 9 });
  const d4kb = stream(F, { _br: true, _dubbed: true, _quality: '2160p', _seeders: 2 });

  // limit=9 → K=3/faixa; com 2 por faixa devolve 6: 3 primários + 3 alternates.
  assert.deepEqual(
    pickBrDubbedByTargetQualities(
      [d4kb, a1080b, c720b, d4k, c720, a1080],
      new Set(),
      9,
    ).map((s) => String(s.infoHash).toLowerCase()),
    [A, C, E, B, D, F],
    'primários 1080/720/4K depois alternates na mesma ordem de qualidade',
  );

  // slice(0,3) dos surplus continua cobrindo as 3 faixas.
  const picked = pickBrDubbedByTargetQualities(
    [a1080b, c720b, d4kb, a1080, c720, d4k],
    new Set(),
    9,
  );
  assert.deepEqual(
    picked.slice(0, 3).map((s) => String(s.infoHash).toLowerCase()),
    [A, C, E],
  );
});

test('pickBrDubbedCandidate ordena por dublado→qualidade→seeders, independente da ordem da lista', () => {
  const a1080p5 = stream(A, { _br: true, _dubbed: true, _quality: '1080p', _seeders: 5 });
  const b1080p9 = stream(B, { _br: true, _dubbed: true, _quality: '1080p', _seeders: 9 });
  // Mesma qualidade: mais seeders vence, mesmo vindo depois na lista.
  assert.equal(pickBrDubbedCandidate([a1080p5, b1080p9]).infoHash, B);
  // Qualidade manda sobre seeders: 1080p+1 vence 720p+100.
  const c720p100 = stream(C, { _br: true, _dubbed: true, _quality: '720p', _seeders: 100 });
  assert.equal(pickBrDubbedCandidate([c720p100, b1080p9]).infoHash, B);
  // O picker prefere 1080p/720p a 2160p: autofetch esquenta o cache pro play
  // rápido, não baixa o arquivo maior.
  const aUhd = stream(A, { _br: true, _dubbed: true, _quality: '2160p', _seeders: 999 });
  assert.equal(pickBrDubbedCandidate([aUhd, b1080p9]).infoHash, B);
  // Marca explícita de dublado vence qualidade: legendado 1080p perde pro 720p dublado.
  const leg1080 = stream(C, { _br: true, _dubbed: false, _quality: '1080p', _seeders: 50 });
  const dub720 = stream(B, { _br: true, _dubbed: true, _quality: '720p', _seeders: 1 });
  assert.equal(pickBrDubbedCandidate([leg1080, dub720]).infoHash, B);
});

test('pickAnyDubbedCandidates só pega global com marca de áudio e sem CAM', () => {
  const dual = stream(A, { _dubbed: true, _quality: '1080p', _seeders: 2 });
  const cam = stream(B, { title: 'Filme CAM Dublado 1080p', _dubbed: true, _quality: '1080p', _seeders: 99 });
  const legendado = stream(C, { _dubbed: false, _quality: '1080p', _seeders: 50 });

  // Sem marca de áudio a global não entra: fora dos sites BR o padrão é
  // legendado, e o fallback sem marca vale dublado só vale para o pool BR.
  assert.deepEqual(pickAnyDubbedCandidates([legendado, cam, dual], new Set(), 4), [dual]);
  assert.deepEqual(pickAnyDubbedCandidates([legendado, cam], new Set(), 4), []);
});

test('pickAnyDubbedCandidates ordena qualidade→seeders, dedupa e pula cacheado/limite', () => {
  const g1080 = stream(A, { _dubbed: true, _quality: '1080p', _seeders: 5 });
  const g1080dup = { ...g1080, infoHash: A.toUpperCase() };
  const g720 = stream(B, { _dubbed: true, _quality: '720p', _seeders: 100 });
  const uhd = stream(C, { _dubbed: true, _quality: '2160p', _seeders: 999 });

  assert.deepEqual(
    pickAnyDubbedCandidates([uhd, g720, g1080dup, g1080], new Set(), 4).map((s) => (s.infoHash as string).toLowerCase()),
    [A, B, C],
    'mesma ordem do pool BR: 1080p/720p antes do 2160p, seeders decide o empate',
  );
  assert.deepEqual(pickAnyDubbedCandidates([g1080, g720], new Set([A]), 4), [g720]);
  assert.deepEqual(pickAnyDubbedCandidates([g1080, g720], new Set(), 1), [g1080]);
  assert.deepEqual(pickAnyDubbedCandidates([g1080, g720], new Set(), 0), []);
});

test('picks de autofetch dão bônus a pack da temporada pedida em busca de série', () => {
  const D = 'd'.repeat(40);
  const E = 'e'.repeat(40);
  const brEp = stream(A, { title: 'Série S01E03 1080p Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 50 });
  const brPack = stream(B, { title: 'Série S01 Dublado 720p', _br: true, _dubbed: true, _quality: '720p', _seeders: 2 });
  const brOther = stream(C, { title: 'Série S02 Dublado 720p', _br: true, _dubbed: true, _quality: '720p', _seeders: 2 });
  const brComplete = stream(D, { title: 'Série Todas as Temporadas Dublado 480p', _br: true, _dubbed: true, _quality: '480p', _seeders: 1 });
  const brSeasonComplete = stream(E, { title: 'Série TEMPORADA COMPLETA Dublado 480p', _br: true, _dubbed: true, _quality: '480p', _seeders: 1 });

  // Sem season (contexto de filme) o bônus não existe: qualidade e seeders
  // decidem como antes — a lista exibida ao usuário não muda em nada.
  assert.equal(pickBrDubbedCandidate([brEp, brPack]).infoHash, A);
  assert.equal(pickAnyDubbedCandidates([brEp, brPack], new Set(), 1)[0].infoHash, A);

  // Pack da temporada pedida vence mesmo com qualidade/seeders menores: um
  // download serve o binge inteiro em vez de um episódio.
  assert.equal(pickBrDubbedCandidates([brEp, brPack], new Set(), 1, { season: 1 })[0].infoHash, B);
  assert.equal(pickAnyDubbedCandidates([brEp, brPack], new Set(), 1, { season: 1 })[0].infoHash, B);

  // Pack de OUTRA temporada não ganha o bônus (a qualidade decide).
  assert.equal(pickBrDubbedCandidates([brEp, brOther], new Set(), 1, { season: 1 })[0].infoHash, A);
  assert.equal(pickAnyDubbedCandidates([brEp, brOther], new Set(), 1, { season: 1 })[0].infoHash, A);
  assert.equal(pickTopSeededCandidates([brEp, brOther], new Set(), 1, { season: 1 })[0].infoHash, A);
  // O mesmo pack recebe o bônus quando a busca pede a própria temporada.
  assert.equal(pickBrDubbedCandidates([brEp, brOther], new Set(), 1, { season: 2 })[0].infoHash, C);
  assert.equal(pickTopSeededCandidates([brEp, brOther], new Set(), 1, { season: 2 })[0].infoHash, C);
  // Todas as Temporadas cobre qualquer temporada pedida.
  assert.equal(pickBrDubbedCandidates([brEp, brComplete], new Set(), 1, { season: 3 })[0].infoHash, D);
  // Sem número, o pack continua elegível: a busca já foi feita para a temporada.
  assert.equal(pickBrDubbedCandidates([brEp, brSeasonComplete], new Set(), 1, { season: 3 })[0].infoHash, E);
  assert.equal(pickTopSeededCandidates([brEp, brSeasonComplete], new Set(), 1, { season: 3 })[0].infoHash, E);
});

test('dedupeByHash não entrega espelho global ao picker BR dublado', () => {
  const global = stream(A, { name: 'Joker 1080p', _br: false, _dubbed: false, _quality: '1080p', _seeders: 500 });
  const br = stream(A, { name: 'Coringa Dublado 1080p', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 });
  const merged = dedupeByHash([global, br]);
  assert.equal(merged.length, 1, 'a mesma release em dois indexers vira um stream só');
  assert.equal(merged[0]._br, false, 'a origem pertence à listagem global vencedora');
  assert.equal(merged[0]._dubbed, false);
  assert.equal(pickBrDubbedCandidate(merged), null, 'espelho não pode consumir quota de autofetch BR');
});

test('uncachedBrHashes pula o cacheado no meio do pool e corta no limite', () => {
  const first = stream(A, { _br: true, _dubbed: true, _quality: '1080p' });
  const second = stream(B, { _br: true, _dubbed: true, _quality: '720p' });
  const third = stream(C, { _br: true, _dubbed: true, _quality: '2160p' });
  // O cacheado no meio não trava a varredura: a seleção segue no próximo.
  assert.deepEqual([...uncachedBrHashes([first, second, third], new Set([B]), 2)], [A, C]);
  assert.deepEqual([...uncachedBrHashes([first, second, third], new Set(), 1)], [A]);
  assert.deepEqual([...uncachedBrHashes([first, second, third], new Set([A, B, C]), 5)], []);
});

test('acquireSearch mantém compatibilidade com o teto antigo de uma vaga', () => {
  const searchKey = 'streams:movie:tt-slots';
  autofetch.releaseSearch(searchKey);
  assert.equal(autofetch.acquireSearch(searchKey), true);
  // No contrato max4 a quinta aquisição seria barrada; no código atual a
  // segunda já é — o teto compartilhado é 1 por searchKey.
  assert.equal(autofetch.acquireSearch(searchKey), false);
  assert.equal(autofetch.acquireSearch(searchKey), false);
  // Chave vazia nunca adquire: sem searchKey não há busca a proteger.
  assert.equal(autofetch.acquireSearch(''), false);
  autofetch.releaseSearch(searchKey);
  assert.equal(autofetch.acquireSearch(searchKey), true, 'release devolve o slot');
  autofetch.releaseSearch(searchKey);
});
