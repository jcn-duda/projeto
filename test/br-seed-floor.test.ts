// Caso medido em produção (Event Horizon, tt0119081): a release GLOBAL
// "Event.Horizon.1997.1080p.BDRip.DUBLADO.PT.BR" entra com `_br`/`_dubbed`
// verdadeiros (looksPtBr + DUBLADO declarado) e `_seeders=0` — e o piso de
// seeders (MIN_SEEDERS default 1) a eliminava ANTES da checagem do debrid
// (cachedOnly/TorBox), de modo que uma fonte BR rara potencialmente cacheada
// nunca era medida nem ocupava a reserva.
//
// Contrato fixado aqui (o menor seguro): comprovadamente BR dublada sobrevive
// ao piso PARA ALCANÇAR debrid/reserva; o waiver não vale para Dual ambíguo,
// estrangeiro explícito, `_lied` nem global comum. E ele não cruza a fronteira
// do download: o waiver existe para chegar à CHECAGEM (cache dispensa swarm) e
// à reserva BR — baixar torrent sem enxame não termina, então o lote que
// escolhe imediato/fila recebe o waiver como FATO (`viable`) e o corta.
//
// Reescrito na leva de remoção do TS do Chupim (2026-10-28): `autofetch-runner`,
// `autofetch-candidates` e `autofetch-seeds-pool` saíram do disco. Sobrou a
// superfície local da MESMA régua — o oráculo do ranking (waiver + reserva BR,
// que chama o núcleo pelo napi) e `decideAutofetch` (`rust-autofetch.ts`), o
// único lugar do Node que ainda converte `_seedFloorWaived` em decisão.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { sortAndLimit, toStremioStream, limitReservingBr } from './helpers/pipeline-oracle/format.js';
import * as metrics from '../src/utils/metrics.js';
import { decideAutofetch } from '../src/utils/rust-autofetch.js';
import type { AutofetchCapture, AutofetchLiveSubset, AutofetchRawStream } from '../src/utils/rust-autofetch.js';
import type { RawItem, Stream } from '../types/domain.js';

// Título real medido em produção (tracker global, 0 seeders, cacheado no TorBox).
const TITULO_REAL = 'Event.Horizon.1997.1080p.BDRip.DUBLADO.PT.BR-XSTV';

type TestStream = Stream & { infoHash: string; name: string; title: string };
const globalStream = (item: RawItem): TestStream => toStremioStream(item) as TestStream;

const counter = (key: string) => metrics.snapshot().counters[key] || 0;
const deltaOf = (key: string) => {
  const before = counter(key);
  return () => counter(key) - before;
};

test('caso real: release global BR dublada com 0 seeders sobrevive ao piso e chega ao pool', () => {
  const rara = globalStream({
    title: TITULO_REAL,
    infoHash: 'a'.repeat(40),
    seeders: 0,
    tracker: 'The Pirate Bay',
    indexer: 'thepiratebay',
  });
  // A marcação que produção mediu: origem pelo título, áudio declarado (claim).
  assert.equal(rara._br, true, 'looksPtBr marca a origem pelo título');
  assert.equal(rara._dubClaim, true, 'DUBLADO é promessa de título');
  assert.equal(rara._dubbed, false, 'sem fileEvidence ainda não é prova');

  const dWaived = deltaOf('search.brDubbed.seedFloorWaived');
  const out = sortAndLimit([rara], { minSeeders: 1, maxResults: 10 });
  assert.equal(out.length, 1, '0 seeders não pode matar a BR com claim de dublado');
  assert.equal(out[0]._br, true);
  assert.equal(out[0]._dubClaim, true);
  assert.equal(out[0]._seedFloorWaived, true, 'o waiver viaja marcado para o enqueue');
  assert.ok(!('_seeders' in out[0]), 'internos seguem o contrato do pool');
  assert.equal(dWaived(), 1, 'o waiver fica mensurado em /metrics.json');

  // A prova é de origem/áudio, não de swarm: piso mais alto não muda o contrato.
  assert.equal(sortAndLimit([rara], { minSeeders: 5, maxResults: 10 }).length, 1);
});

test('controles negativos: global comum, Dual ambíguo, estrangeiro e `_lied` morrem no piso', () => {
  const minSeeders = 1;
  // Global comum (sem prova PT nenhuma): o piso segue valendo.
  const comum = globalStream({
    title: 'Event.Horizon.1997.1080p.BDRip-ALLiANCE',
    infoHash: 'b'.repeat(40),
    seeders: 0,
    indexer: 'thepiratebay',
  });
  assert.equal(comum._br, false);
  assert.equal(comum._dubbed, false);
  assert.equal(comum._dubClaim, false);
  assert.equal(sortAndLimit([comum], { minSeeders }).length, 0);

  // Dual ambíguo (sem PT ao lado): _br/_dubClaim não nascem (invariante 8.12).
  const dual = globalStream({
    title: 'Event.Horizon.1997.1080p.DUAL.BDRip',
    infoHash: 'c'.repeat(40),
    seeders: 0,
    indexer: 'thepiratebay',
  });
  assert.equal(dual._br, false);
  assert.equal(dual._dubbed, false);
  assert.equal(dual._dubClaim, false);
  assert.equal(sortAndLimit([dual], { minSeeders }).length, 0);

  // Estrangeiro explícito com sinal PT no título: TRUEFRENCH desmente o waiver.
  const frances = globalStream({
    title: 'Event.Horizon.1997.DUAL.1080p.TRUEFRENCH.Estreia',
    infoHash: 'd'.repeat(40),
    seeders: 0,
    indexer: 'thepiratebay',
  });
  assert.equal(frances._br, true, 'o sinal PT marca origem, mas...');
  assert.equal(frances._dubClaim, true);
  assert.equal(frances._dubbed, false);
  assert.equal(
    sortAndLimit([frances], { minSeeders }).length, 0,
    'áudio estrangeiro explícito não é comprovadamente BR dublada',
  );

  // Auditoria de áudio condenou o post (dublado mentiu): waiver não se aplica.
  const mentirosa = {
    ...globalStream({
      title: TITULO_REAL,
      infoHash: 'e'.repeat(40),
      seeders: 0,
      indexer: 'thepiratebay',
    }),
    _lied: true,
  };
  assert.equal(sortAndLimit([mentirosa], { minSeeders }).length, 0);
});

test('o waiver não promove: a rara perde o desempate de seeders no próprio balde', () => {
  const rara = globalStream({
    title: TITULO_REAL,
    infoHash: 'f'.repeat(40),
    seeders: 0,
    indexer: 'thepiratebay',
  });
  const popular = globalStream({
    title: 'Event.Horizon.1997.1080p.BluRay.x264-GRP',
    infoHash: '1'.repeat(40),
    seeders: 120,
    indexer: 'thepiratebay',
  });
  const out = sortAndLimit([rara, popular], { minSeeders: 1, maxResults: 10 });
  assert.deepEqual(
    out.map((s) => s.infoHash),
    [popular.infoHash, rara.infoHash],
    'sem preferDubbed, a rara sobrevive mas fica por último na mesma qualidade',
  );
});

test('a rara comprovada ocupa a reserva BR do corte final pós-debrid', () => {
  const rara = globalStream({
    title: TITULO_REAL,
    infoHash: '2'.repeat(40),
    seeders: 0,
    indexer: 'thepiratebay',
  });
  const g1 = globalStream({
    title: 'Event.Horizon.1997.720p.WEB-DL-GRP',
    infoHash: '3'.repeat(40),
    seeders: 80,
    indexer: 'thepiratebay',
  });
  const g2 = globalStream({
    title: 'Event.Horizon.1997.1080p.WEBRip-x264-GRP',
    infoHash: '4'.repeat(40),
    seeders: 60,
    indexer: 'therarbg',
  });
  const pool = sortAndLimit([g1, g2, rara], { minSeeders: 1, maxResults: 10 });
  const out = limitReservingBr(pool, { brReservedSlots: 1, maxResults: 2 });
  assert.ok(
    out.some((s) => s.infoHash === rara.infoHash),
    'a BR rara garante a vaga reservada mesmo com 0 seeders',
  );
  assert.ok(out.every((s) => !('_br' in s) && !('_seedFloorWaived' in s)), 'internos (inclusive a marca do waiver) saem antes do Stremio');
});

// ═══════════════════════════════════════════════════════════════════════════════
// O waiver NÃO cruza a fronteira do download — agora no lote nativo
// ═══════════════════════════════════════════════════════════════════════════════

/** Stream de download como o pós-pipeline o entrega: `_seeders` já saiu. */
function brDub(hash: string, waived: boolean): AutofetchRawStream {
  return {
    infoHash: hash,
    name: '1080p DUB BR · ThePirateBay',
    title: TITULO_REAL,
    _br: true,
    _dubbed: true,
    _quality: '1080p',
    _size: 2 * 1024 ** 3,
    ...(waived ? { _seedFloorWaived: true } : {}),
  };
}

/**
 * Fato medido pelo Node e entregue ao núcleo: o lote não vê a lista tocável nem
 * o estado da sonda, então o que ele decide é só a cascata br → any → seeds
 * sobre os fatos (`viable` = passou pelo piso, `seedsBlocked`).
 */
function capture(
  streams: AutofetchRawStream[],
  { live, ...over }: Omit<Partial<AutofetchCapture>, 'live'> & { live?: Partial<AutofetchLiveSubset> } = {},
): AutofetchCapture {
  return {
    streams,
    season: null,
    queueDepth: 2,
    live: {
      autoFetchMinSeeders: 1,
      autoFetchSeedsPtFirst: true,
      autoFetchMax: 2,
      autoFetchTopSeedsMax: 2,
      autoFetchRareMax: 0,
      autoFetchRareThreshold: 0,
      autoFetchRareMaxSeeders: 0,
      autoFetchAnyDubbed: false,
      autoFetchTopSeeds: true,
      ...(live || {}),
    },
    policy: { dubbedOnly: false, cachedOnly: true, maxSizeGb: 0, seedsMaxGb: 8, seedsMaxQuality: '1080p' },
    autoFetchBr: true,
    adapter: { cacheCheck: true },
    seedsBlocked: false,
    ...over,
  };
}

const hashes = (rows: Array<{ stream: AutofetchRawStream }>) =>
  rows.map((row) => String(row.stream.infoHash).toLowerCase());

test('o waiver não vira download: sobrevivente do piso não é imediato nem fila', () => {
  const WAIVED = '5'.repeat(40);
  const dCalls = deltaOf('rust.autofetch.calls');
  const waived = decideAutofetch(capture([brDub(WAIVED, true)]));
  assert.deepEqual(hashes(waived.immediate), [], 'waived não pode virar candidato de download');
  assert.deepEqual(hashes(waived.queue), [], 'nem entrar na fila persistente');
  assert.equal(dCalls(), 1, 'a decisão passou pelo lote nativo (não é asserção vazia)');

  // Prova NÃO-VÁCUA: o MESMO stream sem a marca passa e é escolhido no pool br.
  const elegivel = decideAutofetch(capture([brDub(WAIVED, false)]));
  assert.deepEqual(hashes(elegivel.immediate), [WAIVED], 'quem passou pelo piso segue elegível');
  assert.equal(elegivel.immediate[0].pool, 'br');
});

test('o waiver corta também o pool seeds quando o piso próprio é 0', () => {
  const WAIVED = '7'.repeat(40);
  // piso do pool seeds em 0: sem o corte por `viable`, o waived seria
  // RE-selecionado aqui (br e any o descartam, o seeds o pegaria).
  const waived = decideAutofetch(capture([brDub(WAIVED, true)], {
    live: { autoFetchMinSeeders: 0, autoFetchTopSeeds: true },
  }));
  assert.deepEqual(hashes(waived.immediate), [], 'waived não vira candidato nem pelo pool seeds');
  assert.deepEqual(hashes(waived.queue), []);

  // Controle positivo: o saudável (sem marca) sai pelo br mesmo com piso 0.
  const HEALTHY = '8'.repeat(40);
  const ok = decideAutofetch(capture([brDub(HEALTHY, false)], {
    live: { autoFetchMinSeeders: 0, autoFetchTopSeeds: true },
  }));
  assert.deepEqual(hashes(ok.immediate), [HEALTHY]);
  assert.equal(ok.immediate[0].pool, 'br');
});

test('último recurso: seeds abaixo do piso ainda aquecem quando br/any estão vazios', () => {
  // Caso The Locals (tt0387357): Jackett acha torrents com 👤 1, piso efetivo
  // do Chupim é 3 → pool seeds vazio → no-candidate → cachedOnly deixa a UI
  // vazia para sempre. O relaxo para 1 só dispara quando o piso normal falhou.
  // (O contador `autofetch.top-seeded-relaxed` morava no picker TS, que saiu
  // com a leva; o núcleo decide o mesmo relaxo e não conta métrica.)
  const obscure = {
    infoHash: '9'.repeat(40),
    name: 'The Locals 2003 720p WEB-DL 👤 1',
    title: 'The Locals 2003 720p WEB-DL',
    _quality: '720p',
    _seeders: 1,
    _size: 2 * 1024 ** 3,
  } as AutofetchRawStream;
  const relaxed = decideAutofetch(capture([obscure], {
    live: { autoFetchMinSeeders: 3, autoFetchTopSeeds: true },
  }));
  assert.deepEqual(hashes(relaxed.immediate), ['9'.repeat(40)], 'com 1 seeder e piso 3, o último recurso ainda escolhe');
  assert.equal(relaxed.immediate[0].pool, 'seeds');

  // Controle: título saudável (≥ piso) NÃO passa pelo relaxo — o piso normal basta.
  const healthy = {
    infoHash: 'a'.repeat(40),
    name: 'Popular Title 1080p WEB-DL 👤 12',
    title: 'Popular Title 1080p WEB-DL',
    _quality: '1080p',
    _seeders: 12,
    _size: 2 * 1024 ** 3,
  } as AutofetchRawStream;
  const ok = decideAutofetch(capture([healthy], {
    live: { autoFetchMinSeeders: 3, autoFetchTopSeeds: true },
  }));
  assert.deepEqual(hashes(ok.immediate), ['a'.repeat(40)]);
  assert.equal(ok.immediate[0].pool, 'seeds');
});
