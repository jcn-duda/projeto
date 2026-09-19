// Varredura pt-BR: o terceiro desfecho. Achar releases e não conseguir usar
// NENHUM é diagnóstico oposto de não achar nada — o primeiro aponta para
// `JACKETT_RESOLVE_DOWNLOAD_INDEXERS`, o segundo para query/indexer. Antes
// disso os dois saíam pela mesma linha ("nenhum novo") e pela mesma métrica.
//
// Medido em produção no tt0415167 ("Mortuária", 2005): os dois dublados de 288
// e 580 seeds vinham do magnetdownload com `infoHash: null` e `magnet` igual à
// URL da PÁGINA, porque aquele indexer faltava na lista de resolução do .env.
// O log dizia "3 resultado(s), nenhum novo".
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as metrics from '../src/utils/metrics.js';
import { schedulePtSweepTail } from '../src/providers/search-sweep-tail.js';

const HASH = 'a'.repeat(40);
const originalSearch = jackett.search;
const originalIndexers = config.jackett.indexers;
const originalSweepGlobal = config.jackett.ptSweepGlobal;

// Indexers globais (fora de ptBrIndexers) para o alvo da varredura não sair vazio.
const GLOBAIS = ['magnetdownload', 'limetorrents'];

function contador(nome: string): number {
  const snap = metrics.snapshot() as any;
  return Number(snap?.counters?.[nome] || 0);
}

async function rodarVarredura(itensAchados: any[], itensJaNaLista: any[] = []) {
  (jackett as any).search = async () => itensAchados;
  const tarefas: Array<() => any> = [];
  const raw: any = { items: [...itensJaNaLista], partial: false, sweepInline: false, completion: null };
  schedulePtSweepTail({
    raw,
    finish: async () => ({}),
    responsePhase: 0,
    enqueueTail: (task: () => any) => { tarefas.push(task); return Promise.resolve(); },
    type: 'movie',
    matchContext: {} as any,
    sweepQuery: 'Mortuária',
    wantsJackettSweep: true,
  });
  for (const t of tarefas) await t();
  return raw;
}

beforeEach(() => {
  config.jackett.indexers = [...GLOBAIS];
  config.jackett.ptSweepGlobal = true;
});

afterEach(() => {
  (jackett as any).search = originalSearch;
  config.jackett.indexers = originalIndexers;
  config.jackett.ptSweepGlobal = originalSweepGlobal;
});

test('achou releases sem infoHash resolvível: conta em sem-hash, não em known', async () => {
  const antesSemHash = contador('search.pt-sweep.sem-hash');
  const antesKnown = contador('search.pt-sweep.known');

  // O formato exato medido em produção: magnet é a URL da página.
  const raw = await rodarVarredura([
    { title: 'Mortuária.2005.1080p.WEB-DL.x264.DUAL.2.0', magnet: 'https://www.magnetdownload.com/info/8065599', infoHash: null, indexer: 'magnetdownload' },
    { title: 'Mortuária (2005) - Dual Áudio - 720p', magnet: 'https://www.magnetdownload.com/info/8065600', infoHash: null, indexer: 'magnetdownload' },
  ]);

  assert.equal(contador('search.pt-sweep.sem-hash') - antesSemHash, 2, 'os dois entram como sem-hash');
  assert.equal(contador('search.pt-sweep.known') - antesKnown, 0, 'tudo sem hash não é "já conhecido"');
  assert.equal(raw.items.length, 0, 'nada sem hash entra na lista');
});

test('misto sem-hash + já conhecido: cada um no seu balde', async () => {
  const antesSemHash = contador('search.pt-sweep.sem-hash');
  const antesKnown = contador('search.pt-sweep.known');

  const raw = await rodarVarredura(
    [
      { title: 'Mortuária 720p DUBLADO', infoHash: HASH, indexer: 'limetorrents' },
      { title: 'Mortuária.2005.1080p.DUAL', magnet: 'https://www.magnetdownload.com/info/8065599', infoHash: null, indexer: 'magnetdownload' },
    ],
    [{ title: 'Mortuary 2005 720p', infoHash: HASH, indexer: 'limetorrents' }],
  );

  assert.equal(contador('search.pt-sweep.sem-hash') - antesSemHash, 1);
  assert.equal(contador('search.pt-sweep.known') - antesKnown, 1);
  assert.equal(raw.items.length, 1, 'a lista não muda');
});

test('achou releases já conhecidos: continua em known, sem contar sem-hash', async () => {
  const antesSemHash = contador('search.pt-sweep.sem-hash');
  const antesKnown = contador('search.pt-sweep.known');

  await rodarVarredura(
    [{ title: 'Mortuária 720p DUBLADO', infoHash: HASH, indexer: 'limetorrents' }],
    [{ title: 'Mortuary 2005 720p', infoHash: HASH, indexer: 'limetorrents' }],
  );

  assert.equal(contador('search.pt-sweep.sem-hash') - antesSemHash, 0, 'hash resolvível não é sem-hash');
  assert.equal(contador('search.pt-sweep.known') - antesKnown, 1);
});

test('achou release novo e usável: entra na lista, sem passar por sem-hash', async () => {
  const antesSemHash = contador('search.pt-sweep.sem-hash');

  const raw = await rodarVarredura([
    { title: 'Mortuária 1080p DUAL', infoHash: 'b'.repeat(40), indexer: 'limetorrents' },
  ]);

  assert.equal(contador('search.pt-sweep.sem-hash') - antesSemHash, 0);
  assert.equal(raw.items.length, 1, 'o novo com hash entra');
});
