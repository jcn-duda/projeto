// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// reserva BR — brReservedSlots/brReservedPerQuality, vagas por faixa, pack
// dublado cobrindo faixa sem dublado próprio e cota por indexador furtando
// a reserva.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  selectQualityCandidates,
  limitReservingBr,
} from '../src/utils/format.js';
import type { Stream } from '../types/domain.js';

// `limitReservingBr` declara `Stream[]`, mas os lotes de cota aqui são minimais
// (sem url/infoHash/externalUrl — só os campos que a cota lê).
const quotaStreams = (streams: unknown[]): Stream[] => streams as Stream[];

test('cota por indexador não consome as vagas reservadas BR', () => {
  const streams = [
    { id: 'br-1', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-2', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-3', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'yts-1', _quality: '1080p', _br: false, _indexer: 'yts' },
    { id: 'yts-2', _quality: '1080p', _br: false, _indexer: 'yts' },
    { id: 'yts-3', _quality: '1080p', _br: false, _indexer: 'yts' },
  ];
  // Cota 1, mas 2 vagas reservadas: o BluDV entrega 2 dublados mesmo assim.
  const out = limitReservingBr(quotaStreams(streams), { brReservedSlots: 2, maxResults: 10, maxPerIndexer: 1 });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['br-1', 'br-2', 'yts-1']);
});

test('reserva BR não conta _lied: mentiroso não come vaga dos honestos', () => {
  // Globais na frente lotam maxResults; sem excluir _lied, o mentiroso toma
  // uma das 2 vagas e um honesto some. Com o filtro, os dois honestos entram.
  const streams = [
    { id: 'global-a', _quality: '1080p', _br: false, _seeders: 100 },
    { id: 'global-b', _quality: '1080p', _br: false, _seeders: 90 },
    { id: 'global-c', _quality: '1080p', _br: false, _seeders: 80 },
    { id: 'br-lied', _quality: '1080p', _br: true, _dubbed: true, _lied: true },
    { id: 'br-honest-1', _quality: '1080p', _br: true, _dubbed: true },
    { id: 'br-honest-2', _quality: '1080p', _br: true, _dubbed: true },
  ];
  const out = limitReservingBr(quotaStreams(streams), {
    brReservedSlots: 2,
    brFirst: false,
    maxResults: 3,
  });
  const ids = out.map((s: any) => (s as any).id);
  assert.ok(ids.includes('br-honest-1'), 'honesto 1 precisa da vaga reservada');
  assert.ok(ids.includes('br-honest-2'), 'honesto 2 precisa da vaga reservada');
  assert.equal(ids.includes('br-lied'), false, 'mentiroso não come vaga BR');
});

test('cota por indexador limita o BR que passa da reserva', () => {
  const streams = [
    { id: 'br-1', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-2', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-3', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'yts-1', _quality: '1080p', _br: false, _indexer: 'yts' },
  ];
  // Sem reserva, o teto vale para todo mundo: o BluDV para no limite de 2.
  const out = limitReservingBr(quotaStreams(streams), { brReservedSlots: 0, maxResults: 10, maxPerIndexer: 2 });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['br-1', 'br-2', 'yts-1']);
});

test('limitReservingBr coloca todas as fontes BR primeiro quando solicitado', () => {
  const streams = [
    { id: 'global-4k', _quality: '2160p', _br: false },
    { id: 'br-1080-a', _quality: '1080p', _br: true },
    { id: 'global-1080', _quality: '1080p', _br: false },
    { id: 'br-720', _quality: '720p', _br: true },
  ];
  const out = limitReservingBr(quotaStreams(streams), {
    brReservedSlots: 0,
    brFirst: true,
    maxResults: 4,
  });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['br-1080-a', 'br-720', 'global-4k', 'global-1080']);
});

test('limitReservingBr mantém ordem natural sem prioridade e ainda garante BR', () => {
  const streams = [
    { id: 'global-4k', _quality: '2160p', _br: false },
    { id: 'global-1080-a', _quality: '1080p', _br: false },
    { id: 'global-1080-b', _quality: '1080p', _br: false },
    { id: 'br-720', _quality: '720p', _br: true },
  ];
  const out = limitReservingBr(quotaStreams(streams), {
    brReservedSlots: 1,
    brFirst: false,
    maxResults: 3,
  });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['global-4k', 'global-1080-a', 'br-720']);
});

// --- Causa B: reserva BR por faixa de qualidade ---------------------------
//
// Cenário medido no Fallout: 1080p BR abundante consumia a reserva global e a
// única BR de outra faixa ficava fora — a faixa ficava sem BR mesmo existindo
// fonte. A garantia por faixa entrega BR em cada balde que tem candidato.

test('reserva por faixa: 1080p BR abundante não come a vaga da BR 4K', () => {
  const globals = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((letra) => ({
    id: `global-${letra}`,
    _quality: '1080p',
    _br: false,
    _seeders: 100,
  }));
  const streams = [
    ...globals,
    { id: 'br-1080-a', _quality: '1080p', _br: true, _dubbed: true },
    { id: 'br-1080-b', _quality: '1080p', _br: true, _dubbed: true },
    { id: 'br-4k', _quality: '2160p', _br: true, _dubbed: true },
  ];
  // Lista cheia de globais bem semeados: sem garantia por faixa, as duas vagas
  // da reserva iam para os 1080p e o BR 4K nunca entrava.
  const comFaixa = limitReservingBr(quotaStreams([...streams]), {
    brReservedSlots: 2,
    brFirst: false,
    maxResults: 10,
    brReservedPerQuality: 1,
  });
  const ids = comFaixa.map((s: any) => (s as any).id);
  assert.ok(ids.includes('br-4k'), 'BR 4K precisa entrar pela reserva de faixa');
  assert.ok(ids.includes('br-1080-a'));
  assert.equal(comFaixa.length, 10);

  // 0 restaura o comportamento atual: só a reserva global clássica.
  const semFaixa = limitReservingBr(quotaStreams([...streams]), {
    brReservedSlots: 2,
    brFirst: false,
    maxResults: 10,
    brReservedPerQuality: 0,
  });
  assert.equal(semFaixa.some((s: any) => (s as any).id === 'br-4k'), false);
});

test('reserva por faixa também protege o pool pré-debrid', () => {
  // O corte pré-debrid é o que decide se o BR chega ao corte final; sem o
  // mesmo cuidado aqui, a garantia do final nunca veria o candidato.
  const streams = [
    { id: 'global-a', _quality: '2160p', _br: false, _seeders: 50 },
    { id: 'global-b', _quality: '1080p', _br: false, _seeders: 40 },
    { id: 'global-c', _quality: '720p', _br: false, _seeders: 30 },
    { id: 'br-1080-a', _quality: '1080p', _br: true, _dubbed: true },
    { id: 'br-1080-b', _quality: '1080p', _br: true, _dubbed: true },
    { id: 'br-720', _quality: '720p', _br: true, _dubbed: true },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 3,
    qualityLimits: { '2160p': 1, '1080p': 1, '720p': 1 },
    brReservedSlots: 2,
    brReservedPerQuality: 1,
    brFirst: false,
  });
  const ids = out.map((s: any) => (s as any).id);
  assert.ok(ids.includes('br-720'), 'BR 720p não pode ser cortada antes do corte final');
  assert.ok(ids.some((id: string) => id.startsWith('br-1080')));
});

test('faixa sem candidato BR não ganha vaga fantasma na reserva por faixa', () => {
  const streams = [
    { id: 'global-a', _quality: '2160p', _br: false, _seeders: 50 },
    { id: 'br-1080', _quality: '1080p', _br: true, _dubbed: true },
  ];
  const out = limitReservingBr(quotaStreams([...streams]), {
    brReservedSlots: 2,
    brFirst: false,
    maxResults: 10,
    brReservedPerQuality: 1,
  });
  assert.deepEqual(out.map((s: any) => (s as any).id), ['global-a', 'br-1080']);
});

// --- Causa D: pack dublado cobre faixa sem dublado próprio ----------------
//
// Fallout real: o dublado da temporada só existe como pack 1080p; 720p e 4K
// têm só legendado. O áudio PT existe dentro do pack e o pickFile extrai o
// episódio — então o pack preenche a vaga BR da faixa que ficou devendo,
// sem deslocar dublado próprio de faixa nenhuma.

const globaisLotando = (quantidade: number) =>
  Array.from({ length: quantidade }, (_, indice) => ({
    id: `global-${indice}`,
    _quality: '1080p',
    _br: false,
    _seeders: 100,
  }));

test('pack dublado da temporada cobre a vaga da faixa sem dublado próprio', () => {
  const streams = [
    ...globaisLotando(10),
    {
      id: 'br-pack-1080',
      _quality: '1080p',
      _br: true,
      _dubbed: true,
      title: 'Fallout 1ª Temporada Completa DUBLADA Dual 1080p WEB-DL',
    },
    {
      id: 'br-ep-720',
      _quality: '720p',
      _br: true,
      _dubbed: true,
      title: 'Fallout S01E02 DUBLADO 720p',
    },
  ];
  const out = limitReservingBr(quotaStreams([...streams]), {
    brReservedSlots: 2,
    brFirst: false,
    maxResults: 10,
    brReservedPerQuality: 1,
    season: 1,
  });
  const ids = out.map((s: any) => (s as any).id);
  // O episódio 720p entra pela faixa própria; o pack cobre a faixa 1080p,
  // que não tem dublado solto na fonte.
  assert.ok(ids.includes('br-ep-720'), 'dublado próprio da faixa entra primeiro');
  assert.ok(ids.includes('br-pack-1080'), 'pack cobre a faixa sem dublado próprio');
});

test('faixa com dublado próprio não é ocupada pelo pack', () => {
  const streams = [
    ...globaisLotando(10),
    {
      id: 'br-ep-1080',
      _quality: '1080p',
      _br: true,
      _dubbed: true,
      title: 'Fallout S01E03 DUBLADO 1080p',
    },
    {
      id: 'br-pack-1080',
      _quality: '1080p',
      _br: true,
      _dubbed: true,
      title: 'Fallout 1ª Temporada Completa DUBLADA Dual 1080p WEB-DL',
    },
  ];
  const out = limitReservingBr(quotaStreams([...streams]), {
    brReservedSlots: 1,
    brFirst: false,
    maxResults: 10,
    brReservedPerQuality: 1,
    season: 1,
  });
  const ids = out.map((s: any) => (s as any).id);
  assert.ok(ids.includes('br-ep-1080'));
  // A lista está cheia de globais e a única vaga da reserva vai para o
  // dublado próprio: o pack não disputa a faixa com ele.
  assert.equal(ids.includes('br-pack-1080'), false);
});

test('o mesmo pack nunca ocupa duas vagas de faixa', () => {
  const streams = [
    ...globaisLotando(10),
    {
      id: 'br-pack-1080',
      _quality: '1080p',
      _br: true,
      _dubbed: true,
      title: 'Fallout 1ª Temporada Completa DUBLADA Dual 1080p WEB-DL',
    },
  ];
  const out = limitReservingBr(quotaStreams([...streams]), {
    brReservedSlots: 3,
    brFirst: false,
    maxResults: 12,
    brReservedPerQuality: 1,
    season: 1,
  });
  const ids = out.map((s: any) => (s as any).id);
  assert.equal(ids.filter((id: string) => id === 'br-pack-1080').length, 1);
});

// --- tt1411697 medido: a irmã "Dual Áudio" 1080p e a "Dublado" 720p --------
//
// Pack real da conta: "Trilogia - Se Beber, Não Case! (2009-2013) 5.1 BluRay
// Dual Áudio 1080p By-LuaHarper" (a irmã 1080p, que escreve "Dual Áudio" em
// vez de "Dublado") e o pack 720p que escreve "Dublado". O sintoma histórico
// era a 1080p sumir do corte quando o _br dela se perdia, enquanto a 720p
// sobrevivia — o looksPtBr aceitando "Dual" + sinais PT consertou o
// classificador; esta guarda trava a SOBREVIVÊNCIA no corte final, com
// globais de swarm alto no MESMO balde 1080p (o que expulsava a irmã).

test('tt1411697: irmã 1080p "Dual Áudio" e irmã 720p "Dublado" sobrevivem ao corte', () => {
  const streams = [
    {
      id: 'pack-1080-dual',
      _quality: '1080p',
      _br: true,
      _dubbed: true,
      title: 'Trilogia - Se Beber, Não Case! (2009-2013) 5.1 BluRay Dual Áudio 1080p By-LuaHarper',
    },
    {
      id: 'pack-720-dub',
      _quality: '720p',
      _br: true,
      _dubbed: true,
      title: 'Trilogia Se Beber Não Case (2009 - 2011 - 2013) Bluray 720p Dublado',
    },
    // globais de swarm alto no MESMO balde da irmã: é o que a expulsa quando
    // o _br se perde (produção mediu 720 presente / 1080 ausente).
    { id: 'global-1080-a', _quality: '1080p', _br: false, _seeders: 150 },
    { id: 'global-1080-b', _quality: '1080p', _br: false, _seeders: 120 },
    { id: 'global-720', _quality: '720p', _br: false, _seeders: 140 },
  ];
  const out = limitReservingBr(quotaStreams(streams), {
    brReservedSlots: 2,
    brReservedPerQuality: 1,
    maxResults: 4,
    brFirst: true,
  });
  const ids = out.map((s: any) => (s as any).id);
  assert.ok(ids.includes('pack-1080-dual'), 'irmã 1080p "Dual Áudio" não pode sumir');
  assert.ok(ids.includes('pack-720-dub'), 'irmã 720p "Dublado" segue entrando');
});

