// Fusão de evidência por hash (caso Mortuary, tt0087746): o mesmo infoHash
// pode existir no índice com snapshot velho (Torrentio, seeders=0) enquanto a
// coleta ao vivo o vê saudável (TPB, seeders=3). Duas fronteiras garantem que
// a evidência boa resgate a ruim ANTES do piso de seeders cortar a release:
// 1. `release-index.record` preserva o teto de seeders observado por hash;
// 2. `fuseIndexEnrichment` funde a cópia conhecida em vez de descartá-la.
//
// O teste de ponta que abria `/stream` para ver a promoção reintroduzir a
// release saiu no F4.4: a resposta agora é do gateway nativo e a fusão vive no
// núcleo. Aqui ficam as duas decisões puras que o TS ainda executa.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as releaseIndex from '../src/utils/release-index.js';
import { fuseIndexEnrichment } from '../src/providers/index-enrichment.js';

const IMDB = 'tt0087746';
const RUSTED_HASH = '1192bdf0'.padEnd(40, '0');
const RUSTED_TITLE = 'Mortuary.1982.720p.BluRay.x264-RUSTED';

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
