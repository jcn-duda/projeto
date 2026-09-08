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
// do download: o enqueue do autofetch continua exigindo o piso, porque cache
// dispensa swarm e download não.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { sortAndLimit, toStremioStream, limitReservingBr } from '../src/utils/format.js';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import * as held from '../src/debrid/protected.js';
import * as autofetchLive from '../src/utils/autofetch-live.js';
import { accountScope } from '../src/utils/request-key.js';
import { autoFetchCandidates } from '../src/providers/autofetch-runner.js';
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
  // A marcação que produção mediu: origem pelo título, áudio declarado.
  assert.equal(rara._br, true, 'looksPtBr marca a origem pelo título');
  assert.equal(rara._dubbed, true, 'DUBLADO declara o áudio');

  const dWaived = deltaOf('search.brDubbed.seedFloorWaived');
  const out = sortAndLimit([rara], { minSeeders: 1, maxResults: 10 });
  assert.equal(out.length, 1, '0 seeders não pode matar a comprovada BR dublada');
  assert.equal(out[0]._br, true);
  assert.equal(out[0]._dubbed, true);
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
  assert.equal(sortAndLimit([comum], { minSeeders }).length, 0);

  // Dual ambíguo (sem PT ao lado): _br/_dubbed não nascem (invariante 8.12).
  const dual = globalStream({
    title: 'Event.Horizon.1997.1080p.DUAL.BDRip',
    infoHash: 'c'.repeat(40),
    seeders: 0,
    indexer: 'thepiratebay',
  });
  assert.equal(dual._br, false);
  assert.equal(dual._dubbed, false);
  assert.equal(sortAndLimit([dual], { minSeeders }).length, 0);

  // Estrangeiro explícito com sinal PT no título: TRUEFRENCH desmente o waiver.
  const frances = globalStream({
    title: 'Event.Horizon.1997.DUAL.1080p.TRUEFRENCH.Estreia',
    infoHash: 'd'.repeat(40),
    seeders: 0,
    indexer: 'thepiratebay',
  });
  assert.equal(frances._br, true, 'o sinal PT marca origem, mas...');
  assert.equal(frances._dubbed, true);
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

test('enqueue mantém o piso: sobrevivente do waiver não vira download; quem passou, vira', async () => {
  const API_KEY = 'chave-piso-seeders';
  const account = accountScope(API_KEY);
  const run = (fn: () => unknown) => runtime.run(
    {
      opts: {
        ...runtime.defaults(),
        debridService: 'premiumize',
        debridApiKey: API_KEY,
        autoFetchBr: true,
      },
      encoded: 'cfg',
    },
    fn,
  );
  // Mesma fábrica do pós-pipeline: `_seeders` já saiu no sortAndLimit e o
  // waiver chega MARCADO (`_seedFloorWaived`) — é a marca que o enqueue lê.
  const brDub = (h: string, waived: boolean) => ({
    infoHash: h,
    name: '1080p DUB BR · ThePirateBay',
    title: TITULO_REAL,
    _br: true,
    _dubbed: true,
    _quality: '1080p',
    ...(waived ? { _seedFloorWaived: true } : {}),
  });

  const dSkipped = deltaOf('autofetch.seed-floor-skipped');
  const morta = await run(() => autoFetchCandidates([brDub('5'.repeat(40), true) as any], {}));
  assert.deepEqual(morta, [], 'sobrevivente do waiver não pode virar candidato de download');
  assert.ok(dSkipped() >= 1, 'o corte do enqueue fica mensurado (cai no br e/ou any)');
  assert.equal(held.isHeld('5'.repeat(40), account), false, 'nenhum hold adquirido para download inútil');

  // Controle positivo: quem PASSOU pelo piso na listagem (sentinela 👤 1 de
  // fonte BR/inventário, sem marca de waiver) segue elegível para baixar.
  const viavel = '6'.repeat(40);
  const ok = (await run(() => autoFetchCandidates([brDub(viavel, false) as any], {}))) as Array<
    { stream: { infoHash?: string }; pool: string }
  >;
  assert.equal(ok.length, 1);
  assert.equal(ok[0].pool, 'br');
  assert.equal(String(ok[0].stream.infoHash).toLowerCase(), viavel);
  held.release(viavel, account);
});

test('enqueue corta o waiver TAMBÉM no pool seeds (autoFetchMinSeeders=0)', async () => {
  const API_KEY = 'chave-piso-seeds-2';
  const account = accountScope(API_KEY);
  const run = (fn: () => unknown) => runtime.run(
    {
      opts: {
        ...runtime.defaults(),
        debridService: 'premiumize',
        debridApiKey: API_KEY,
        autoFetchBr: true,
      },
      encoded: 'cfg',
    },
    fn,
  );
  autofetchLive.set({ autoFetchTopSeeds: true, autoFetchMinSeeders: 0 });
  try {
    const brDub = (h: string, waived: boolean) => ({
      infoHash: h,
      name: '1080p DUB BR · ThePirateBay',
      title: TITULO_REAL,
      _br: true,
      _dubbed: true,
      _quality: '1080p',
      ...(waived ? { _seedFloorWaived: true } : {}),
    });

    // Só a rara waived na busca: br e any a descartam (cada um conta o corte)
    // e o pool seeds a RE-seleciona porque o piso próprio está em 0 — sem o
    // filtro `isViableForEnqueue` no seeds, seria download; com ele, nada.
    const dSkipped = deltaOf('autofetch.seed-floor-skipped');
    const morta = await run(() => autoFetchCandidates([brDub('7'.repeat(40), true) as any], {}));
    assert.deepEqual(morta, [], 'waived não vira candidato nem pelo pool seeds com piso 0');
    assert.ok(dSkipped() >= 3, 'o corte conta em br, any E seeds (cada pool que o re-seleciona)');
    assert.equal(held.isHeld('7'.repeat(40), account), false, 'nenhum hold para download inútil');

    // Controle positivo: global saudável (sem waiver) sai pelo seeds com piso 0.
    const healthy = {
      infoHash: '8'.repeat(40),
      name: 'Event Horizon 1997 1080p WEB-DL 👤 12',
      title: 'Event Horizon 1997 1080p WEB-DL',
      _quality: '1080p',
    };
    const ok = (await run(() => autoFetchCandidates([healthy as any], {}))) as Array<
      { stream: { infoHash?: string }; pool: string }
    >;
    assert.equal(ok.length, 1, 'quem passou pelo piso segue elegível no seeds');
    assert.equal(ok[0].pool, 'seeds');
    assert.equal(String(ok[0].stream.infoHash).toLowerCase(), '8'.repeat(40));
    held.release('8'.repeat(40), account);
  } finally {
    autofetchLive.reset();
  }
});
