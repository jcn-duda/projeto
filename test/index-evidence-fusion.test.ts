// Fusão de evidência por hash (caso Mortuary, tt0087746): o mesmo infoHash
// pode existir no índice com snapshot velho (Torrentio, seeders=0) enquanto a
// coleta ao vivo o vê saudável (TPB, seeders=3). Duas fronteiras garantem que
// a evidência boa resgate a ruim ANTES do piso de seeders cortar a release:
// 1. `release-index.record` preserva o teto de seeders observado por hash;
// 2. o enriquecimento do tail (servedFromIndex) funde a cópia conhecida em
//    vez de descartá-la, e a promoção reintroduz a release — agora elegível
//    ao seeds pool do Chupim.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import jackett from '../src/providers/jackett.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { topSeededPool } from '../src/utils/autofetch-pools.js';
import { fuseIndexEnrichment } from '../src/providers/index-evidence.js';
import type { DebridAdapter } from '../types/domain.js';
import { createTestServer, encodeConfig, withMockFetch } from './e2e/e2e-harness.js';

const FAKE_ADAPTER = {
  id: 'premiumize',
  label: 'Premiumize fake',
  short: 'pm',
  cacheCheck: true,
  keyUrl: null as unknown as string,
  checkCached: async (_apiKey: string, infoHashes: string[]) => ({ cached: new Set(infoHashes), complete: true }),
  resolveLink: async () => null,
  inventory: async () => [] as any[],
} as unknown as DebridAdapter;

const IMDB = 'tt0087746';
const RUSTED_HASH = '1192bdf0'.padEnd(40, '0');
const RUSTED_TITLE = 'Mortuary.1982.720p.BluRay.x264-RUSTED';

let server: any;
const saved: Record<string, any> = {};

before(async () => {
  saved.resolveSecret = config.debrid.resolveSecret;
  saved.jackettApiKey = config.jackett.apiKey;
  saved.tmdbApiKey = config.tmdb.apiKey;
  saved.publicUrl = config.debrid.publicUrl;
  config.debrid.resolveSecret = '';
  config.jackett.apiKey = 'test-jackett-key';
  config.tmdb.apiKey = 'test-tmdb-key';
  config.debrid.publicUrl = 'https://addon.teste';
  debrid.BY_ID.set(FAKE_ADAPTER.id, FAKE_ADAPTER);
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  debrid.BY_ID.delete(FAKE_ADAPTER.id);
  config.debrid.resolveSecret = saved.resolveSecret;
  config.jackett.apiKey = saved.jackettApiKey;
  config.tmdb.apiKey = saved.tmdbApiKey;
  config.debrid.publicUrl = saved.publicUrl;
});

function userCfg(apiKey: string, overrides: Record<string, any> = {}) {
  return encodeConfig({
    p: ['jackett'],
    q: ['2160p', '1080p', '720p', '480p'],
    ds: 'premiumize',
    dk: apiKey,
    ...overrides,
  });
}

test('record: fusão por hash preserva o melhor seeders observado (0 → 3, e 0 não rebaixa)', async () => {
  const espera = () => new Promise((resolve) => setTimeout(resolve, 2));
  // Snapshot velho do agregador: mesmo hash, swarm 0.
  releaseIndex.record(IMDB, {}, [{ title: RUSTED_TITLE, infoHash: RUSTED_HASH, seeders: 0, indexer: 'torrentio' }]);
  assert.equal(releaseIndex.lookup(IMDB)[0].seeders, 0);
  await espera();
  // Cópia saudável do TPB resgata a evidência.
  releaseIndex.record(IMDB, {}, [{ title: RUSTED_TITLE, infoHash: RUSTED_HASH, seeders: 3, indexer: 'thepiratebay' }]);
  const resgatado = releaseIndex.lookup(IMDB)[0];
  assert.equal(resgatado.seeders, 3, 'o melhor estado observado vence');
  assert.equal(resgatado.indexer, 'thepiratebay', 'o registro mais recente vence nos metadados');
  await espera();
  // Novo snapshot 0 do agregador não apaga a medição.
  releaseIndex.record(IMDB, {}, [{ title: RUSTED_TITLE, infoHash: RUSTED_HASH, seeders: 0, indexer: 'torrentio' }]);
  assert.equal(releaseIndex.lookup(IMDB)[0].seeders, 3, 'snapshot pior não rebaixa a evidência');
});

test('fuseIndexEnrichment: clone sem mutar a referência original; só o seeders sobe', () => {
  const prior = {
    title: 'Mortuary.1982.720p.BluRay.x264-RUSTED',
    infoHash: RUSTED_HASH,
    seeders: 0,
    indexer: 'torrentio',
    isBr: false,
    dubbed: false,
  };
  const lote = [prior];
  const vivo = { ...prior, seeders: 3, indexer: 'thepiratebay' };
  const { fresh, fused } = fuseIndexEnrichment(lote, [vivo]);
  assert.equal(fresh.length, 0);
  assert.equal(fused, 1);
  // A referência original NÃO foi mutada — quem guardou `prior` segue intacto.
  assert.equal(prior.seeders, 0, 'objeto original permanece com o snapshot velho');
  assert.equal(prior.indexer, 'torrentio');
  // O elemento do array foi SUBSTITUÍDO por um clone com apenas o seeders novo.
  assert.notEqual(lote[0], prior, 'elemento trocado por clone, não mutação');
  assert.equal(lote[0].seeders, 3);
  const { seeders: _s, ...resto } = lote[0];
  const { seeders: _p, ...priorSemSeeds } = prior;
  assert.deepEqual(resto, priorSemSeeds, 'apenas seeders difere do prior');
});

test('fuseIndexEnrichment: snapshot pior não rebaixa e hash desconhecido vai para fresh', () => {
  const prior = { title: RUSTED_TITLE, infoHash: RUSTED_HASH, seeders: 3, indexer: 'thepiratebay' };
  const lote = [prior];
  // Nova observação do agregador com swarm pior: sem fusão, sem troca.
  const pior = fuseIndexEnrichment(lote, [{ ...prior, seeders: 0, indexer: 'torrentio' }]);
  assert.equal(pior.fused, 0);
  assert.equal(pior.fresh.length, 0);
  assert.equal(lote[0], prior, 'lote intacto quando nada melhora');
  assert.equal(lote[0].seeders, 3);
  // Hash novo entra como fresh (comportamento de enriquecimento original).
  const novoHash = 'f00d'.padEnd(40, '0');
  const novo = fuseIndexEnrichment(lote, [{ title: 'Outro 720p', infoHash: novoHash, seeders: 1 }]);
  assert.equal(novo.fused, 0);
  assert.equal(novo.fresh.length, 1);
  assert.equal(novo.fresh[0].infoHash, novoHash);
});

test('enriquecimento do tail: cópia saudável resgata snapshot 0 antes do piso de seeders', async () => {
  const brHash = 'a1'.repeat(20);
  const originalSearch = jackett.search;
  jackett.search = async (query, _type, indexers) => {
    // Só a consulta global principal (com o ano) traz a cópia saudável do TPB;
    // BR e varredura pt-BR (franchiseRoot, sem ano) ficam vazias para o cenário
    // ficar determinístico.
    if (indexers?.includes('torrentdosfilmesv2')) return [];
    if (!indexers?.includes('thepiratebay')) return [];
    if (!/\b1982\b/.test(String(query))) return [];
    return [{
      title: RUSTED_TITLE,
      infoHash: RUSTED_HASH,
      seeders: 3,
      tracker: 'thepiratebay',
      indexer: 'thepiratebay',
    }];
  };
  try {
    await withMockFetch([
      { match: 'cinemeta.strem.io', handler: () => ({ meta: { name: 'Mortuary', year: '1982', type: 'movie' } }) },
      { match: 'themoviedb.org', handler: () => ({ movie_results: [{ title: 'Mortuary', original_title: 'Mortuary', release_date: '1982-01-01' }] }) },
    ], async () => {
      // Snapshot velho do agregador (0) + fonte BR saudável que sustenta a
      // cobertura do pool para o fast-path servir do índice.
      releaseIndex.record(IMDB, {}, [
        { title: RUSTED_TITLE, infoHash: RUSTED_HASH, seeders: 0, indexer: 'torrentio' },
        { title: 'Mortuary 1982 1080p DUBLADO', infoHash: brHash, seeders: 4, indexer: 'indice-br', isBr: true },
      ]);
      assert.equal(releaseIndex.lookup(IMDB).find((r) => r.hash === RUSTED_HASH)?.seeders, 0);

      // Piso explícito: o `.env` local pode ter MIN_SEEDERS=0 — com `s:2` o
      // snapshot 0 cai e a cópia fundida (3) passa, determinístico nos dois lados.
      // `ji` fixa os indexers: sob a suíte (`setup-env`, .env vazio) a lista
      // default é vazia e a coleta do tail nunca consultaria o TPB.
      const cfg = userCfg('idx-evidencia-fusao', { s: 2, ji: ['torrentdosfilmesv2', 'thepiratebay'] });
      const res = await server.request('GET', `/${cfg}/stream/movie/${IMDB}.json`);
      assert.equal(res.status, 200);
      const firstDump = JSON.stringify(res.json.streams || []).toLowerCase();
      assert.equal(firstDump.includes(RUSTED_HASH), false, 'primeira resposta: snapshot 0 cai no piso de seeders');
      assert.ok(firstDump.includes(brHash), 'fonte BR saudável segue na lista');

      // O tail do índice funde a evidência do TPB (0 → 3) e a promoção
      // reintroduz a release — agora elegível ao seeds pool do Chupim (3 >= piso).
      // Prazo real (não contagem de voltas): sob a suíte cheia o tail disputa
      // CPU com outras buscas e algumas voltas de setImmediate não bastam.
      let promoted: any;
      const prazo = Date.now() + 10000;
      while (Date.now() < prazo) {
        const hit = await server.request('GET', `/${cfg}/stream/movie/${IMDB}.json`);
        const dump = JSON.stringify(hit.json.streams || []).toLowerCase();
        if (dump.includes(RUSTED_HASH)) { promoted = hit.json; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(promoted, 'a promoção inclui a release resgatada pela fusão');
      const idx = releaseIndex.lookup(IMDB).find((r) => r.hash === RUSTED_HASH);
      assert.equal(idx?.seeders, 3, 'o índice retém o melhor seeders observado');
      // O adaptador fake cacheia tudo: o stream sai resolvido por URL (sem o
      // campo infoHash), então a busca é pelo hash na URL de resolve.
      const seedLine = (promoted.streams || []).find((s: any) => String(s.url || s.infoHash || '').toLowerCase().includes(RUSTED_HASH));
      assert.ok(/👤\s*3/.test(String(seedLine?.name || '')), `o stream carrega a evidência fundida (👤 3); nome: ${seedLine?.name}`);
      // Elegibilidade ao seeds pool do Chupim: o pool lê `_seeders` ou o
      // marcador `👤 N` do nome (`seedersOf` do topSeededPool). O candidato
      // promovido passa o piso do pool (3) e NÃO passaria um piso maior — a
      // evidência fundida é o que torna o torrent apostável.
      const candidato = { infoHash: RUSTED_HASH, name: seedLine?.name, title: seedLine?.title, _quality: '720p' };
      assert.equal(topSeededPool([candidato as any], { minSeeders: 3 }).length, 1, 'elegível ao topSeededPool com o piso do Chupim');
      assert.equal(topSeededPool([candidato as any], { minSeeders: 4 }).length, 0, 'o marcador é a evidência real (3), não inflado');
    });
  } finally {
    jackett.search = originalSearch;
  }
});
