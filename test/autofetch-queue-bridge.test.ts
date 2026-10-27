// Prova de round-trip do FORMATO v3 da fila do Chupim entre o Node e o Rust —
// o degrau 1 da T3-L5 (o crate `adom-autofetch::v3`), SEM wiring: o caminho de
// produção (`writeQueue`/`readQueue` do Node) continua intacto. O que se prova
// aqui, contra o código REAL dos dois lados:
//   1. a chave é o MESMO sha256 hex minúsculo (`queueKey` TS === napi);
//   2. o JSON que o `writeQueue`/`toQueueCandidate` reais gravam é legível pelo
//      Rust (`QueueCandidate`) sem perda (deepEqual exato);
//   3. o que o Rust grava é o que o dreno TS lê (mesma semântica de campo,
//      inclusive `null` da sonda e `addedAt` preenchido);
//   4. dead/marker têm o MESMO escopo e as MESMAS formas (`1`, `{id}`, meta).
//
// Ponte de storage do teste: o `cache.set` do Node despeja no SQLite no
// próximo tick e o handle nativo é `:memory:` (CACHE_PERSIST=false), então o
// teste TRANSPORTA o valor exato que o Node produziu para o handle via
// `setJson` — o mesmo INSERT da tabela `cache` provado em debrid-kv-owned.
// Nada aqui é fixture inventado: o JSON sai do `writeQueue` de verdade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';

import * as autofetch from '../src/providers/autofetch.js';
import { toQueueCandidate, type AutoFetchStream } from '../src/providers/autofetch-fallback.js';
import { markerValue } from '../src/providers/autofetch-marker.js';
import * as cache from '../src/utils/cache.js';
import { nativeKv, kvPeek } from '../src/utils/native-kv.js';
import { requireCore } from '../src/utils/rust-core.js';
import type { Stream } from '../types/domain.js';
import type { QueueCandidate } from '../src/providers/autofetch.js';

// Superfície do núcleo para o formato v3. Tipada LOCALMENTE: a ponte de
// PRODUÇÃO da fila nasce com o wiring da T3-L5; aqui é o contrato de prova.
type QueueV3Core = {
  autofetchV3QueueKey(searchKey: string): string;
  autofetchV3ReadQueue(kv: unknown, searchKey: string, nowMs: number): string | null;
  autofetchV3WriteQueue(
    kv: unknown,
    searchKey: string,
    candidatesJson: string,
    opts: { ttlSeconds: number; depth: number; adapterId?: string | null; account?: string | null },
    nowMs: number,
  ): { kept: number; dropped: number };
  autofetchV3DropQueue(kv: unknown, keyOrSearchKey: string): boolean;
  autofetchV3MarkDead(
    kv: unknown, adapterId: string, account: string, infoHash: string,
    ttlSeconds: number, nowMs: number,
  ): void;
  autofetchV3IsDead(kv: unknown, adapterId: string, account: string, infoHash: string, nowMs: number): boolean;
  autofetchV3SetMarker(
    kv: unknown, adapterId: string, account: string, infoHash: string,
    valueJson: string, ttlSeconds: number, nowMs: number,
  ): void;
  autofetchV3Marker(kv: unknown, adapterId: string, account: string, infoHash: string, nowMs: number): string | null;
  autofetchV3ForgetMarker(kv: unknown, adapterId: string, account: string, infoHash: string): boolean;
};

const core = requireCore() as unknown as QueueV3Core;
const kv = nativeKv();
// Relógio REAL: o `kvPeek` lê com `Date.now()`, então a base do teste tem que
// ser o agora (os TTLs são curtos e os reads usam `NOW + 1`).
const NOW = Date.now();
const ADAPTER = 'alldebrid';
const ACCOUNT = 'acc-bridge';
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

/** Stream no formato que o runner entrega (campos `_` que o candidato lê). */
function stream(hash: string, over: Partial<Stream> = {}): AutoFetchStream {
  return {
    infoHash: hash,
    name: 'Lanterns S01 1080p WEB-DL DUAL',
    title: 'Lanterns S01 1080p WEB-DL DUBLADO\n👤 9 💾 750.51 MB 📦 pack 70.36 GB (média) ⚙️ bludv',
    _quality: '1080p',
    _seeders: 9,
    _size: 75591424471,
    _br: true,
    _dubbed: true,
    _bankDub: true,
    _lied: false,
    ...over,
  } as unknown as AutoFetchStream;
}

function packCandidate(hash: string): QueueCandidate {
  return toQueueCandidate(stream(hash), 'seeds', {
    imdbId: 'tt1234567',
    season: 1,
    episode: 8,
    seasonFill: true,
    rare: true,
    slotLimit: 2,
  });
}

/** Transporta o valor EXATO do cache do Node para o handle nativo e o devolve. */
function transport(key: string, ttlSeconds = 3600): unknown {
  const value = cache.get(key);
  assert.ok(value != null, `valor do Node presente em ${key}`);
  // O `setJson` bruto devolve void; a prova de escrita é a leitura de cima.
  kv.setJson(key, JSON.stringify(value), ttlSeconds, NOW);
  return value;
}

test('a chave da fila é o MESMO sha256 no Node e no Rust', () => {
  const searchKey = 'streams:v5:series:tt0903747:1:1';
  assert.equal(core.autofetchV3QueueKey(searchKey), autofetch.queueKey(searchKey));
  assert.ok(autofetch.queueKey(searchKey).startsWith('autofetch:v3:q:'));
});

test('writeQueue REAL do Node → QueueCandidate do Rust, sem perda', () => {
  const searchKey = 'streams:v6:movie:ttBridgeTsToRust';
  try {
    const cand = packCandidate(H1);
    autofetch.writeQueue(searchKey, [cand], 3600, ADAPTER, ACCOUNT);
    // `nodeValue` é EXATAMENTE o que o writeQueue gravou (addedAt incluído).
    const nodeValue = transport(autofetch.queueKey(searchKey)) as QueueCandidate[];

    const rustJson = core.autofetchV3ReadQueue(kv, searchKey, NOW + 1);
    assert.ok(rustJson, 'o Rust lê a fila que o Node gravou');
    const rustCandidates = JSON.parse(rustJson!) as QueueCandidate[];
    assert.equal(rustCandidates.length, 1);
    // Round-trip exato: null da sonda, boolean falso, número inteiro — tudo.
    assert.deepEqual(rustCandidates, nodeValue);
    assert.equal(rustCandidates[0].addedAt, (nodeValue[0] as { addedAt?: number }).addedAt);
    assert.equal(rustCandidates[0].probeSeason, 1);
    assert.equal(rustCandidates[0].episode, null, 'pack persiste episódio nulo');
  } finally {
    autofetch.dropQueue(searchKey);
  }
});

test('fila gravada pelo Rust → leitura do dreno TS com a mesma semântica', () => {
  const searchKey = 'streams:v6:movie:ttBridgeRustToTs';
  try {
    const cand = packCandidate(H1);
    const report = core.autofetchV3WriteQueue(
      kv, searchKey, JSON.stringify([cand]),
      { ttlSeconds: 3600, depth: 8, adapterId: ADAPTER, account: ACCOUNT }, NOW,
    );
    assert.deepEqual(report, { kept: 1, dropped: 0 });

    const raw = kvPeek(autofetch.queueKey(searchKey)) as QueueCandidate[];
    assert.ok(Array.isArray(raw), 'a fila do Rust está na tabela cache no formato do Node');
    // O addedAt ausente nasce de now (o `c.addedAt || Date.now()` do writeQueue).
    assert.deepEqual(raw, [{ ...cand, addedAt: NOW }]);

    // As cadeias do dreno (`autofetch-drain.ts`) sobre o que o Rust gravou:
    const c = raw[0];
    assert.equal(c.probeSeason ?? c.season ?? null, 1, 'identidade da sonda sobrevive');
    assert.equal(
      c.probeEpisode ?? (c.isPack === true ? null : (c.episode ?? null)),
      8,
      'sonda do episódio sobrevive ao pack com episode nulo',
    );
    assert.equal(c.bankDub, true, 'marca do banco para o protectBr');

    // Dedupe primeiro-vence + descarte do hash morto, agora no lado Rust.
    core.autofetchV3MarkDead(kv, ADAPTER, ACCOUNT, H2, 3600, NOW);
    const report2 = core.autofetchV3WriteQueue(
      kv, searchKey, JSON.stringify([{ ...cand, infoHash: H2 }, { ...cand, infoHash: H1 }, { ...cand, infoHash: H1 }]),
      { ttlSeconds: 3600, depth: 8, adapterId: ADAPTER, account: ACCOUNT }, NOW + 2,
    );
    assert.deepEqual(report2, { kept: 1, dropped: 2 }, 'morto sai e duplicado fica o primeiro');
    const after = kvPeek(autofetch.queueKey(searchKey)) as QueueCandidate[];
    assert.deepEqual(after.map((x) => x.infoHash), [H1]);
  } finally {
    core.autofetchV3DropQueue(kv, searchKey);
  }
});

test('writeQueue sem sobrevivente esquece a chave (regra do purgeSeedsQueue)', () => {
  const searchKey = 'streams:v6:movie:ttBridgePurge';
  core.autofetchV3WriteQueue(
    kv, searchKey, JSON.stringify([packCandidate(H1)]),
    { ttlSeconds: 3600, depth: 8, adapterId: ADAPTER, account: ACCOUNT }, NOW,
  );
  core.autofetchV3WriteQueue(
    kv, searchKey, JSON.stringify([]),
    { ttlSeconds: 3600, depth: 8, adapterId: ADAPTER, account: ACCOUNT }, NOW + 1,
  );
  assert.equal(kvPeek(autofetch.queueKey(searchKey)), null, 'chave foi embora');
});

test('blacklist de mortos: mesmo escopo adapter:conta nos dois lados', () => {
  try {
    autofetch.blacklist(ADAPTER, ACCOUNT, H1, 3600);
    transport(autofetch.deadKey(ADAPTER, ACCOUNT, H1));
    assert.equal(core.autofetchV3IsDead(kv, ADAPTER, ACCOUNT, H1, NOW + 1), true, 'Node gravou, Rust lê');
    assert.equal(core.autofetchV3IsDead(kv, ADAPTER, 'outra-conta', H1, NOW + 1), false, 'escopo é por conta');
    assert.equal(core.autofetchV3IsDead(kv, 'torbox', ACCOUNT, H1, NOW + 1), false, 'escopo é por adapter');
    // Rust gravou, o valor é o `1` que o `isDead` do Node testa.
    core.autofetchV3MarkDead(kv, ADAPTER, ACCOUNT, H2, 3600, NOW);
    assert.equal(kvPeek(autofetch.deadKey(ADAPTER, ACCOUNT, H2)), 1);
  } finally {
    cache.forget(autofetch.deadKey(ADAPTER, ACCOUNT, H1));
  }
});

test('marker: as três formas do Node sobrevivem ao Rust', () => {
  // Forma meta completa: o `markerValue` REAL do recheck, lido pelo Rust
  // (`accepted` string = id da transferência).
  const meta = markerValue('tr-42', {
    pool: 'seeds',
    obra: 'digest-da-obra',
    acceptedAt: NOW,
    title: 'Filme 2024 1080p DUBLADO',
    br: true,
    dubbed: true,
  });
  const key1 = autofetch.markerKey(ADAPTER, ACCOUNT, H1);
  kv.setJson(key1, JSON.stringify(meta), 3600, NOW);
  const rustSeen = core.autofetchV3Marker(kv, ADAPTER, ACCOUNT, H1, NOW + 1);
  assert.deepEqual(JSON.parse(rustSeen!), meta, 'Rust lê a meta que o Node gravou');

  // Forma legado `1`: Rust grava, o truthiness do Node continua de pé.
  core.autofetchV3SetMarker(kv, ADAPTER, ACCOUNT, H2, '1', 3600, NOW);
  assert.ok(kvPeek(autofetch.markerKey(ADAPTER, ACCOUNT, H2)), 'legacy `1` é truthy');

  // Forget do evict funciona nos dois sentidos.
  assert.equal(core.autofetchV3ForgetMarker(kv, ADAPTER, ACCOUNT, H1), true);
  assert.equal(kvPeek(key1), null);
});
