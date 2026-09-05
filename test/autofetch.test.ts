import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

// Escolha do que baixar + proteção do hash: as duas peças que decidem se algo é
// escrito na conta do usuário. Testadas sem rede, com objetos de stream mínimos.
import { pickBrDubbedCandidate, hasCachedBrDubbed, canAutoFetchBr, uncachedBrHashes, filterKnownCache, pickTopSeededCandidates } from '../src/utils/format.js';
import { sortAndLimit, toStremioStream, limitReservingBr } from '../src/utils/format.js';
import * as held from '../src/debrid/protected.js';
import * as autofetch from '../src/providers/autofetch.js';
import type { DebridAdapter } from '../types/domain.js';

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
  // Nenhum BR tem marca de áudio: cai no padrão BR é dublado, menos o legendado.
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
// saíam 2. A página chama isso de vagas garantidas, então a reserva tem que
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
