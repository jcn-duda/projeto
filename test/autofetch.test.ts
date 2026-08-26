import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

// Escolha do que baixar + proteção do hash: as duas peças que decidem se algo é
// escrito na conta do usuário. Testadas sem rede, com objetos de stream mínimos.
import { pickBrDubbedCandidate, pickBrDubbedCandidates, pickAnyDubbedCandidates, hasCachedBrDubbed, canAutoFetchBr, uncachedBrHashes, filterKnownCache, pickTopSeededCandidates } from '../src/utils/format.js';
import { sortAndLimit, toStremioStream, limitReservingBr, dedupeByHash } from '../src/utils/format.js';
import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope, streamsCacheKey } from '../src/utils/request-key.js';
import * as cache from '../src/utils/cache.js';
import { applyDebrid, findStreams } from '../src/providers/index.js';
import type { Stream, DebridAdapter } from '../types/domain.js';

// O AutofetchOptions do format.ts não declara debridCachedOnly (campo do
// runtime que o picker não lê); o literal completo dos testes usa este tipo
// local para o excesso de propriedade não virar erro.
type TestAutofetchOptions = { autoFetchBr?: boolean; debridCachedOnly?: boolean };

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('pickTopSeededCandidates respeita o piso e o teto de dois', () => {
  const low = stream(A, { title: 'Lost Girl S03E01 HDTV', _seeders: 1 });
  const first = stream(B, { title: 'Lost Girl S03 720p x265', _seeders: 6 });
  const second = stream(C, { title: 'Lost Girl S03 1080p', _seeders: 4 });
  assert.deepEqual(
    pickTopSeededCandidates([low, first, second], new Set(), 2, { season: 3, minSeeders: 3 }).map((s) => s.infoHash),
    [B, C],
  );
});

test('pool de swarm prefere release com sinal PT à contagem bruta de seeders', () => {
  // Release estrangeira sem marca com MUITOS pares vs release PT com menos:
  // a PT vence — é preferência, não filtro. As duas são releases de episódio
  // (nenhuma é pack), então é o critério PT que decide, entre pack e seeders.
  const gringa = stream(A, { title: 'Some Show S01E05 1080p WEB-DL x264 GRiP', _seeders: 80 });
  const ptDub = stream(B, { title: 'Alguma Série S01E05 Dublada 1080p', _seeders: 6 });
  assert.deepEqual(
    pickTopSeededCandidates([gringa, ptDub], new Set(), 2, { season: 1, minSeeders: 3 }).map((s) => s.infoHash),
    [B, A],
  );
  // Sinal PT por acento/vocabulário (sem marca de áudio) também conta.
  const ptAcento = stream(C, { title: 'Alguma Série S01E05 Não Há Como Fugir Ação', _seeders: 5 });
  assert.equal(
    pickTopSeededCandidates([gringa, ptAcento], new Set(), 1, { season: 1, minSeeders: 3 })[0].infoHash,
    C,
  );
  // Flag desligada restaura a ordenação antiga (seeders brutos).
  assert.deepEqual(
    pickTopSeededCandidates([gringa, ptDub], new Set(), 2, { season: 1, minSeeders: 3, ptFirst: false }).map((s) => s.infoHash),
    [A, B],
  );
});

test('pool de swarm sem nenhum sinal PT preserva o desempate por seeders', () => {
  // Contrato do teste do piso/teto: sem candidato PT, seeders decide.
  const few = stream(A, { title: 'Lost Girl S03E01 HDTV', _seeders: 4 });
  const many = stream(B, { title: 'Lost Girl S03 720p x265', _seeders: 9 });
  assert.deepEqual(
    pickTopSeededCandidates([few, many], new Set(), 2, { season: 3, minSeeders: 3 }).map((s) => s.infoHash),
    [B, A],
  );
});

const stream = (infoHash: any, extra = {}) => ({ infoHash, name: 'Release', ...extra });

test('pickBrDubbedCandidate pega o melhor BR e ignora quem não é BR', () => {
  const global = stream(A, { name: 'Joker 1080p', _dubbed: true });
  const br = stream(B, { name: 'Coringa Dublado', _br: true, _dubbed: true });
  // A lista chega ordenada, então o 1º BR é o melhor candidato.
  assert.equal(pickBrDubbedCandidate([global, br]), br);
  assert.equal(pickBrDubbedCandidate([global]), null);
  assert.equal(pickBrDubbedCandidate([]), null);
});

test('pickBrDubbedCandidate nunca escolhe um LEGENDADO explícito', () => {
  // Nenhum BR tem marca de áudio: cai no padrão "BR é dublado", menos o legendado.
  const leg = stream(A, {
    name: '1080p LEG BR',
    title: 'Coringa (2019) [LEGENDADO opção 1]\n👤 1',
    _br: true,
  });
  const sem = stream(B, {
    name: 'BR',
    title: 'Coringa (2019) [opção 2]\n👤 1',
    _br: true,
  });
  assert.equal(pickBrDubbedCandidate([leg, sem]), sem);
  // Só legendado disponível: não baixa nada.
  assert.equal(pickBrDubbedCandidate([leg]), null);
});

test('pickBrDubbedCandidate exige infoHash', () => {
  // Stream já resolvido pelo debrid não tem hash — não há o que enfileirar.
  assert.equal(pickBrDubbedCandidate([{ name: 'Coringa', _br: true, _dubbed: true } as any]), null);
});

test('hasCachedBrDubbed enxerga o dublado que já toca na hora', () => {
  const br1 = stream(A, { name: 'Coringa Dublado', _br: true, _dubbed: true });
  const br2 = stream(B, { name: 'Coringa Dual', _br: true, _dubbed: true });
  assert.equal(hasCachedBrDubbed([br1, br2], new Set([B])), true);
  assert.equal(hasCachedBrDubbed([br1, br2], new Set([C])), false);
  assert.equal(hasCachedBrDubbed([br1, br2], new Set()), false);
  // Global em cache não conta como dublado BR disponível.
  const global = stream(C, { name: 'Joker 1080p' });
  assert.equal(hasCachedBrDubbed([global, br1], new Set([C])), false);
});

test('trava autofetch é concorrente e marcador novo não colide com legado', () => {
  const key = autofetch.markerKey('alldebrid', 'conta', A);
  assert.equal(key.startsWith('autofetch:v3:m:'), true);
  assert.equal(autofetch.acquire(key), true);
  assert.equal(autofetch.acquire(key), false);
  autofetch.release(key);
  assert.equal(autofetch.acquire(key), true);
  autofetch.release(key);
});

test('passe parcial e tardio só podem enfileirar um torrent por busca', () => {
  const searchKey = 'streams:movie:tt123';
  assert.equal(autofetch.acquireSearch(searchKey), true);
  assert.equal(autofetch.acquireSearch(searchKey), false);
  autofetch.releaseSearch(searchKey);
  assert.equal(autofetch.acquireSearch(searchKey), true);
  autofetch.releaseSearch(searchKey);
});

test('marker confirmado não depende da trava em memória', () => {
  assert.equal(autofetch.LOCK_TTL_MS, 60_000);
  const key = autofetch.markerKey('premiumize', 'conta', B);
  assert.equal(autofetch.acquire(key), true);
  autofetch.release(key);
  assert.equal(autofetch.acquire(key), true);
  autofetch.release(key);
});

test('canAutoFetchBr liga com cachedOnly true OU false; trava só com toggle ou cacheCheck', () => {
  const adapter = { cacheCheck: true } as DebridAdapter;
  assert.equal(canAutoFetchBr({ autoFetchBr: true, debridCachedOnly: true } as TestAutofetchOptions, adapter), true);
  assert.equal(canAutoFetchBr({ autoFetchBr: true, debridCachedOnly: false } as TestAutofetchOptions, adapter), true);
  assert.equal(canAutoFetchBr({ autoFetchBr: false, debridCachedOnly: true } as TestAutofetchOptions, adapter), false);
  assert.equal(canAutoFetchBr({ autoFetchBr: false, debridCachedOnly: false } as TestAutofetchOptions, adapter), false);
  assert.equal(canAutoFetchBr({ autoFetchBr: true, debridCachedOnly: true } as TestAutofetchOptions, { cacheCheck: false } as DebridAdapter), false);
  assert.equal(canAutoFetchBr({ autoFetchBr: true, debridCachedOnly: false } as TestAutofetchOptions, { cacheCheck: false } as DebridAdapter), false);
});

test('fontes BR fora do cache ocupam só as vagas reservadas', () => {
  const global = stream(A, { name: 'Prometheus 1080p', _br: false });
  const br1 = stream(B, { name: 'Prometheus Dublado', _br: true });
  const br2 = stream(C, { name: 'Prometheus Dual', _br: true });

  assert.deepEqual([...uncachedBrHashes([global, br1, br2], new Set(), 1)], [B]);
  assert.deepEqual([...uncachedBrHashes([global, br1, br2], new Set([B]), 2)], [C]);
  assert.deepEqual([...uncachedBrHashes([global, br1], new Set(), 0)], []);
});

test('vaga P2P prefere o dublado e ignora LEGENDADO no topo', () => {
  const legendado = stream(A, { name: 'Prometheus LEGENDADO', _br: true });
  const dublado = stream(B, { name: 'Prometheus Dublado', _br: true, _dubbed: true });

  assert.deepEqual([...uncachedBrHashes([legendado, dublado], new Set(), 1)], [B]);
  assert.deepEqual(
    filterKnownCache([legendado, dublado], new Set(), {
      cachedOnly: true,
      showUncachedBr: true,
      brReservedSlots: 1,
    }).streams.map((item) => item.infoHash),
    [B],
  );
});

test('cachedOnly mantém cacheados e apenas a cota BR fora do cache', () => {
  const globalCached = stream(A, { _br: false });
  const globalUncached = stream(B, { _br: false });
  const brUncached = stream(C, { _br: true });
  const out = filterKnownCache(
    [globalCached, globalUncached, brUncached],
    new Set([A]),
    { cachedOnly: true, showUncachedBr: true, brReservedSlots: 1 },
  );

  assert.deepEqual(out.streams.map((item) => item.infoHash), [A, C]);
  assert.deepEqual([...out.visibleBr], [C]);
  assert.deepEqual(
    filterKnownCache([globalCached, brUncached], new Set([A]), {
      cachedOnly: true,
      showUncachedBr: false,
      brReservedSlots: 1,
    }).streams.map((item) => item.infoHash),
    [A],
  );
});

test('BR já cacheado desconta das vagas P2P', () => {
  const brCached = stream(A, { _br: true });
  const brUncached = stream(B, { _br: true });
  const out = filterKnownCache(
    [brCached, brUncached],
    new Set([A]),
    { cachedOnly: true, showUncachedBr: true, brReservedSlots: 1 },
  );

  assert.deepEqual(out.streams.map((item) => item.infoHash), [A]);
  assert.equal(out.visibleBr.size, 0);
});

test('filterKnownCache ternário: known=true + cachedOnly remove não-cacheados (AllDebrid/Premiumize)', () => {
  const cachedStream = stream(A, { _br: false });
  const unknownStream = stream(B, { _br: false });
  const missStream = stream(C, { _br: false });
  const out = filterKnownCache(
    [cachedStream, unknownStream, missStream],
    new Set([A]),
    { cachedOnly: true, known: true },
  );
  assert.deepEqual(out.streams.map((item) => item.infoHash), [A]);
});

test('filterKnownCache ternário: known=false + missHashes remove apenas miss confirmado e desconhecido sobrevive', () => {
  const cachedStream = stream(A, { _br: false });
  const unknownStream = stream(B, { _br: false });
  const missStream = stream(C, { _br: false });
  const out = filterKnownCache(
    [cachedStream, unknownStream, missStream],
    new Set([A]),
    { cachedOnly: true, known: false, missHashes: new Set([C]) },
  );
  // A (cached) e B (desconhecido) sobrevivem; C (miss confirmado) é removido.
  assert.deepEqual(out.streams.map((item) => item.infoHash), [A, B]);
});

test('filterKnownCache ternário: known=false sem missHashes não corta nada (AllDebrid/Premiumize quando known=false)', () => {
  const cachedStream = stream(A, { _br: false });
  const unknownStream = stream(B, { _br: false });
  const missStream = stream(C, { _br: false });
  const out = filterKnownCache(
    [cachedStream, unknownStream, missStream],
    new Set([A]),
    { cachedOnly: true, known: false },
  );
  // Sem missHashes com known=false, nada é cortado
  assert.deepEqual(out.streams.map((item) => item.infoHash), [A, B, C]);
});

test('filterKnownCache ternário: cachedOnly=false não corta nada', () => {
  const cachedStream = stream(A, { _br: false });
  const unknownStream = stream(B, { _br: false });
  const missStream = stream(C, { _br: false });
  const out = filterKnownCache(
    [cachedStream, unknownStream, missStream],
    new Set([A]),
    { cachedOnly: false, known: false, missHashes: new Set([C]) },
  );
  assert.deepEqual(out.streams.map((item) => item.infoHash), [A, B, C]);
});

test('filterKnownCache ternário: visibleBr (vaga BR) sobrevive mesmo se constar em missHashes', () => {
  const brMiss = stream(C, { _br: true, _dubbed: true });
  const out = filterKnownCache(
    [brMiss],
    new Set(),
    { cachedOnly: true, showUncachedBr: true, brReservedSlots: 1, known: false, missHashes: new Set([C]) },
  );
  assert.deepEqual(out.streams.map((item) => item.infoHash), [C]);
  assert.deepEqual([...out.visibleBr], [C]);
});

test('pipeline preserva _dubbed até o debrid e remove antes de responder', () => {
  const items = [
    { title: 'Coringa Dublado 1080p', infoHash: A, seeders: 1, isBr: true },
    { title: 'Coringa 1080p', infoHash: B, seeders: 2, isBr: true },
  ].map(toStremioStream);
  const candidates = sortAndLimit(items, { maxResults: 10 });

  assert.equal(candidates.find((item) => item.infoHash === A)._dubbed, true);
  assert.equal(pickBrDubbedCandidate(candidates).infoHash, A);
  const output = limitReservingBr(candidates, { maxResults: 10 });
  assert.equal('_dubbed' in output[0], false);
});

test('protected: hold protege, release libera e o TTL expira', () => {
  held.release(A);
  assert.equal(held.isHeld(A), false);
  held.hold(A, 60);
  assert.equal(held.isHeld(A), true);
  // Case-insensitive: a AllDebrid devolve o hash em maiúsculas.
  assert.equal(held.isHeld(A.toUpperCase()), true);
  held.release(A);
  assert.equal(held.isHeld(A), false);

  // TTL mínimo é 1s; um valor zerado não pode virar proteção eterna.
  held.hold(B, 0);
  assert.equal(held.isHeld(B), true);
  held.release(B);
  assert.equal(held.isHeld(''), false);
});

test('protected isola o mesmo hash entre contas', () => {
  held.release(C, 'conta-a');
  held.release(C, 'conta-b');
  held.hold(C, 60, 'conta-a');
  assert.equal(held.isHeld(C, 'conta-a'), true);
  assert.equal(held.isHeld(C, 'conta-b'), false);
  held.release(C, 'conta-a');
});

test('pickBrDubbedCandidate descarta releases CAM e prioriza 1080p e seeders', () => {
  const cam = stream(A, { title: 'Coringa 1080p CAM Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 10 });
  const web720 = stream(B, { title: 'Coringa 720p WEB-DL Dublado', _br: true, _dubbed: true, _quality: '720p', _seeders: 2 });
  const web1080 = stream(C, { title: 'Coringa 1080p WEB-DL Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 8 });

  // CAM é descartado, mesmo com 1080p e 10 seeds
  assert.equal(pickBrDubbedCandidate([cam, web720]).infoHash, B);

  // 1080p tem preferência sobre 720p
  assert.equal(pickBrDubbedCandidate([web720, web1080]).infoHash, C);
});

test('limitReservingBr prioriza dublados sobre legendados nas vagas BR', () => {
  const brLeg = { id: 'br-leg', _br: true, _dubbed: false, _quality: '1080p' } as any;
  const brDub = { id: 'br-dub', _br: true, _dubbed: true, _quality: '1080p' } as any;
  const global1 = { id: 'global-1', _br: false, _dubbed: false, _quality: '1080p' } as any;
  const global2 = { id: 'global-2', _br: false, _dubbed: false, _quality: '1080p' } as any;

  // Com brFirst, o dublado vem antes do legendado
  const outFirst = limitReservingBr([brLeg, brDub, global1], { brFirst: true, maxResults: 3 });
  assert.deepEqual(outFirst.map((s: any) => (s as any).id), ['br-dub', 'br-leg', 'global-1']);

  // Com 1 vaga reservada sem brFirst, a vaga reservada de BR é preenchida pelo dublado (substituindo o último global)
  const outReserved = limitReservingBr([global1, global2, brLeg, brDub], { brFirst: false, brReservedSlots: 1, maxResults: 2 });
  assert.deepEqual(outReserved.map((s: any) => (s as any).id), ['global-1', 'br-dub']);
});

// Medido em Fallout S02E04 com a config real de um usuário: quatro BR dubladas
// disponíveis, todas 1080p, cota de qualidade em 2 e brReservedSlots em 4 --
// saíam 2. A página chama isso de "vagas garantidas", então a reserva tem que
// atravessar a cota do balde, como já atravessava o teto por indexador.
test('vaga reservada BR atravessa a cota por qualidade', () => {
  const br = (n: number) => ({ id: 'br-' + n, _br: true, _dubbed: true, _quality: '1080p' }) as any;
  const global = (n: number) => ({ id: 'g-' + n, _br: false, _dubbed: false, _quality: '1080p' }) as any;
  const pool = [br(1), br(2), br(3), br(4), global(1), global(2), global(3)];

  const out = limitReservingBr(pool, {
    brFirst: true,
    brReservedSlots: 4,
    qualityLimits: { '1080p': 2 },
    maxResults: 40,
  });
  const ids = out.map((s: any) => s.id);
  assert.equal(ids.filter((id: string) => id.indexOf('br-') === 0).length, 4, 'as 4 reservadas precisam sair');
  // A reservada não consome a cota: as globais mantêm as 2 vagas do balde.
  assert.equal(ids.filter((id: string) => id.indexOf('g-') === 0).length, 2, 'a cota das globais fica intacta');

  // Reserva menor que a oferta: só as 2 reservadas atravessam. Sem brFirst e
  // com as globais na frente na ordem natural, as outras duas BR disputam a
  // cota como qualquer uma -- e perdem.
  const menor = limitReservingBr([global(1), global(2), global(3), br(1), br(2), br(3), br(4)], {
    brFirst: false,
    brReservedSlots: 2,
    qualityLimits: { '1080p': 2 },
    maxResults: 40,
  });
  const idsMenor = menor.map((s: any) => s.id);
  assert.equal(idsMenor.filter((id: string) => id.indexOf('br-') === 0).length, 2, 'a reserva é o tamanho da isenção');
  assert.equal(idsMenor.filter((id: string) => id.indexOf('g-') === 0).length, 2, 'globais mantêm a cota');

  // Sem reserva, nada muda: o balde inteiro continua sendo a cota.
  const semReserva = limitReservingBr(pool, {
    brFirst: true,
    brReservedSlots: 0,
    qualityLimits: { '1080p': 2 },
    maxResults: 40,
  });
  assert.equal(semReserva.length, 2, 'brReservedSlots=0 mantém o comportamento antigo');
});

test('maxResults continua sendo o teto acima da reserva', () => {
  const br = (n: number) => ({ id: 'br-' + n, _br: true, _dubbed: true, _quality: '1080p' }) as any;
  const out = limitReservingBr([br(1), br(2), br(3), br(4)], {
    brFirst: true,
    brReservedSlots: 4,
    qualityLimits: { '1080p': 2 },
    maxResults: 3,
  });
  assert.equal(out.length, 3, 'a reserva fura a cota, nunca o máximo de streams');
});

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

test('matriz de enqueue: dc=false enfileira exatamente um BR dublado; cached/known:false/cacheCheck:false/toggle:false não', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalCacheCheck = pmAdapter.cacheCheck;
  const account = accountScope('chave-integrada');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => {
    enqueued.push(infoHash);
    return true;
  };
  const hash = (i: any) => String(i).repeat(40);
  const brDub = (h: any) => ({
    infoHash: h,
    name: 'Coringa Dublado 1080p',
    _br: true,
    _dubbed: true,
    _seeders: 1,
    _quality: '1080p',
  });

  // Cada caso usa hash e searchKey próprios: o marker persistente e a trava por
  // busca são dedupe do autofetch e mascarariam a trava sob teste se fossem
  // reutilizados entre os cenários.
  const run = async ({ h, autoFetchBr = true, debridCachedOnly, cached = [] as string[], known = true, cacheCheck = true, searchKey }: any) => {
    pmAdapter.cacheCheck = cacheCheck;
    debrid.checkCached = async () => ({ cached: new Set(cached), known });
    const userOpts = {
      ...runtime.defaults(),
      debridService: 'premiumize',
      debridApiKey: 'chave-integrada',
      autoFetchBr,
      debridCachedOnly,
    };
    await runtime.run({ opts: userOpts, encoded: 'cfg' }, () =>
      applyDebrid([brDub(h)], { searchKey } as any),
    );
    // O enqueue é disparado sem await (efeito colateral, não resposta): espera
    // só a cadeia de microtasks resolver, como nos demais testes do arquivo.
    await sleep(20);
  };

  try {
    config.debrid.publicUrl = 'http://addon.test';

    // Positivo: sem cachedOnly a fonte já sai como P2P, mas o download no
    // debrid continua sendo enfileirado — o invariante 6 só trava em
    // autoFetchBr/cacheCheck/known/cache.
    await run({ h: hash(1), debridCachedOnly: false, searchKey: 'busca-dc-off' });
    assert.deepEqual(enqueued, [hash(1)], 'dc=false + BR dublado uncached enfileira exatamente o candidato');

    // BR dublado já tocável na hora: baixar o próximo encheria a conta à toa.
    await run({ h: hash(2), debridCachedOnly: true, cached: [hash(2)], searchKey: 'busca-cached' });
    assert.equal(enqueued.length, 1, 'BR dublado cacheado não enfileira');

    // Sem resposta confiável de cache não há como saber o que falta.
    await run({ h: hash(3), debridCachedOnly: true, known: false, searchKey: 'busca-known-false' });
    assert.equal(enqueued.length, 1, 'known:false não enfileira');

    // Serviço sem checagem de cache (Real-Debrid/Debrid-Link) fica fora, mesmo
    // com o known mockado em true — isola a trava cacheCheck da trava known.
    await run({ h: hash(4), debridCachedOnly: true, cacheCheck: false, searchKey: 'busca-cachecheck-false' });
    assert.equal(enqueued.length, 1, 'cacheCheck:false não enfileira');

    // Toggle desligado: desligado é desligado.
    await run({ h: hash(5), debridCachedOnly: true, autoFetchBr: false, searchKey: 'busca-toggle-off' });
    assert.equal(enqueued.length, 1, 'autoFetchBr=false não enfileira');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.cacheCheck = originalCacheCheck;
    cache.forget(autofetch.markerKey('premiumize', account, hash(1)));
    held.release(hash(1), account);
  }
});

test('contrato max4 seleciona candidatos distintos e limita slots por busca', () => {
  assert.equal(typeof pickBrDubbedCandidates, 'function');
  assert.equal(typeof autofetch.acquireSearchSlot, 'function');
  assert.equal(config.debrid.autoFetchMax, 4);

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
  // legendado, e o fallback "sem marca vale dublado" só vale para o pool BR.
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
  // "Todas as Temporadas" cobre qualquer temporada pedida.
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
test('matriz integrada: 4 BR uncached com dc=false/known=true enfileiram os quatro melhores', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  // O caso é sobre torrent puro, então a premissa precisa ser fixada: a suíte
  // carrega o .env do operador, e DEBRID_RESOLVE_UNCACHED=true faz o frio sair
  // pelo /resolve com url em vez de infoHash — o teste quebrava por config, não
  // por código.
  const originalResolveUncached = config.debrid.resolveUncached;
  config.debrid.resolveUncached = false;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-quatro');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const brDub = (h: any, q: any, seeds: any) => ({
    infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: q, _seeders: seeds,
  });

  const h1 = '1'.repeat(40); // 1080p, 1 seed
  const h2 = '2'.repeat(40); // 1080p, 5 seeds  → melhor candidato
  const h3 = '3'.repeat(40); // 720p, 100 seeds
  const h4 = '4'.repeat(40); // 2160p, 999 seeds
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };

  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-quatro',
    debridCachedOnly: false,
    autoFetchBr: true,
  };
  const searchKey = 'busca-quatro-br';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const out = await runtime.run({ opts: userOpts, encoded: 'cfg4' }, () =>
      applyDebrid(
        [brDub(h4, '2160p', 999), brDub(h3, '720p', 100), brDub(h2, '1080p', 5), brDub(h1, '1080p', 1)],
        { searchKey } as any,
      ),
    ) as Stream[];
    await sleep(20);

    // dc=false + known=true: os quatro candidatos distintos entram em background
    // na ordem do pool (1080p com mais seeds, depois 1080p, 720p e 2160p).
    assert.deepEqual(enqueued, [h2, h1, h3, h4], 'os quatro melhores candidatos enfileiram');
    assert.equal(out.length, 4, 'dc=false mantém os 4 BR na lista');
    assert.ok(out.every((s) => s.infoHash), 'lista sai como torrent puro, sem selo ⚡');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.resolveUncached = originalResolveUncached;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h2));
    held.release(h2, account);
  }
});

test('matriz integrada: dc=false com BR dublado já em cache não enfileira (hasCachedBrDubbed trava nos dois modos)', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-sete');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h = '7'.repeat(40);
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });

  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-sete',
    debridCachedOnly: false,
    autoFetchBr: true,
  };
  const searchKey = 'busca-dc-false-cached';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set([h]), known: true });
    await runtime.run({ opts: userOpts, encoded: 'cfg7' }, () =>
      applyDebrid([brDub(h)], { searchKey } as any),
    );
    await sleep(20);

    assert.deepEqual(enqueued, [], 'dublado já tocável encerra o autofetch mesmo com dc=false');
    assert.equal(held.isHeld(h, account), false, 'sem download a proteger, o hold é liberado na hora');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('fallback global: sem BR dublado na busca, as melhores dubladas globais são enfileiradas', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-any');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h1 = '1'.repeat(40);
  const h2 = '2'.repeat(40);
  const h3 = '3'.repeat(40);
  const globalDub = (h: any, q: any, seeds: any) => ({
    infoHash: h, name: 'Movie Dual', _br: false, _dubbed: true, _quality: q, _seeders: seeds,
  });
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-any',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-any-global';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    // Busca sem NENHUMA fonte BR e nada em cache: o fallback enfileira as
    // dubladas globais na ordem do pool (1080p com mais seeds, 1080p, 720p).
    await runtime.run({ opts: userOpts, encoded: 'cfg-any' }, () =>
      applyDebrid(
        [globalDub(h3, '720p', 100), globalDub(h2, '1080p', 9), globalDub(h1, '1080p', 1)],
        { searchKey } as any,
      ),
    );
    await sleep(20);
    assert.deepEqual(enqueued, [h2, h1, h3], 'sem BR na busca, as dubladas globais são enfileiradas');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [h1, h2, h3]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

test('fallback global respeita os gates: stream tocável, BR presente e toggle off não baixam global', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalAny = config.debrid.autoFetchAnyDubbed;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-any-gates');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const g = 'g'.repeat(40);
  const other = 'h'.repeat(40);
  const br = 'i'.repeat(40);
  const globalDub = { infoHash: g, name: 'Movie Dual', _br: false, _dubbed: true, _quality: '1080p', _seeders: 3 };
  const globalLeg = { infoHash: other, name: 'Movie 1080p', _br: false, _dubbed: false, _quality: '1080p', _seeders: 3 };
  const brDub = { infoHash: br, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '480p', _seeders: 1 };
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-any-gates',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const run = (streams: any, searchKey: any, cached = [] as string[]) => {
    debrid.checkCached = async () => ({ cached: new Set(cached), known: true });
    return runtime.run({ opts: userOpts, encoded: 'cfg-gates' }, () =>
      applyDebrid(streams, { searchKey } as any),
    );
  };

  try {
    config.debrid.publicUrl = 'http://addon.test';

    // Gate do pool global é "nada toca": um legendado qualquer em cache já
    // entrega play, e baixar dublada global seria gastar a conta à toa.
    await run([globalDub, globalLeg], 'busca-any-tocavel', [other]);
    await sleep(20);
    assert.deepEqual(enqueued, [], 'stream tocável (mesmo legendado) barra o fallback global');

    // Com fonte BR na busca o pool BR vence (o global nem é consultado): o
    // candidato enfileirado é o BR, mesmo sendo 480p contra o 1080p global.
    await run([globalDub, brDub], 'busca-any-com-br');
    await sleep(20);
    assert.deepEqual(enqueued, [br], 'com fonte BR na busca, o candidato é o BR');

    // Toggle desliga o fallback sem tocar no autofetch BR.
    config.debrid.autoFetchAnyDubbed = false;
    await run([globalDub], 'busca-any-off');
    await sleep(20);
    assert.deepEqual(enqueued, [br], 'DEBRID_AUTO_FETCH_ANY=false não enfileira global');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchAnyDubbed = originalAny;
    pmAdapter.enqueue = originalEnqueue;
    for (const key of ['busca-any-tocavel', 'busca-any-com-br', 'busca-any-off']) {
      autofetch.releaseSearch(key);
    }
    for (const h of [g, other, br]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

test('autofetch de série enfileira o pack em vez do episódio avulso', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-pack');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const ep = '1'.repeat(40);
  const pack = '2'.repeat(40);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-pack',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-pack-serie';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    await runtime.run({ opts: userOpts, encoded: 'cfg-pack' }, () =>
      applyDebrid(
        [
          { infoHash: ep, name: 'Show S01E05 Dual 1080p', _br: false, _dubbed: true, _quality: '1080p', _seeders: 80 },
          { infoHash: pack, name: 'Show S01 Dual 480p', _br: false, _dubbed: true, _quality: '480p', _seeders: 1 },
        ],
        { searchKey, season: 1, episode: 5 } as any,
      ),
    );
    await sleep(20);
    // O pack vem PRIMEIRO no pick (um download serve o binge inteiro); o
    // episódio só entra depois porque ainda há vaga no teto autoFetchMax=4.
    assert.deepEqual(enqueued, [pack, ep], 'série: o pack é enfileirado antes do episódio');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [ep, pack]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

// O Torznab devolve o btih em MAIÚSCULO e o infoHash chega cru do Jackett, mas
// o conjunto de cacheados é sempre minúsculo (debrid/index.js normaliza na ida,
// os adapters na volta). Comparar os dois direto errava em silêncio: o dublado
// já pronto não era reconhecido e o autofetch gastava vaga da conta baixando o
// que dava para tocar na hora. Hash com letras de propósito — dígitos não têm
// caixa e o teste passaria mesmo com a comparação quebrada.
test('BR dublado em cache trava o autofetch mesmo com o infoHash em MAIÚSCULO', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-caixa');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const lower = 'abcdef0123456789abcdef0123456789abcdef01';
  const upper = lower.toUpperCase();
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });

  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-caixa',
    debridCachedOnly: false,
    autoFetchBr: true,
  };
  const searchKey = 'busca-caixa-hash';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set([lower]), known: true });
    await runtime.run({ opts: userOpts, encoded: 'cfg-caixa' }, () =>
      applyDebrid([brDub(upper)], { searchKey } as any),
    );
    await sleep(20);

    assert.deepEqual(enqueued, [], 'cacheado em minúsculo casa com o candidato em maiúsculo');
    assert.equal(held.isHeld(upper, account), false, 'sem download a proteger, o hold é liberado');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, upper));
    held.release(upper, account);
  }
});

test('marker pré-existente pula apenas o hash marcado; um candidato diferente ainda enfileira', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-marker');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });

  const x = 'x'.repeat(40); // marcado como já baixado
  const y = 'y'.repeat(40); // candidato novo
  const markerX = autofetch.markerKey('premiumize', account, x);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-marker',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const run = (h: any, searchKey: any) => runtime.run({ opts: userOpts, encoded: 'cfgm' }, () =>
    applyDebrid([brDub(h)], { searchKey } as any),
  );

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    // Pré-grava o marker de X, como se um download já tivesse sido aceito antes.
    cache.set(markerX, 1, 3600);

    // Busca cujo melhor candidato é X: o marker barra e nada é enfileirado.
    await run(x, 'busca-marker-x');
    await sleep(20);
    assert.deepEqual(enqueued, [], 'hash com marker confirmado não reenfileira');

    // Busca cujo melhor candidato é Y (sem marker): enfileira normalmente —
    // "pula apenas um" significa que o marker é por hash, não por conta/busca.
    await run(y, 'busca-marker-y');
    await sleep(20);
    assert.deepEqual(enqueued, [y], 'hash sem marker continua enfileirando');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, y)), 1, 'o aceite de Y grava o marker dele');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch('busca-marker-x');
    autofetch.releaseSearch('busca-marker-y');
    cache.forget(markerX);
    cache.forget(autofetch.markerKey('premiumize', account, y));
    held.release(x, account);
    held.release(y, account);
  }
});
test('passe parcial e tardio no MESMO searchKey compartilham teto de quatro enqueues', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-dupla');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });

  const h1 = '1'.repeat(40); // candidato do passe parcial
   const h2 = '2'.repeat(40);
   const h3 = '3'.repeat(40);
   const h4 = '4'.repeat(40);
   const h5 = '5'.repeat(40); // quinto candidato deve ser barrado
   const h6 = '6'.repeat(40);
   const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-dupla',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-dupla-passe';
  const run = (h: any) => runtime.run({ opts: userOpts, encoded: 'cfgd' }, () =>
    applyDebrid([brDub(h)], { searchKey } as any),
  );

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    // Passe parcial: enfileira o candidato da primeira leva.
    await run(h1);
    await sleep(20);
    assert.deepEqual(enqueued, [h1], 'primeiro passe enfileira o candidato parcial');

    // O cliente repete a mesma busca: o marker de h1 barra a repetição.
    await run(h1);
    await sleep(20);
    assert.equal(enqueued.length, 1, 'repetição do mesmo passe é barrada pelo marker');

    // Passe tardio traz cinco candidatos novos. O contador compartilhado deixa
    // passar apenas mais três: parcial+tardio nunca excede quatro na busca.
    await run(h2);
    await run(h3);
    await run(h4);
    await run(h5);
    await run(h6);
    await sleep(20);
    assert.deepEqual(enqueued, [h1, h2, h3, h4], 'o teto compartilhado barra o quinto candidato');
    assert.equal(held.isHeld(h5, account), false, 'o quinto candidato é liberado do hold');
    assert.equal(held.isHeld(h6, account), false, 'o sexto candidato é liberado do hold');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h1));
     for (const hash of [h1, h2, h3, h4, h5, h6]) {
       cache.forget(autofetch.markerKey('premiumize', account, hash));
       held.release(hash, account);
     }
  }
});

test('applyDebrid responde sem esperar o enqueue lento (disparo é efeito colateral, não resposta)', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-lenta');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h = '5'.repeat(40);
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });

  let enqueueStarted = 0;
  pmAdapter.enqueue = async () => { enqueueStarted++; await sleep(300); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-lenta',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-enqueue-lento';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const started = Date.now();
    await runtime.run({ opts: userOpts, encoded: 'cfg5' }, () =>
      applyDebrid([brDub(h)], { searchKey } as any),
    );
    const elapsed = Date.now() - started;

    assert.equal(enqueueStarted, 1, 'o enqueue foi disparado');
    assert.ok(elapsed < 250, `applyDebrid não esperou o enqueue de 300ms (respondeu em ${elapsed}ms)`);
    // Deixa a cadeia do aceite terminar para o marker ser gravado e o estado
    // poder ser limpo de forma determinística.
    await sleep(350);
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h)), 1, 'aceite confirmado grava o marker');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('holds: protege antes da checagem, sobrevive ao aceite, e recusa/falha/known:false liberam', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalRegistryEnqueue = debrid.enqueue;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalAdapterEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-holds');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });

  const h1 = 'a'.repeat(40);
  const h2 = 'b'.repeat(40);
  const h3 = 'c'.repeat(40);
  const h4 = 'd'.repeat(40);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-holds',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const run = (h: any, searchKey: any) => runtime.run({ opts: userOpts, encoded: 'cfgh' }, () =>
    applyDebrid([brDub(h)], { searchKey } as any),
  );

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;

    // (1) O hold acontece ANTES da checagem de cache — é ele que impede o
    // dropUncached (um upload, na AllDebrid) de apagar o download no meio da
    // busca. A checagem é o momento crítico; se o hash estiver protegido ali,
    // a limpeza não o toca.
    let heldDuringCheck = false;
    debrid.checkCached = async () => {
      heldDuringCheck = held.isHeld(h1, account);
      return { cached: new Set(), known: true };
    };
    await run(h1, 'hold-aceite');
    assert.equal(heldDuringCheck, true, 'candidato já protegido quando a checagem roda');
    await sleep(20);
    assert.equal(held.isHeld(h1, account), true, 'após o aceite o hold sobrevive até o TTL');
    assert.equal(held.isHeld(h1, 'outra-conta'), false, 'o hold é isolado por conta');

    // (2) known:false libera o hold na hora: sem resposta confiável não há
    // download em andamento para proteger.
    debrid.checkCached = async () => ({ cached: new Set(), known: false });
    await run(h2, 'hold-known-false');
    assert.equal(held.isHeld(h2, account), false, 'known:false libera o candidato');

    // (3) Recusa do serviço (enqueue resolve false) libera o hold e não grava
    // marker — o download não aconteceu, não há o que deduplicar nem proteger.
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    pmAdapter.enqueue = async () => false;
    await run(h3, 'hold-recusa');
    await sleep(20);
    assert.equal(held.isHeld(h3, account), false, 'recusa libera o hold');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h3)), null, 'recusa não grava marker');

    // (4) Falha do enqueue (rejeição) também libera hold, marker e trava de busca.
    debrid.enqueue = async () => { throw new Error('falha simulada'); };
    await run(h4, 'hold-falha');
    await sleep(20);
    assert.equal(held.isHeld(h4, account), false, 'falha libera o hold');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h4)), null, 'falha não grava marker');
  } finally {
    debrid.checkCached = originalCheck;
    debrid.enqueue = originalRegistryEnqueue;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalAdapterEnqueue;
    for (const h of [h1, h2, h3, h4]) {
      held.release(h, account);
      cache.forget(autofetch.markerKey('premiumize', account, h));
    }
    autofetch.releaseSearch('hold-aceite');
    autofetch.releaseSearch('hold-known-false');
    autofetch.releaseSearch('hold-recusa');
    autofetch.releaseSearch('hold-falha');
  }
});

test('falha definitiva do enqueue não é retentada: libera hold e slot sem marker', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-definitiva');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h = '8'.repeat(40);
  const brDub = {
    infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-definitiva',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-falha-definitiva';
  const run = () => runtime.run({ opts: userOpts, encoded: 'cfg-df' }, () =>
    applyDebrid([brDub], { searchKey } as any),
  );

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    // ECONNRESET não é cooldown: nada indica que repetir vai dar certo, então
    // o retry precisa ficar só no estado de cooldown.
    let calls = 0;
    pmAdapter.enqueue = async () => { calls += 1; throw new Error('ECONNRESET'); };
    await run();
    await sleep(50);
    assert.equal(calls, 1, 'falha definitiva não é retentada');
    assert.equal(held.isHeld(h, account), false, 'falha definitiva libera o hold');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h)), null, 'falha definitiva não grava marker');

    // O slot devolvido deixa uma nova busca no MESMO searchKey tentar de novo.
    pmAdapter.enqueue = async () => { calls += 1; return true; };
    await run();
    await sleep(50);
    assert.equal(calls, 2, 'o slot liberado permite o próximo enqueue');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h)), 1, 'a tentativa nova grava o marker');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('passe tardio não duplica o candidato do parcial enquanto o enqueue ainda roda', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-nao-duplica');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h1 = '1'.repeat(40);
  const h2 = '2'.repeat(40);
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-nao-duplica',
    debridCachedOnly: false,
    autoFetchBr: true,
  };
  const searchKey = 'busca-nao-duplica';
  const run = (streams: any) => runtime.run({ opts: userOpts, encoded: 'cfg-nd' }, () =>
    applyDebrid(streams, { searchKey } as any),
  );

  let openEnqueue: (value?: any) => void = () => {};
  const gate = new Promise((resolve) => { openEnqueue = resolve; });
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => {
    enqueued.push(infoHash);
    await gate; // o primeiro enqueue fica em voo enquanto o passe tardio chega
    return true;
  };

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    // Passe parcial: enfileira h1 e o enqueue fica em voo (marker ainda não
    // foi gravado — ele só existe após o aceite).
    await run([brDub(h1)]);
    await sleep(10);

    // Passe tardio chega com o MESMO h1 e um candidato novo. O marker ainda não
    // existe, então é a trava em memória que segura o dedupe: h1 não pode ser
    // enfileirado de novo enquanto o primeiro upload não resolve.
    await run([brDub(h1), brDub(h2)]);
    await sleep(20);
    assert.deepEqual(enqueued, [h1, h2], 'h1 não é duplicado pelo passe tardio');

    openEnqueue();
    await sleep(50);
    assert.equal(enqueued.length, 2, 'após a fila esvaziar o total continua o mesmo');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h1)), 1, 'o aceite do parcial grava o marker');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, h2)), 1, 'o candidato novo do tardio também');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [h1, h2]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

test('recheck pós-enfileiramento esquece a busca quando o download fica pronto', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const account = accountScope('chave-recheck');
  const h = '1'.repeat(40);
  const searchKey = 'busca-recheck';
  const brDub = { infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-recheck',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let checks = 0;
  let serviceInsideRecheck;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    // 1ª checagem é a da busca; a 2ª (recheck) ainda vazia; a 3ª pronta.
    debrid.checkCached = async () => {
      checks += 1;
      serviceInsideRecheck = debrid.current()?.id;
      return checks <= 2
        ? { cached: new Set(), known: true }
        : { cached: new Set([h]), known: true };
    };
    // A busca já está cacheada, como o passe tardio deixa.
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-r' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();
    assert.equal(checks, 1, 'só a checagem da busca rodou até aqui');
    assert.notEqual(cache.get(searchKey), null, 'busca segue cacheada enquanto o download corre');

    // 1º recheck: ainda vazio — reagendado.
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(checks, 2, 'primeiro recheck consultou o debrid');
    // O timer roda FORA do AsyncLocalStorage do request: o contexto capturado
    // precisa estar restaurado, senão a checagem iria sem a conta do usuário.
    assert.equal(serviceInsideRecheck, 'premiumize', 'recheck roda com o contexto da requisição');
    assert.notEqual(cache.get(searchKey), null, 'download não pronto não esquece a busca');

    // 2º recheck: pronto — a busca é esquecida para o cliente reconstruir ⚡.
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(checks, 3, 'segundo recheck consultou o debrid');
    assert.equal(cache.get(searchKey), null, 'busca esquecida quando o download fica pronto');

    // Pronto = lote encerrado: nenhum recheck a mais.
    testMock.timers.tick(600_000);
    await flush();
    assert.equal(checks, 3, 'sem recheck depois de pronto');
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('pack de temporada pronto invalida episódios indexados e semeia davail', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalSeasonFill = config.debrid.autoFetchSeasonFill;
  const originalSeasonIndexMax = config.debrid.autoFetchSeasonIndexMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const apiKey = 'chave-season-fill';
  const account = accountScope(apiKey);
  const imdbId = 'tt1234567';
  const ids = [`${imdbId}:1:1`, `${imdbId}:1:2`];
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: apiKey,
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const keys = ids.map((id) => streamsCacheKey('series', id, { ...userOpts, resolveUncached: config.debrid.resolveUncached }));
  const h = '7'.repeat(40);
  const pack = {
    infoHash: h,
    name: 'Show S01 Dublado',
    title: 'Show S01 Dublado',
    _br: true,
    _dubbed: true,
    _quality: '1080p',
    _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const davailBefore = cache.snapshot().namespaces.davail?.entries || 0;
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchSeasonFill = true;
    config.debrid.autoFetchSeasonIndexMax = 10;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return checks === 1 ? { cached: new Set(), known: true } : { cached: new Set([h]), known: true };
    };
    for (const key of keys) cache.set(key, [{ infoHash: h }], 900);

    // O registro fica no início do findStreams e funciona inclusive em hit.
    await runtime.run({ opts: userOpts, encoded: 'cfg-season-fill' }, async () => {
      for (const id of ids) await findStreams({ type: 'series', id });
    });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-season-fill' }, () =>
      applyDebrid([pack], { searchKey: keys[0], imdbId, season: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.equal(cache.get(keys[0]), null, 'a busca que enfileirou o pack é invalidada');
    assert.equal(cache.get(keys[1]), null, 'outro episódio da mesma temporada é invalidado');
    assert.equal(
      cache.snapshot().namespaces.davail?.entries || 0,
      davailBefore + 1,
      'o hash pronto é semeado no cache de disponibilidade',
    );
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchSeasonFill = originalSeasonFill;
    config.debrid.autoFetchSeasonIndexMax = originalSeasonIndexMax;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    for (const key of keys) cache.forget(key);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('episódio avulso pronto não invalida as outras chaves da temporada', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const account = accountScope('chave-episodio-avulso');
  const h = '6'.repeat(40);
  const searchKey = 'episodio-avulso-um';
  const otherKey = 'episodio-avulso-dois';
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-episodio-avulso',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const episode = {
    infoHash: h, name: 'Show S01E01 Dublado', title: 'Show S01E01 Dublado',
    _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return checks === 1 ? { cached: new Set(), known: true } : { cached: new Set([h]), known: true };
    };
    cache.set(searchKey, { streams: [] }, 900);
    cache.set(otherKey, { streams: [] }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-episodio-avulso' }, () =>
      applyDebrid([episode], { searchKey, imdbId: 'tt7654321', season: 1, episode: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.equal(cache.get(searchKey), null, 'a busca do próprio episódio é invalidada');
    assert.notEqual(cache.get(otherKey), null, 'episódio avulso não invalida a temporada toda');
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    cache.forget(searchKey);
    cache.forget(otherKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('LRU do índice descarta a temporada mais antiga sem invalidar suas chaves', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalSeasonFill = config.debrid.autoFetchSeasonFill;
  const originalSeasonIndexMax = config.debrid.autoFetchSeasonIndexMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const apiKey = 'chave-season-lru';
  const imdbId = 'tt7777777';
  const userOpts = {
    ...runtime.defaults(), debridService: 'premiumize', debridApiKey: apiKey, debridCachedOnly: true, autoFetchBr: true,
  };
  const ids = [`${imdbId}:1:1`, `${imdbId}:1:2`, `${imdbId}:2:1`];
  const keys = ids.map((id) => streamsCacheKey('series', id, { ...userOpts, resolveUncached: config.debrid.resolveUncached }));
  const h = '5'.repeat(40);
  const pack = {
    infoHash: h, name: 'Show S01 Dublado', title: 'Show S01 Dublado',
    _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchSeasonFill = true;
    config.debrid.autoFetchSeasonIndexMax = 1;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return checks === 1 ? { cached: new Set(), known: true } : { cached: new Set([h]), known: true };
    };
    for (const key of keys) cache.set(key, [{ infoHash: h }], 900);
    await runtime.run({ opts: userOpts, encoded: 'cfg-season-lru' }, async () => {
      for (const id of ids) await findStreams({ type: 'series', id });
    });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-season-lru' }, () =>
      applyDebrid([pack], { searchKey: keys[0], imdbId, season: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.notEqual(cache.get(keys[1]), null, 'S01 foi despejada quando S02 ocupou a única vaga LRU');
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchSeasonFill = originalSeasonFill;
    config.debrid.autoFetchSeasonIndexMax = originalSeasonIndexMax;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    for (const key of keys) cache.forget(key);
    cache.forget(autofetch.markerKey('premiumize', accountScope(apiKey), h));
    held.release(h, accountScope(apiKey));
  }
});

test('recheck esgota as tentativas sem esquecer a busca quando nada fica pronto', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const account = accountScope('chave-recheck-max');
  const h = '9'.repeat(40);
  const searchKey = 'busca-recheck-max';
  const brDub = { infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-recheck-max',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return { cached: new Set(), known: true };
    };
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-rm' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();
    assert.equal(checks, 1);

    // Default RECHECK_MAX=3: três rechecks e para (1 busca + 3 = 4 checagens).
    for (let i = 0; i < 3; i += 1) {
      testMock.timers.tick(120_000);
      await flush();
    }
    assert.equal(checks, 4, 'três rechecks e nenhum a mais');
    assert.notEqual(cache.get(searchKey), null, 'sem download pronto a busca segue valendo');

    testMock.timers.tick(600_000);
    await flush();
    assert.equal(checks, 4, 'lote esgotado não agenda mais nada');
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

// Filme sem dublagem NENHUMA (o caso Beyond Re-Animator): o pool BR volta
// vazio, o global dublado também, e antes o terceiro nível era pulado porque
// exigia `season != null`. Resultado: nada baixado, e com "somente já em
// cache" ligado o usuário via zero opção em toda busca, para sempre.
test('terceiro nível: filme sem dublado nenhum enfileira os melhores por seeders', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-seeds-filme');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const h1 = '1'.repeat(40);
  const h2 = '2'.repeat(40);
  const h3 = '3'.repeat(40);
  const cam = '4'.repeat(40);
  const morto = '5'.repeat(40);
  const leg = (h: any, name: any, seeds: any) => ({
    infoHash: h, name, title: name, _br: false, _dubbed: false, _seeders: seeds,
  });
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-seeds-filme',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-seeds-filme';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    await runtime.run({ opts: userOpts, encoded: 'cfg-seeds-filme' }, () =>
      applyDebrid(
        [
          leg(h1, 'Beyond Re-Animator 2003 1080p BluRay', 47),
          leg(h3, 'Beyond Re-Animator 2003 720p WEB-DL', 5),
          leg(h2, 'Beyond Re-Animator 2003 1080p WEBRip', 59),
          // CAM não entra nem com o maior swarm da lista.
          leg(cam, 'Beyond Re-Animator 2003 HDCAM', 900),
          // Abaixo do piso de seeders: morre na fila do debrid.
          leg(morto, 'Beyond Re-Animator 2003 DVDRip', 1),
        ],
        { searchKey } as any,
      ),
    );
    await sleep(20);
    // Teto de 2 (autoFetchTopSeedsMax), na ordem do swarm: 59 e depois 47.
    assert.deepEqual(enqueued, [h2, h1], 'os dois maiores swarms saudáveis são enfileirados');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [h1, h2, h3, cam, morto]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

// O gate do terceiro nível é "NADA toca": um único stream pronto já entrega
// play, e gastar a conta baixando outro não melhora nada para o usuário.
test('terceiro nível não dispara quando já existe qualquer fonte tocável', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const account = accountScope('chave-seeds-gate');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const pronto = 'a'.repeat(40);
  const outro = 'b'.repeat(40);
  const enqueued: string[] = [];
  pmAdapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-seeds-gate',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = 'busca-seeds-gate';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    debrid.checkCached = async () => ({ cached: new Set([pronto]), known: true });

    await runtime.run({ opts: userOpts, encoded: 'cfg-seeds-gate' }, () =>
      applyDebrid(
        [
          { infoHash: pronto, name: 'Filme 720p', title: 'Filme 720p', _seeders: 4 },
          { infoHash: outro, name: 'Filme 1080p', title: 'Filme 1080p', _seeders: 400 },
        ],
        { searchKey } as any,
      ),
    );
    await sleep(20);
    assert.deepEqual(enqueued, [], 'com algo tocável, o terceiro nível fica quieto');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
    for (const h of [pronto, outro]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});

// Um torrent "parado" (running com progresso 0 e mensagem 0 bytes/peers) tem
// limiar PRÓPRIO no recheck: não morre como um dead (2 rechecks), espera
// autoFetchStallStreak observações consecutivas antes de seguir o mesmo
// desfecho (blacklist + remoção + dreno da fila). A falta de pares pode ser
// transitória, então uma única observação isolada não pode derrubar o download.
test('parado (stalled) por N rechecks: colapsa no limiar próprio com blacklist+remoção+dreno', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stalled');
  const h = '3'.repeat(40);
  const searchKey = 'busca-stalled';
  const brDub = { infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-stalled',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const stalledBefore = metrics.snapshot().counters['autofetch.stalled'] || 0;
  let removals = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchStallStreak = 2;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({ [h]: { state: 'downloading', stalled: true, id: 99 } });
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();

    // 1º recheck: parado mas abaixo do limiar — segue vivo.
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), false, '1ª observação isolada não derruba');
    assert.equal(removals, 0);

    // 2º recheck: atinge autoFetchStallStreak=2 -> colapso real, mesmo caminho do dead.
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), true, 'no limiar vira blacklist');
    assert.equal(held.isHeld(h, account), false, 'parado colapsado libera o hold');
    assert.equal(removals, 1, 'remoção dispara no colapso');
    assert.equal(
      (metrics.snapshot().counters['autofetch.stalled'] || 0) - stalledBefore,
      1,
      'métrica autofetch.stalled contada no colapso',
    );

    // Colapso esvazia o lote: nenhum recheck a mais.
    testMock.timers.tick(600_000);
    await flush();
    assert.equal(removals, 1, 'sem recheck depois do colapso');
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('movimento zera a contagem de stall: só observações CONSECUTIVAS derrubam', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const originalRecheckMax = config.debrid.autoFetchRecheckMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stall-move');
  const h = '4'.repeat(40);
  const searchKey = 'busca-stall-move';
  const brDub = { infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-stall-move',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let removals = 0;
  let stallMode = true;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchStallStreak = 2;
    // Consegue o ciclo todo no intervalo curto do recheck sem migrar pro
    // estado de settle (que troca o intervalo pra autoFetchSettleMs); o teste
    // é sobre o streak, não sobre o LRU de settle.
    config.debrid.autoFetchRecheckMax = 20;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({ [h]: { state: 'downloading', stalled: stallMode, id: 99 } });
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall-move' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();

    // 1º recheck: parado (streak 1).
    testMock.timers.tick(120_000);
    await flush();

    // 2º recheck: MOVIMENTO (não-parado) — zera o streak; nada acontece.
    stallMode = false;
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), false, 'movimento não derruba');
    assert.equal(removals, 0);

    // 3º recheck: parado de novo (streak volta a 1) — abaixo do limiar.
    stallMode = true;
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(removals, 0, 'depois do movimento, um stall isolado não reinicia o limiar mais rápido');
    assert.equal(autofetch.isDead('premiumize', account, h), false);

    // 4º recheck: segundo stall consecutivo — agora sim colapsa.
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), true, 'stalls consecutivos após o reset derrubam');
    assert.equal(removals, 1);
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    config.debrid.autoFetchRecheckMax = originalRecheckMax;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

// Dead e stall têm contadores SEPARADOS: um stall prévio não pode valer como
// primeira observação de morte. O contrato é "2 dead consecutivos" — com o
// contador compartilhado, um dead transitório único após um stall derrubaria
// download ainda recuperável.
test('stall prévio não adianta o colapso do dead: contadores são independentes', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const originalRecheckMax = config.debrid.autoFetchRecheckMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stall-dead');
  const h = '5'.repeat(40);
  const searchKey = 'busca-stall-dead';
  const brDub = { infoHash: h, name: 'Coringa Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-stall-dead',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let removals = 0;
  let mode: 'stall' | 'dead' | 'moving' = 'stall';

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchStallStreak = 3;
    config.debrid.autoFetchRecheckMax = 20;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => mode === 'stall'
      ? { [h]: { state: 'downloading', stalled: true, id: 99 } }
      : mode === 'dead'
        ? { [h]: { state: 'dead', id: 99 } }
        : { [h]: { state: 'downloading', id: 99 } };
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    cache.set(searchKey, { streams: [], partial: false }, 900);

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall-dead' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();

    // 1º recheck: stall (stallStreak 1; deadStreak 0).
    testMock.timers.tick(120_000);
    await flush();

    // 2º recheck: UM dead — herdaria o ponto do stall se o contador fosse
    // compartilhado e colapsaria aqui. Contadores separados: nada ainda.
    mode = 'dead';
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), false, '1º dead após stall não colapsa');
    assert.equal(removals, 0);

    // 3º recheck: SEGUNDO dead consecutivo — agora colapsa.
    testMock.timers.tick(120_000);
    await flush();
    assert.equal(autofetch.isDead('premiumize', account, h), true, '2º dead consecutivo colapsa');
    assert.equal(removals, 1);
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    config.debrid.autoFetchRecheckMax = originalRecheckMax;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

// "Temporada Completa" SEM número não prova qual temporada o pack contém (o
// post do NerdFilmes anunciando S04 com S03 dentro é exatamente esse caso).
// O Season Pack Fill só roda com prova: número casando com a temporada pedida
// ou série completa. Sem isso o pack pronto NÃO semeia ⚡ nem invalida a
// temporada — a constatação fica para o pickFile do play.
test('pack "Temporada Completa" sem número não dispara season fill', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalSeasonFill = config.debrid.autoFetchSeasonFill;
  const originalSeasonIndexMax = config.debrid.autoFetchSeasonIndexMax;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const apiKey = 'chave-season-fill-sem-numero';
  const account = accountScope(apiKey);
  const imdbId = 'tt7654321';
  const ids = [`${imdbId}:1:1`, `${imdbId}:1:2`];
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: apiKey,
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const keys = ids.map((id) => streamsCacheKey('series', id, { ...userOpts, resolveUncached: config.debrid.resolveUncached }));
  const h = '8'.repeat(40);
  const pack = {
    infoHash: h,
    name: 'Show Temporada Completa Dublado',
    title: 'Show Temporada Completa Dublado',
    _br: true,
    _dubbed: true,
    _quality: '1080p',
    _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const davailBefore = cache.snapshot().namespaces.davail?.entries || 0;
  const fillBefore = metrics.snapshot().counters['autofetch.season-fill'] || 0;
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchSeasonFill = true;
    config.debrid.autoFetchSeasonIndexMax = 10;
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return checks === 1 ? { cached: new Set(), known: true } : { cached: new Set([h]), known: true };
    };
    for (const key of keys) cache.set(key, [{ infoHash: h }], 900);

    await runtime.run({ opts: userOpts, encoded: 'cfg-fill-sem-numero' }, async () => {
      for (const id of ids) await findStreams({ type: 'series', id });
    });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-fill-sem-numero' }, () =>
      applyDebrid([pack], { searchKey: keys[0], imdbId, season: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    // A busca que enfileirou é invalidada pelo caminho ready comum e TODO hash
    // pronto semeia davail; só a invalidação da temporada exige prova (fill).
    assert.equal(cache.get(keys[1]) != null, true, 'episódio vizinho não é invalidado sem prova de temporada');
    assert.equal(
      cache.snapshot().namespaces.davail?.entries || 0,
      davailBefore + 1,
      'hash pronto é semeado no cache de disponibilidade mesmo sem prova de temporada',
    );
    assert.equal(
      (metrics.snapshot().counters['autofetch.season-fill'] || 0) - fillBefore,
      0,
      'métrica de fill não conta',
    );
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchSeasonFill = originalSeasonFill;
    config.debrid.autoFetchSeasonIndexMax = originalSeasonIndexMax;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    for (const key of keys) cache.forget(key);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

// I2 — hash pronto recebe o positivo davail, não só pack de temporada. Hash
// de filme/episódio que fica tocável no recheck semeia disponibilidade para a
// próxima lista marcar ⚡ sem repetir a consulta ao debrid, e o contador
// autofetch.ready-note registra cada ready que semeia.
test('hash NÃO-pack pronto no recheck semeia davail', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const apiKey = 'chave-davail-nao-pack';
  const account = accountScope(apiKey);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: apiKey,
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const searchKey = streamsCacheKey('movie', 'tt5555555', { ...userOpts, resolveUncached: config.debrid.resolveUncached });
  const h = 'f'.repeat(40);
  const filme = {
    infoHash: h,
    name: 'Filme Qualquer Dublado',
    title: 'Filme Qualquer Dublado',
    _br: true,
    _dubbed: true,
    _quality: '1080p',
    _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const davailBefore = cache.snapshot().namespaces.davail?.entries || 0;
  const readyNoteBefore = metrics.snapshot().counters['autofetch.ready-note'] || 0;
  let checks = 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({});
    debrid.checkCached = async () => {
      checks += 1;
      return checks === 1 ? { cached: new Set(), known: true } : { cached: new Set([h]), known: true };
    };

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-davail-nao-pack' }, () =>
      applyDebrid([filme], { searchKey } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.equal(checks >= 2, true, 'o recheck consultou o debrid depois do aceite');
    assert.equal(cache.get(searchKey), null, 'a busca que enfileirou é invalidada quando o download fica pronto');
    assert.equal(
      cache.snapshot().namespaces.davail?.entries || 0,
      davailBefore + 1,
      'hash NÃO-pack pronto é semeado no cache de disponibilidade',
    );
    assert.equal(
      (metrics.snapshot().counters['autofetch.ready-note'] || 0) - readyNoteBefore,
      1,
      'o ready que semeia o davail conta em autofetch.ready-note',
    );
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

// -----------------------------------------------------------------------------
// T4a (Tarefa 3.4): Season Fill Negativo para Adaptadores sem cacheCheck
// -----------------------------------------------------------------------------
test('T4a: adaptador sem cacheCheck (Real-Debrid/Debrid-Link) não semeia davail nem conta season-fill', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalSeasonFill = config.debrid.autoFetchSeasonFill;
  const originalSeasonIndexMax = config.debrid.autoFetchSeasonIndexMax;
  const rdAdapter = debrid.BY_ID.get('realdebrid') as DebridAdapter;
  // O G2 ligou o oráculo por padrão; para exercitar o contrato "adaptador SEM
  // cacheCheck" este teste desliga ledger+oráculo (que juntos elevam o flag).
  const originalLedger = config.debrid.rdLedger.enabled;
  const originalOracle = config.debrid.rdOracle.enabled;
  const originalEnqueue = rdAdapter.enqueue;
  const originalTorrentStatus = rdAdapter.torrentStatus;
  const apiKey = 'chave-season-fill-rd';
  const account = accountScope(apiKey);
  const imdbId = 'tt8888888';
  const ids = [`${imdbId}:1:1`, `${imdbId}:1:2`];
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'realdebrid',
    debridApiKey: apiKey,
    debridCachedOnly: false,
    autoFetchBr: true,
  };
  const keys = ids.map((id) => streamsCacheKey('series', id, { ...userOpts, resolveUncached: config.debrid.resolveUncached }));
  const h = '8'.repeat(40);
  const pack = {
    infoHash: h,
    name: 'Show RD S01 Dublado',
    title: 'Show RD S01 Dublado',
    _br: true,
    _dubbed: true,
    _quality: '1080p',
    _seeders: 1,
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const davailBefore = cache.snapshot().namespaces.davail?.entries || 0;
  const fillBefore = metrics.snapshot().counters['autofetch.season-fill'] || 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchSeasonFill = true;
    config.debrid.autoFetchSeasonIndexMax = 10;
    config.debrid.rdLedger.enabled = false;
    config.debrid.rdOracle.enabled = false;
    rdAdapter.enqueue = async () => true;
    rdAdapter.torrentStatus = async () => ({ [h]: { state: 'ready', id: 'rd-1' } });
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    for (const key of keys) cache.set(key, [{ infoHash: h }], 900);

    await runtime.run({ opts: userOpts, encoded: 'cfg-sf-rd' }, async () => {
      for (const id of ids) await findStreams({ type: 'series', id });
    });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-sf-rd' }, () =>
      applyDebrid([pack], { searchKey: keys[0], imdbId, season: 1 } as any),
    );
    await flush();
    testMock.timers.tick(120_000);
    await flush();

    assert.equal(
      cache.snapshot().namespaces.davail?.entries || 0,
      davailBefore,
      'adaptador com cacheCheck: false não semeia davail',
    );
    assert.equal(
      (metrics.snapshot().counters['autofetch.season-fill'] || 0) - fillBefore,
      0,
      'adaptador com cacheCheck: false não incrementa autofetch.season-fill',
    );
  } finally {
    testMock.timers.reset();
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchSeasonFill = originalSeasonFill;
    config.debrid.autoFetchSeasonIndexMax = originalSeasonIndexMax;
    config.debrid.rdLedger.enabled = originalLedger;
    config.debrid.rdOracle.enabled = originalOracle;
    rdAdapter.enqueue = originalEnqueue;
    rdAdapter.torrentStatus = originalTorrentStatus;
    for (const key of keys) cache.forget(key);
    cache.forget(autofetch.markerKey('realdebrid', account, h));
    held.release(h, account);
  }
});

// -----------------------------------------------------------------------------
// T4b (Tarefa 3.5): autoFetchStallStreak = 0 Desativa Colapso por Stall
// -----------------------------------------------------------------------------
test('T4b: autoFetchStallStreak = 0 não colapsa nem remove torrent stalled (parado nunca derruba)', async () => {
  const testMock = mock;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalStall = config.debrid.autoFetchStallStreak;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalTorrentStatus = pmAdapter.torrentStatus;
  const originalRemoveTorrent = pmAdapter.removeTorrent;
  const account = accountScope('chave-stall-zero');
  const h = '9'.repeat(40);
  const searchKey = 'busca-stall-zero';
  const brDub = { infoHash: h, name: 'Filme Stall Zero Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1 };
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-stall-zero',
    debridCachedOnly: false,
    autoFetchBr: true,
  };
  let removals = 0;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const stalledBefore = metrics.snapshot().counters['autofetch.stalled'] || 0;

  try {
    config.debrid.autoFetchStallStreak = 0; // Desativa remoção por stall
    config.debrid.publicUrl = 'http://addon.test';
    pmAdapter.enqueue = async () => true;
    pmAdapter.torrentStatus = async () => ({ [h]: { state: 'downloading', stalled: true, id: 99 } });
    pmAdapter.removeTorrent = async () => { removals += 1; return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });

    testMock.timers.enable({ apis: ['setTimeout'] });
    await runtime.run({ opts: userOpts, encoded: 'cfg-stall-zero' }, () =>
      applyDebrid([brDub], { searchKey } as any),
    );
    await flush();

    // Executa múltiplos ciclos de recheck com stalled: true reportado
    for (let i = 0; i < 5; i++) {
      testMock.timers.tick(120_000);
      await flush();
    }

    assert.equal(removals, 0, 'com autoFetchStallStreak=0 removeTorrent nunca é chamado');
    assert.equal(
      autofetch.isDead('premiumize', account, h),
      false,
      'torrent stalled não entra em blacklist quando stallStreak é 0',
    );
    assert.equal(
      (metrics.snapshot().counters['autofetch.stalled'] || 0) - stalledBefore,
      0,
      'métrica autofetch.stalled não é incrementada',
    );
  } finally {
    testMock.timers.reset();
    config.debrid.autoFetchStallStreak = originalStall;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.torrentStatus = originalTorrentStatus;
    pmAdapter.removeTorrent = originalRemoveTorrent;
    autofetch.releaseSearch(searchKey);
    cache.forget(searchKey);
    cache.forget(autofetch.markerKey('premiumize', account, h));
    held.release(h, account);
  }
});

test('gate de ocupação: memo frio é fail-open e memo quente acima do limiar bloqueia o enqueue', async () => {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalEnqueue = pmAdapter.enqueue;
  const originalStatus = pmAdapter.accountStatus;
  const account = accountScope('chave-gate-cheia');
  const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));
  const brDub = (hash: any) => ({
    infoHash: hash, name: 'Filme Conta Cheia Dublado', _br: true, _dubbed: true, _quality: '1080p', _seeders: 1,
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-gate-cheia',
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const run = (h: any, searchKey: any) => runtime.run({ opts: userOpts, encoded: 'cfg-gate' }, () =>
    applyDebrid([brDub(h)], { searchKey } as any),
  );
  const hCold = 'e'.repeat(40);
  const hHot = 'f'.repeat(40);
  let enqueues = 0;
  const gatedBefore = metrics.snapshot().counters['autofetch.account-gated'] || 0;

  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchPauseAt = 5;
    pmAdapter.enqueue = async () => { enqueues += 1; return true; };
    pmAdapter.accountStatus = async () => ({ magnets: 900 });
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    autofetch.resetAccountGate();

    // (1) Memo frio: a primeira chamada não bloqueia (fail-open) e o refresh
    // em background grava a contagem — a segunda já decide com evidência.
    assert.equal(autofetch.accountGateBlocked(pmAdapter, 'chave-gate-cheia'), false, 'memo frio não bloqueia');
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(pmAdapter, 'chave-gate-cheia'), true, 'memo quente acima do limiar bloqueia');

    // (2) Memo quente: o enqueue NÃO chega no debrid e o hold é liberado.
    await run(hHot, 'gate-cheio');
    await sleep(20);
    assert.equal(enqueues, 0, 'conta cheia impede o debrid.enqueue');
    assert.equal(held.isHeld(hHot, account), false, 'bloqueio libera o hold do candidato');
    assert.equal(cache.get(autofetch.markerKey('premiumize', account, hHot)), null, 'bloqueio não grava marker');
    assert.equal(
      (metrics.snapshot().counters['autofetch.account-gated'] || 0) - gatedBefore,
      1,
      'bloqueio contado uma vez em autofetch.account-gated',
    );

    // (3) Fail-open no caminho real: memo frio de novo, a busca enfileira.
    autofetch.resetAccountGate();
    await run(hCold, 'gate-frio');
    await sleep(20);
    assert.equal(enqueues, 1, 'primeira chamada com memo frio enfileira normalmente');
    assert.equal(held.isHeld(hCold, account), true, 'aceite mantém o hold');

    // (4) Flag 0 desliga o gate mesmo com memo quente.
    assert.equal(autofetch.accountGateBlocked(pmAdapter, 'chave-gate-cheia'), true, 'refresh da busca fria reaqueceu o memo');
    config.debrid.autoFetchPauseAt = 0;
    assert.equal(autofetch.accountGateBlocked(pmAdapter, 'chave-gate-cheia'), false, 'flag 0 desliga o gate');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchPauseAt = originalPauseAt;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.accountStatus = originalStatus;
    autofetch.resetAccountGate();
    autofetch.releaseSearch('gate-frio');
    autofetch.releaseSearch('gate-cheio');
    for (const h of [hCold, hHot]) {
      cache.forget(autofetch.markerKey('premiumize', account, h));
      held.release(h, account);
    }
  }
});
