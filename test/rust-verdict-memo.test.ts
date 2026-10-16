// RUST_CORE=on: o lote Rust (`evaluateReleases`) decide os vereditos dos
// filtros. Núcleo stub com respostas OPOSTAS ao TS de propósito — se o valor
// do stub aparece, quem decidiu foi o Rust. Não carrega .node nem sobe o addon.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const rustCore = await import('../src/utils/rust-core.js');
const memo = await import('../src/utils/rust-verdict-memo.js');
const { primerFor, installBatchDecisions } = await import('../src/utils/rust-shadow.js');
const { hasPtSigns, brOriginMark } = await import('../src/utils/br-origin.js');
const { parseTitleSeasonEpisode } = await import('../src/utils/episode-matching.js');
const { matchesBrTitle } = await import('../src/utils/release-title-rules.js');
const { extractInfoHash, magnetDisplayName } = await import('../src/utils/title-normalization.js');
const { isSafeDownloadUrl } = await import('../src/utils/net-safety.js');
const { filterRelevantRaw } = await import('../src/utils/release-filters.js');
import type { ReleaseProbe, ReleaseVerdict } from '../src/utils/rust-shadow.js';

const savedMode = config.rustCore.mode;
const HASH = 'a'.repeat(40);
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Nome.Do.Torrent`;
const TITLE = 'Filme Teste (2020) 1080p DUBLADO';

function counter(name: string): number {
  return Number(metrics.snapshot().counters[name] || 0);
}

/** Veredito oposto ao que o TS daria para TITLE/MAGNET. */
function opposite(p: ReleaseProbe): ReleaseVerdict {
  return {
    normalized: p.title,
    hasPtSigns: false,
    brOriginMark: false,
    infoHash: 'b'.repeat(40),
    displayName: 'nome do rust',
    seasons: [7],
    episodes: [9],
    complete: false,
    seasonPack: true,
    matchesBrTitle: false,
    safeLink: false,
  };
}

function core(fn: (probes: ReleaseProbe[]) => ReleaseVerdict[]) {
  const calls: ReleaseProbe[][] = [];
  return {
    calls,
    evaluateReleases: (probes: ReleaseProbe[]) => {
      calls.push(probes);
      return fn(probes);
    },
  };
}

beforeEach(() => {
  metrics.reset();
  memo.installVerdictPrimer(null);
  rustCore.setCoreForTest(null);
  config.rustCore.mode = 'off';
});

after(() => {
  memo.installVerdictPrimer(null);
  rustCore.setCoreForTest(null);
  config.rustCore.mode = savedMode;
});

test('sem preparador: as funções de base seguem o TS', () => {
  memo.primeVerdicts([{ title: TITLE, magnet: MAGNET }], ['Filme Teste'], 2020, false);
  assert.equal(hasPtSigns('Operação Invasão'), true);
  assert.equal(extractInfoHash(MAGNET), HASH);
  assert.equal(memo.verdictMemoEnabled(), false);
});

test('on: depois do lote, as funções devolvem o veredito do Rust', () => {
  const c = core((probes) => probes.map(opposite));
  memo.installVerdictPrimer(primerFor(c));
  const guid = 'https://example.com/baixar/1';
  memo.primeVerdicts([{ title: TITLE, magnet: MAGNET, Guid: guid }], ['Filme Teste'], 2020, false);
  assert.equal(c.calls.length, 1);
  assert.equal(hasPtSigns(TITLE), false);
  assert.equal(brOriginMark(TITLE), false);
  assert.deepEqual(parseTitleSeasonEpisode(TITLE), { seasons: [7], episodes: [9], complete: false, seasonPack: true });
  assert.equal(extractInfoHash(MAGNET), 'b'.repeat(40));
  assert.equal(magnetDisplayName({ magnet: MAGNET }), 'nome do rust');
  assert.equal(isSafeDownloadUrl(guid), false);
  assert.equal(matchesBrTitle(TITLE, 'Filme Teste', 2020, { allNames: ['Filme Teste'] }), false);
  assert.ok(counter('rust.batch.hit') >= 7);
});

test('on: entrada fora do lote cai no TS (falta, nunca veredito de outra entrada)', () => {
  memo.installVerdictPrimer(primerFor(core((probes) => probes.map(opposite))));
  memo.primeVerdicts([{ title: TITLE, magnet: MAGNET }], ['Filme Teste'], 2020, false);
  assert.equal(hasPtSigns('Operação Invasão'), true);
  // Mesmo título com outra lista de nomes (aqui, nenhuma): chave diferente.
  assert.equal(matchesBrTitle(TITLE, 'Filme Teste', 2020), true);
  // allowPrivate não é medido pelo lote.
  assert.equal(isSafeDownloadUrl('http://127.0.0.1/x', true), true);
  assert.ok(counter('rust.batch.miss') >= 1);
});

test('on: a cópia de temporadas não deixa quem chama mutar a memória', () => {
  memo.installVerdictPrimer(primerFor(core((probes) => probes.map(opposite))));
  memo.primeVerdicts([{ title: TITLE }], ['Filme Teste'], 2020, false);
  parseTitleSeasonEpisode(TITLE).seasons.push(99);
  assert.deepEqual(parseTitleSeasonEpisode(TITLE).seasons, [7]);
});

test('on: lote já calculado não volta ao Rust; nome novo vai', () => {
  const c = core((probes) => probes.map(opposite));
  memo.installVerdictPrimer(primerFor(c));
  const br = { title: TITLE, isBr: true };
  memo.primeVerdicts([br], ['Filme Teste'], 2020, false);
  memo.primeVerdicts([br], ['Filme Teste'], 2020, false);
  assert.equal(c.calls.length, 1);
  memo.primeVerdicts([br], ['Filme Teste', 'Test Movie'], 2020, false);
  assert.equal(c.calls.length, 2);
  assert.equal(c.calls[1].length, 2, 'BR: um probe por nome');
});

test('on: item global vai uma vez só; repetido no lote também', () => {
  const c = core((probes) => probes.map(opposite));
  memo.installVerdictPrimer(primerFor(c));
  const global = { title: 'Some Movie 2020 1080p', magnet: MAGNET };
  memo.primeVerdicts([global, { ...global }, { title: TITLE, isBr: true }], ['Filme Teste', 'Test Movie'], 2020, false);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].length, 3, 'global 1× (dedupe) + BR 2× (um por nome)');
});

test('on: lote de tamanho errado é erro, nada é gravado', () => {
  memo.installVerdictPrimer(primerFor(core(() => [])));
  memo.primeVerdicts([{ title: TITLE }], ['Filme Teste'], 2020, false);
  assert.equal(counter('rust.batch.error'), 1);
  assert.equal(hasPtSigns(TITLE), true);
});

test('filtro: o corte inteiro vai ao núcleo (só índices voltam)', () => {
  const item = { title: TITLE, isBr: true };
  const calls: unknown[][] = [];
  // Stub com resposta oposta ao TS: se o veredito do stub aparece, quem
  // decidiu foi o núcleo — o filtro não recalcula nada no TS.
  rustCore.setCoreForTest({
    normalizeTitle: (t: string) => t,
    filterRelevantRawNapi: (items: unknown[]) => {
      calls.push(items);
      return { kept: [], rejected: [{ index: 0, reason: 0 }] };
    },
  });
  const rejeitados: string[] = [];
  const out = filterRelevantRaw([item], { names: ['Filme Teste'], year: 2020 }, (_i, r) => rejeitados.push(r));
  assert.equal(out.length, 0, 'Rust recusa');
  assert.deepEqual(rejeitados, ['title']);
  assert.equal(calls.length, 1, 'uma chamada por lote');
  assert.equal((calls[0] as unknown[]).length, 1);
});

test('installBatchDecisions: só liga com RUST_CORE=on e núcleo com evaluateReleases', () => {
  const c = core((probes) => probes.map(opposite));
  rustCore.setCoreForTest({ normalizeTitle: (t: string) => t, evaluateReleases: c.evaluateReleases });
  config.rustCore.mode = 'shadow';
  installBatchDecisions();
  assert.equal(memo.verdictMemoEnabled(), false);
  config.rustCore.mode = 'on';
  installBatchDecisions();
  assert.equal(memo.verdictMemoEnabled(), true);
  rustCore.setCoreForTest({ normalizeTitle: (t: string) => t });
  installBatchDecisions();
  assert.equal(memo.verdictMemoEnabled(), false, 'binário antigo = TS');
});
