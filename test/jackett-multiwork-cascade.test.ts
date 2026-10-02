// --- Degrau COMPLEMENTAR da coleção multiobra (BR_MULTIWORK_PACKS) ---
//
// O dublado BR de um filme isolado às vezes só existe no pack da franquia, e a
// primária pode trazer só releases do filme — por isso o degrau da coleção
// (`multiWorkQuery`) abre MESMO com relevante na mão e AGREGA em vez de
// substituir. O que ele respeita: não abrir quando o acumulado já contém um
// pack admitido, e manter os demais degraus com o gate clássico por
// `relevant.length === 0`.
import { test } from 'node:test';
import assert from 'node:assert';

import jackett from '../src/providers/jackett.js';
import * as metrics from '../src/utils/metrics.js';
import { fakeResponse, makeFetch, withJackett } from './helpers/jackett-fetch.js';

const HP_HASH = 'a'.repeat(40);
const HP_PACK_HASH = 'b'.repeat(40);
const HP_NAME = 'Harry Potter e a Pedra Filosofal';
const HP_PT = 'Harry Potter e a Pedra Filosofal 2001';
const HP_VARIANT = 'Harry Potter e a Pedra Filosofal 1 2001';
const HP_BARE = 'Harry Potter e a Pedra Filosofal';
const HP_ROOT = 'harry potter';
const HP_FALLBACK = 'Harry Potter and the Philosophers Stone 2001';
const HP = { name: 'Harry Potter - Coleção', root: 'harry potter', years: [2001, 2002, 2004, 2005, 2007, 2009, 2010, 2011] };
const HP_CTX = { names: [HP_NAME], year: 2001, isSeries: false, season: null, episode: null, multiWork: HP };
const HP_FILM = 'Harry Potter e a Pedra Filosofal 2001 Dublado 1080p';
const HP_PACK = 'Harry Potter - Coleção Completa 2001-2011 Dublado 1080p';
const HP_PACK_MAGNET = `magnet:?xt=urn:btih:${HP_PACK_HASH}&dn=Harry.Potter.Collection.2001-2011.DUAL.1080p`;

test('pack multiobra: primária relevante abre o degrau complementar e AGREGA o pack', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === HP_PT) {
        return fakeResponse({ Results: [
          { Title: HP_FILM, Seeders: 8, MagnetUri: `magnet:?xt=urn:btih:${HP_HASH}&dn=Harry.Potter.2001.1080p` },
        ] });
      }
      if (query === HP_ROOT) {
        return fakeResponse({ Results: [{ Title: HP_PACK, Seeders: 2, MagnetUri: HP_PACK_MAGNET }] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const before = metrics.snapshot().counters;
    const items = await jackett.search(HP_PT, 'movie', ['bludv-cardigann'], {
      multiWorkQuery: HP_ROOT,
      // Degraus clássicos presentes: com relevante na mão NÃO podem abrir.
      variantQuery: HP_VARIANT,
      fallbackQuery: HP_FALLBACK,
      matchContext: HP_CTX,
    });
    const after = metrics.snapshot().counters;
    // A primária respondeu release do filme (relevante) e mesmo assim o degrau
    // da coleção abriu; variante/bare/fallback ficaram no gate por vazio.
    assert.deepEqual(fetchImpl.searchCalls(), [HP_PT, HP_ROOT]);
    assert.equal(items.length, 2, 'agrega a release da primária + o pack da coleção');
    assert.deepEqual(items.map((i: any) => i.title).sort(), [HP_FILM, HP_PACK].sort());
    assert.equal(
      (after['jackett.multiwork.complementary'] || 0) - (before['jackett.multiwork.complementary'] || 0),
      1,
      'degrau complementar (abriu com relevante presente) tem métrica própria',
    );
  });
});

test('pack multiobra: pack já admitido na primária evita a query complementar', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      // A primária já devolve o pack admitido da franquia; qualquer outra query
      // devolveria o mesmo pack, mas não deve nem sair — o assert de
      // searchCalls prova que o degrau complementar não foi tentado.
      return fakeResponse({ Results: [{ Title: HP_PACK, Seeders: 2, MagnetUri: HP_PACK_MAGNET }] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const before = metrics.snapshot().counters;
    const items = await jackett.search(HP_PT, 'movie', ['bludv-cardigann'], {
      multiWorkQuery: HP_ROOT,
      matchContext: HP_CTX,
    });
    const after = metrics.snapshot().counters;
    // A query da coleção não tem o que acrescentar: o pack já está admitido.
    assert.deepEqual(fetchImpl.searchCalls(), [HP_PT]);
    assert.equal(items.length, 1);
    assert.equal(
      (after['jackett.multiwork.complementary'] || 0) - (before['jackett.multiwork.complementary'] || 0),
      0,
      'sem abertura complementar não há métrica',
    );
  });
});

test('pack multiobra: com a primária vazia, os degraus clássicos seguem a cascata de sempre', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse({ Results: [] });
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(HP_PT, 'movie', ['bludv-cardigann'], {
      variantQuery: HP_VARIANT,
      multiWorkQuery: HP_ROOT,
      fallbackQuery: HP_FALLBACK,
      matchContext: HP_CTX,
    });
    // Sem relevante na mão, CADA degrau abre na ordem clássica
    // (variante → sem ano → coleção → fallback) e a cascata termina vazia.
    assert.deepEqual(fetchImpl.searchCalls(), [HP_PT, HP_VARIANT, HP_BARE, HP_ROOT, HP_FALLBACK]);
    assert.deepEqual(items, []);
  });
});

test('pack multiobra: degrau complementar vazio preserva o que a primária trouxe', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === HP_PT) {
        return fakeResponse({ Results: [
          { Title: HP_FILM, Seeders: 8, MagnetUri: `magnet:?xt=urn:btih:${HP_HASH}&dn=Harry.Potter.2001.1080p` },
        ] });
      }
      // A coleção respondeu vazio: o degrau abriu complementar, mas não achou pack.
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const before = metrics.snapshot().counters;
    const items = await jackett.search(HP_PT, 'movie', ['bludv-cardigann'], {
      multiWorkQuery: HP_ROOT,
      matchContext: HP_CTX,
    });
    const after = metrics.snapshot().counters;
    assert.deepEqual(fetchImpl.searchCalls(), [HP_PT, HP_ROOT]);
    // Agregar com vazio é identidade: a release da primária NÃO pode sumir.
    assert.deepEqual(items.map((i: any) => i.title), [HP_FILM]);
    assert.equal(
      (after['jackett.multiwork.complementary'] || 0) - (before['jackett.multiwork.complementary'] || 0),
      1,
      'abriu complementar mesmo tendo voltado vazio',
    );
  });
});
