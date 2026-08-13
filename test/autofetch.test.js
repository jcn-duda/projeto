const { test } = require('node:test');
const assert = require('node:assert');

// Escolha do que baixar + proteção do hash: as duas peças que decidem se algo é
// escrito na conta do usuário. Testadas sem rede, com objetos de stream mínimos.
const {
  pickBrDubbedCandidate,
  hasCachedBrDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
} = require('../src/utils/format');
const { sortAndLimit, toStremioStream, limitReservingBr } = require('../src/utils/format');
const held = require('../src/debrid/protected');
const autofetch = require('../src/providers/autofetch');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const stream = (infoHash, extra = {}) => ({ infoHash, name: 'Release', ...extra });

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
    name: '[PM+]\n1080p LEG BR',
    title: 'Coringa (2019) [LEGENDADO opção 1]\n👤 1',
    _br: true,
  });
  const sem = stream(B, {
    name: '[PM+]\nBR',
    title: 'Coringa (2019) [opção 2]\n👤 1',
    _br: true,
  });
  assert.equal(pickBrDubbedCandidate([leg, sem]), sem);
  // Só legendado disponível: não baixa nada.
  assert.equal(pickBrDubbedCandidate([leg]), null);
});

test('pickBrDubbedCandidate exige infoHash', () => {
  // Stream já resolvido pelo debrid não tem hash — não há o que enfileirar.
  assert.equal(pickBrDubbedCandidate([{ name: 'Coringa', _br: true, _dubbed: true }]), null);
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
  assert.equal(key.startsWith('autofetch:v2:'), true);
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

test('autofetch só pode escrever na conta em modo somente-cache', () => {
  const adapter = { cacheCheck: true };
  assert.equal(canAutoFetchBr({ autoFetchBr: true, debridCachedOnly: true }, adapter), true);
  assert.equal(canAutoFetchBr({ autoFetchBr: true, debridCachedOnly: false }, adapter), false);
  assert.equal(canAutoFetchBr({ autoFetchBr: false, debridCachedOnly: true }, adapter), false);
  assert.equal(canAutoFetchBr({ autoFetchBr: true, debridCachedOnly: true }, { cacheCheck: false }), false);
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
