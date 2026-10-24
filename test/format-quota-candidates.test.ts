// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// cotas — limitByQuality, selectQualityCandidates (pool ampliado, BR dentro
// de qualidade limitada, brFirst), limitReservingBr com brFirst/brReserved e
// limitByIndexer com overrides individuais.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  limitByQuality,
  selectQualityCandidates,
  limitReservingBr,
  limitByIndexer,
} from '../src/utils/format.js';
import type { Stream } from '../types/domain.js';

// `limitReservingBr` declara `Stream[]`, mas os lotes de cota aqui são minimais
// (sem url/infoHash/externalUrl — só os campos que a cota lê).
const quotaStreams = (streams: unknown[]): Stream[] => streams as Stream[];

test('limitByQuality aplica cotas por qualidade após o debrid sem reordenar', () => {
  const streams = [
    { id: '4k-a', _quality: '2160p' },
    { id: '4k-b', _quality: '2160p' },
    { id: '1080-a', _quality: '1080p' },
    { id: '1080-b', _quality: '1080p' },
    { id: '720-a', _quality: '720p' },
    { id: 'sd-a', _quality: 'SD' },
  ];
  const out = limitByQuality(streams, {
    '2160p': 1, '1080p': 2, '720p': 0, '480p': 100, SD: 1,
  });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['4k-a', '1080-a', '1080-b', 'sd-a']);
});

test('selectQualityCandidates reserva candidatos para cada cota configurada', () => {
  const streams = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `4k-${i}`, _quality: '2160p' })),
    { id: '1080-a', _quality: '1080p' },
    { id: '1080-b', _quality: '1080p' },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 4,
    qualityLimits: { '2160p': 2, '1080p': 2 },
  });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['4k-0', '4k-1', '1080-a', '1080-b']);
});

test('selectQualityCandidates não envia excedentes de qualidade limitada ao debrid', () => {
  const streams = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `4k-${i}`, _quality: '2160p' })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `1080-${i}`, _quality: '1080p' })),
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 40,
    qualityLimits: { '2160p': 2, '1080p': 3, '720p': 0, '480p': 0, SD: 0 },
    candidateFactor: 4,
  });
  assert.equal(out.length, 20);
  assert.equal(out.filter((s) => s._quality === '2160p').length, 8);
  assert.equal(out.filter((s) => s._quality === '1080p').length, 12);
});

test('selectQualityCandidates mantém pool ampliado nas qualidades ilimitadas', () => {
  const streams = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `4k-${i}`, _quality: '2160p' })),
    ...Array.from({ length: 180 }, (_, i) => ({ id: `1080-${i}`, _quality: '1080p' })),
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 160,
    qualityLimits: { '2160p': 2, '1080p': 100, '720p': 100, '480p': 100, SD: 100 },
    candidateFactor: 4,
  });
  assert.equal(out.length, 160);
  assert.equal(out.filter((s) => s._quality === '2160p').length, 8);
});

test('selectQualityCandidates preserva BR dentro de qualidade limitada', () => {
  const streams = [
    { id: 'global-a', _quality: '1080p', _br: false },
    { id: 'global-b', _quality: '1080p', _br: false },
    { id: 'br-a', _quality: '1080p', _br: true },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 2,
    qualityLimits: { '1080p': 2 },
    brReservedSlots: 1,
  });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['global-a', 'br-a']);
});

test('selectQualityCandidates: _lied não come vaga BR no pool pré-debrid', () => {
  const streams = [
    { id: 'br-lied', _quality: '1080p', _br: true, _dubbed: true, _lied: true },
    { id: 'br-honest-1', _quality: '1080p', _br: true, _dubbed: true },
    { id: 'br-honest-2', _quality: '1080p', _br: true, _dubbed: true },
    { id: 'global-a', _quality: '1080p', _br: false },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 2,
    qualityLimits: { '1080p': 2 },
    brReservedSlots: 2,
    brFirst: false,
  });
  const ids = out.map((s: any) => (s as any).id);
  assert.ok(ids.includes('br-honest-1'));
  assert.ok(ids.includes('br-honest-2'));
  assert.equal(ids.includes('br-lied'), false);
});

test('selectQualityCandidates preserva BR em qualidade ilimitada', () => {
  const streams = [
    ...Array.from({ length: 200 }, (_, i) => ({ id: `global-${i}`, _quality: '1080p', _br: false })),
    { id: 'br-a', _quality: '1080p', _br: true },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 160,
    qualityLimits: { '2160p': 100, '1080p': 100, '720p': 100, '480p': 100, SD: 100 },
    brReservedSlots: 1,
  });
  assert.equal(out.length, 160);
  assert.ok(out.some((s: any) => (s as any).id === 'br-a'));
});

test('limitReservingBr combina reserva, cotas e máximo sem vazar internos', () => {
  const streams = [
    { id: 'global-4k', _quality: '2160p', _br: false, _seeders: 100, _tracker: 'HDRTorrent', _multiWork: true, _size: 40 * 1024 ** 3 },
    { id: 'br-1080-a', _quality: '1080p', _br: true, _seeders: 1 },
    { id: 'br-1080-b', _quality: '1080p', _br: true, _seeders: 1 },
    { id: 'global-1080', _quality: '1080p', _br: false, _seeders: 50 },
  ];
  const out = limitReservingBr(quotaStreams(streams), {
    brReservedSlots: 2,
    maxResults: 3,
    qualityLimits: { '2160p': 1, '1080p': 1 },
  });
  // brReservedSlots: 2 significa DUAS vagas BR, e elas não são mais cortadas
  // pela cota de 1080p (que é 1). Antes só uma BR passava e a "reserva de 2"
  // não valia nada. O maxResults (3) segue sendo o teto de verdade.
  assert.deepEqual(out.map((s: any) => (s as any).id), ['br-1080-a', 'br-1080-b', 'global-4k']);
  assert.ok(out.every((s) => Object.keys(s).every((key) => !key.startsWith('_'))));
  assert.ok(out.every((s) => !('_indexer' in s)));
});

test('limitByIndexer aplica teto por fonte e trata 0 como sem limite', () => {
  const streams = [
    { id: 'yts-1', _indexer: 'yts' },
    { id: 'yts-2', _indexer: 'yts' },
    { id: 'yts-3', _indexer: 'yts' },
    { id: 'rarbg-1', _indexer: 'therarbg' },
    { id: 'sem-fonte', _indexer: '' },
  ];
  assert.deepEqual(
    limitByIndexer(streams, 2).map((s: any) => (s as any).id),
    ['yts-1', 'yts-2', 'rarbg-1', 'sem-fonte'],
  );
  // Ao contrário das cotas por qualidade, 0 aqui é "desligado", não "nenhum".
  assert.equal(limitByIndexer(streams, 0).length, 5);
  // Indexador desconhecido não vira um balde comum entre streams sem metadado.
  assert.equal(limitByIndexer([...streams, { id: 'outro', _indexer: '' }], 1).length, 4);
  // Maiúsculas/minúsculas são a mesma fonte.
  assert.equal(limitByIndexer([{ _indexer: 'YTS' }, { _indexer: 'yts' }], 1).length, 1);
});

test('cota de qualidade não come a fonte BR antes da reserva agir', () => {
  // Config real de usuário: max1080p=3. As fontes BR publicam seeders=1, então
  // chegam no fim do balde de 1080p — a cota levava as três globais mais
  // semeadas e cortava a BR ANTES de brFirst/brReservedSlots existirem.
  const streams = [
    { id: 'global-a', _quality: '1080p', _br: false, _seeders: 209 },
    { id: 'global-b', _quality: '1080p', _br: false, _seeders: 159 },
    { id: 'global-c', _quality: '1080p', _br: false, _seeders: 125 },
    { id: 'global-d', _quality: '1080p', _br: false, _seeders: 30 },
    { id: 'br-1080', _quality: '1080p', _br: true, _seeders: 1 },
  ];
  const limits = { '2160p': 3, '1080p': 3, '720p': 3, '480p': 3 };

  const first = limitReservingBr(quotaStreams([...streams]), {
    brFirst: true,
    brReservedSlots: 6,
    maxResults: 40,
    qualityLimits: limits,
  });
  // A vaga reservada não consome a cota: a BR entra E as três globais mantêm as
  // três vagas do balde. Antes a BR ocupava uma delas e a global-c sumia.
  assert.deepEqual(first.map((s: any) => (s as any).id), ['br-1080', 'global-a', 'global-b', 'global-c']);

  // Sem prioridade visual a BR mantém a posição natural e entra ALÉM da cota:
  // as três globais mais semeadas continuam lá, a BR vem depois delas.
  const natural = limitReservingBr(quotaStreams([...streams]), {
    brFirst: false,
    brReservedSlots: 6,
    maxResults: 40,
    qualityLimits: limits,
  });
  assert.deepEqual(natural.map((s: any) => (s as any).id), ['global-a', 'global-b', 'global-c', 'br-1080']);

  // Sem reserva pedida e sem prioridade, a cota volta a ser puro seeders.
  const semReserva = limitReservingBr(quotaStreams([...streams]), {
    brFirst: false,
    brReservedSlots: 0,
    maxResults: 40,
    qualityLimits: limits,
  });
  assert.deepEqual(semReserva.map((s: any) => (s as any).id), ['global-a', 'global-b', 'global-c']);
});

test('selectQualityCandidates preserva todos os BR candidatos quando brFirst está ativo', () => {
  const streams = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `global-${i}`, _quality: '1080p', _br: false })),
    { id: 'br-a', _quality: '1080p', _br: true },
    { id: 'br-b', _quality: '720p', _br: true },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 5,
    brReservedSlots: 0,
    brFirst: true,
  });
  assert.ok(out.some((s: any) => (s as any).id === 'br-a'));
  assert.ok(out.some((s: any) => (s as any).id === 'br-b'));
});

test('limitByIndexer usa o override individual quando a chave existe', () => {
  const streams = [
    { id: 'yts-1', _indexer: 'yts' },
    { id: 'yts-2', _indexer: 'yts' },
    { id: 'yts-3', _indexer: 'yts' },
    { id: 'rarbg-1', _indexer: 'rarbg' },
    { id: 'rarbg-2', _indexer: 'rarbg' },
  ];
  // Cota global 1: o override do yts amplia para 3 e o do rarbg mantém 1.
  const out = limitByIndexer(streams, 1, new Set(), { yts: 3, rarbg: 1 });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['yts-1', 'yts-2', 'yts-3', 'rarbg-1']);
});

test('limitByIndexer: override 0 é sem limite, não "nenhum"', () => {
  const streams = [
    { id: 'yts-1', _indexer: 'yts' },
    { id: 'yts-2', _indexer: 'yts' },
    { id: 'rarbg-1', _indexer: 'rarbg' },
  ];
  // Global 1; yts com override 0 fica sem teto; rarbg sem override cai no global.
  const out = limitByIndexer(streams, 1, new Set(), { yts: 0 });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['yts-1', 'yts-2', 'rarbg-1']);
});

test('limitByIndexer cai no teto global para indexador sem override', () => {
  const streams = [
    { id: 'yts-1', _indexer: 'yts' },
    { id: 'yts-2', _indexer: 'yts' },
    { id: 'rarbg-1', _indexer: 'rarbg' },
  ];
  // Só o rarbg tem override; o yts continua preso ao maxPerIndexer global.
  assert.deepEqual(
    limitByIndexer(streams, 1, new Set(), { rarbg: 5 }).map((s: any) => (s as any).id),
    ['yts-1', 'rarbg-1'],
  );
});

test('vaga reservada BR fura o teto individual do indexador', () => {
  const streams = [
    { id: 'br-1', _indexer: 'bludv', _br: true },
    { id: 'br-2', _indexer: 'bludv', _br: true },
    { id: 'br-3', _indexer: 'bludv', _br: true },
    { id: 'yts-1', _indexer: 'yts' },
  ];
  // Override 1 no bludv e reserva de 2: as duas primeiras BR furam a cota, a
  // terceira (fora da reserva) é barrada e ainda conta para a contagem.
  const exempt = new Set([streams[0], streams[1]]);
  const out = limitByIndexer(streams, 2, exempt, { bludv: 1, yts: 5 });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['br-1', 'br-2', 'yts-1']);
});

test('reserva BR fura a cota individual por indexador em limitReservingBr', () => {
  const streams = [
    { id: 'br-1', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-2', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-3', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'yts-1', _quality: '1080p', _br: false, _indexer: 'yts' },
  ];
  // Override 1 no bludv com 2 vagas reservadas: a reserva continua entregando
  // os dois dublados acima da cota individual.
  const out = limitReservingBr(quotaStreams(streams), {
    brReservedSlots: 2,
    maxResults: 10,
    maxPerIndexer: 1,
    indexerLimits: { bludv: 1 },
  });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['br-1', 'br-2', 'yts-1']);
});

test('cota individual rejeitada não consome vaga de qualidade', () => {
  const streams = [
    { id: 'yts-1', _quality: '1080p', _br: false, _indexer: 'yts' },
    { id: 'yts-2', _quality: '1080p', _br: false, _indexer: 'yts' },
    { id: 'rarbg-1', _quality: '1080p', _br: false, _indexer: 'rarbg' },
  ];
  const out = limitReservingBr(quotaStreams(streams), {
    brFirst: false,
    maxResults: 10,
    qualityLimits: { '1080p': 2 },
    indexerLimits: { yts: 1 },
  });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['yts-1', 'rarbg-1']);
});

