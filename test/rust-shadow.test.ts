import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProbes, tsVerdict, compareBatch, observe } from '../src/utils/rust-shadow.js';
import type { ReleaseProbe, ReleaseVerdict } from '../src/utils/rust-shadow.js';
import type { RawItem } from '../types/domain.js';

// Testes do shadow do núcleo Rust: montagem das sondas, veredito TS e comparação.
// Medem só o lado TS e a lógica de diff; o `.node` não é carregado aqui.

function probe(over: Partial<ReleaseProbe> = {}): ReleaseProbe {
  return {
    title: 'Breaking Bad S02E03 1080p',
    magnet: '',
    link: '',
    name: '',
    year: '',
    isSeries: true,
    allNames: [],
    cutTail: false,
    ...over,
  };
}

function verdict(over: Partial<ReleaseVerdict> = {}): ReleaseVerdict {
  return {
    normalized: 'breaking bad',
    hasPtSigns: false,
    brOriginMark: false,
    infoHash: null,
    displayName: '',
    seasons: [2],
    episodes: [3],
    complete: false,
    seasonPack: false,
    matchesBrTitle: false,
    safeLink: false,
    ...over,
  };
}

test('buildProbes mapeia campos, usa alternativas Title/MagnetUri e corta em max', () => {
  const items = [
    { title: 'Filme A 2020', magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), Guid: 'https://ex.com/a' },
    { Title: 'Filme B 2021', MagnetUri: 'magnet:?xt=urn:btih:' + 'b'.repeat(40), Guid: 'http://ex.com/b' },
    { title: 'Filme C', Guid: 'magnet:?xt=urn:btih:cccc' },
    { title: 'Filme D' },
  ] as unknown as RawItem[];

  const probes = buildProbes(items, { names: ['Nome Um', 'Nome Dois'], year: 2020, isSeries: false }, 10);
  assert.equal(probes.length, 4);

  assert.equal(probes[0].title, 'Filme A 2020');
  assert.equal(probes[0].magnet, 'magnet:?xt=urn:btih:' + 'a'.repeat(40));
  assert.equal(probes[0].link, 'https://ex.com/a');
  assert.equal(probes[0].name, 'Nome Um');
  assert.equal(probes[0].year, '2020');
  assert.equal(probes[0].isSeries, false);

  // Alternativas Title/MagnetUri são lidas quando os campos minúsculos faltam.
  assert.equal(probes[1].title, 'Filme B 2021');
  assert.equal(probes[1].magnet, 'magnet:?xt=urn:btih:' + 'b'.repeat(40));
  assert.equal(probes[1].link, 'http://ex.com/b');

  // Guid que não é http(s) não vira link.
  assert.equal(probes[2].link, '');
  assert.equal(probes[2].magnet, '');

  // Ausências viram string vazia, nunca undefined.
  assert.equal(probes[3].title, 'Filme D');
  assert.equal(probes[3].link, '');
  assert.equal(probes[3].magnet, '');
});

test('buildProbes: year null/undefined vira vazio e year number vira string', () => {
  const item = [{ title: 'X' }] as unknown as RawItem[];
  assert.equal(buildProbes(item, { names: [], year: null, isSeries: true }, 5)[0].year, '');
  assert.equal(buildProbes(item, { names: [], year: undefined, isSeries: true }, 5)[0].year, '');
  assert.equal(buildProbes(item, { names: [], year: 1999, isSeries: true }, 5)[0].year, '1999');
  assert.equal(buildProbes(item, { names: [], year: '2001', isSeries: true }, 5)[0].year, '2001');
});

test('buildProbes: name vazio quando não há nomes; corta a lista em max', () => {
  const items = [{ title: 'A' }, { title: 'B' }, { title: 'C' }] as unknown as RawItem[];
  const probes = buildProbes(items, { names: [], year: null, isSeries: false }, 2);
  assert.equal(probes.length, 2);
  assert.equal(probes[0].name, '');
  assert.equal(probes[1].title, 'B');
});

test('tsVerdict: extrai temporada e episódio do título', () => {
  const v = tsVerdict(probe({ title: 'Breaking Bad S02E03 1080p' }));
  assert.deepEqual(v.seasons, [2]);
  assert.deepEqual(v.episodes, [3]);
});

test('tsVerdict: infoHash minúsculo a partir de magnet com btih de 40 hex', () => {
  const hex = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  const v = tsVerdict(probe({ magnet: `magnet:?xt=urn:btih:${hex}&dn=Algo` }));
  assert.equal(v.infoHash, hex.toLowerCase());
});

test('tsVerdict: safeLink recusa host privado e aceita https público', () => {
  assert.equal(tsVerdict(probe({ link: 'http://127.0.0.1/x' })).safeLink, false);
  assert.equal(tsVerdict(probe({ link: 'https://example.com/x' })).safeLink, true);
});

test('tsVerdict: sem nome da obra, matchesBrTitle é false', () => {
  assert.equal(tsVerdict(probe({ name: '' })).matchesBrTitle, false);
});

test('compareBatch: listas iguais não geram diferenças', () => {
  const probes = [probe(), probe({ title: 'Outro S01E01' })];
  const ts = [verdict(), verdict({ seasons: [1], episodes: [1] })];
  const rust = [verdict(), verdict({ seasons: [1], episodes: [1] })];
  const diffs = compareBatch(probes, ts, rust);
  assert.equal(diffs.length, 0);
});

test('compareBatch: infoHash null (TS) e ausente (napi Option::None) são a mesma ausência', () => {
  const probes = [probe({ magnet: '' })];
  const ts = [verdict({ infoHash: null })];
  const rust = [{ ...verdict(), infoHash: undefined } as unknown as ReturnType<typeof verdict>];
  assert.equal(compareBatch(probes, ts, rust).length, 0);
});

test('compareBatch: um campo diferente gera uma divergência com field e index', () => {
  const probes = [probe(), probe({ title: 'Segundo' })];
  const ts = [verdict(), verdict({ brOriginMark: false })];
  const rust = [verdict(), verdict({ brOriginMark: true })];
  const diffs = compareBatch(probes, ts, rust);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, 'brOriginMark');
  assert.equal(diffs[0].index, 1);
  assert.equal(diffs[0].title, 'Segundo');
  assert.equal(diffs[0].ts, false);
  assert.equal(diffs[0].rust, true);
});

test('compareBatch: tamanhos diferentes geram __length__', () => {
  const probes = [probe(), probe()];
  const ts = [verdict(), verdict()];
  const rust = [verdict()];
  const diffs = compareBatch(probes, ts, rust);
  assert.ok(diffs.some((d) => d.field === '__length__'));
});

test('observe sem núcleo carregado não lança', () => {
  const items = [{ title: 'Filme' }] as unknown as RawItem[];
  assert.doesNotThrow(() => observe(items, { names: [], year: null, isSeries: false }));
});
