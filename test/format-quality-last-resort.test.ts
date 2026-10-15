// Último recurso do QUALITY_FILTER: quando o filtro de qualidade do usuário
// não deixa NADA tocável, a busca reabre a faixa excluída em vez de devolver
// lista vazia. Extraído de test/format-sort-limit.test.ts pelo teto de 400
// linhas; o cenário é o mesmo (lógica pura de format.js, sem rede).
import { test } from 'node:test';
import assert from 'node:assert';
import { toStremioStream, sortAndLimit } from '../src/utils/format.js';
import type { RawItem, Stream } from '../types/domain.js';
import * as metrics from '../src/utils/metrics.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

type TestStream = Stream & { infoHash: string; name: string; title: string; behaviorHints: { bingeGroup: string } };
const stremioStream = (item: RawItem): TestStream => toStremioStream(item) as TestStream;

test('último recurso: QUALITY_FILTER reabre SD só quando o permitido some', () => {
  // The Locals (tt0387357): q=2160p,1080p,720p deixa só MagnetDownload 👤1,
  // que o piso de seeders já mata; sobra Kickass DVDRip 👤7, SD, que morria
  // antes do Chupim e deixava a UI vazia com cachedOnly.
  const relaxed = () => metrics.snapshot().counters['search.qualityFilter.relaxed'] || 0;
  const weakHd = stremioStream({
    title: 'The Locals 2003 720p WEB-DL',
    infoHash: HASH,
    seeders: 1,
  });
  const healthySd = stremioStream({
    title: 'The Locals 2003 DVDRip XviD',
    infoHash: OTHER,
    seeders: 7,
  });
  const filter = ['2160p', '1080p', '720p'] as never[];
  const before = relaxed();
  const sparse = sortAndLimit([weakHd, healthySd], {
    minSeeders: 3,
    maxResults: 10,
    qualityFilter: filter,
  });
  assert.deepEqual(
    sparse.map((s) => s.infoHash),
    [OTHER],
    'sem nenhum permitido de pé, o SD entra em vez da lista vazia',
  );
  assert.equal(relaxed() - before, 1);

  // Controle 1: HD forte permitido — o filtro do usuário vale integralmente.
  const strongHd = stremioStream({
    title: 'Popular Title 1080p WEB-DL',
    infoHash: 'c'.repeat(40),
    seeders: 40,
  });
  const before2 = relaxed();
  const healthy = sortAndLimit([strongHd, healthySd], {
    minSeeders: 1,
    maxResults: 10,
    qualityFilter: filter,
  });
  assert.deepEqual(
    healthy.map((s) => s.infoHash),
    [strongHd.infoHash],
    'com HD permitido o filtro de qualidade não afrouxa',
  );
  assert.equal(relaxed() - before2, 0);

  // Controle 2: o gatilho é "permitido vazio", não "permitido fraco".
  // Agregador BR grava `seeders: 1` sintético (bludv) — um piso de saúde
  // afrouxaria o filtro do usuário em toda busca BR normal.
  const before3 = relaxed();
  const syntheticSeeds = sortAndLimit([weakHd, healthySd], {
    minSeeders: 1,
    maxResults: 10,
    qualityFilter: filter,
  });
  assert.deepEqual(
    syntheticSeeds.map((s) => s.infoHash),
    [HASH],
    'HD permitido com 👤1 sintético segura o filtro; o SD continua fora',
  );
  assert.equal(relaxed() - before3, 0);
});

test('último recurso não conta quando o SD reaberto morre no CAM/tamanho', () => {
  const relaxed = () => metrics.snapshot().counters['search.qualityFilter.relaxed'] || 0;
  const filter = ['2160p', '1080p', '720p'] as never[];
  const camSd = stremioStream({
    title: 'The Locals 2003 CAM XviD',
    infoHash: HASH,
    seeders: 7,
  });
  const before = relaxed();
  const soCam = sortAndLimit([camSd], {
    minSeeders: 1,
    maxResults: 10,
    qualityFilter: filter,
    excludeCam: true,
  });
  assert.equal(soCam.length, 0, 'CAM não é resgatado pelo último recurso');
  assert.equal(relaxed() - before, 0, 'métrica não conta resgate que não aconteceu');

  const hugeSd = stremioStream({
    title: 'The Locals 2003 DVDRip XviD',
    infoHash: OTHER,
    seeders: 7,
    size: 80 * 1024 ** 3,
  });
  const before2 = relaxed();
  const soHuge = sortAndLimit([hugeSd], {
    minSeeders: 1,
    maxResults: 10,
    qualityFilter: filter,
    maxSizeGb: 5,
  });
  assert.equal(soHuge.length, 0, 'SD acima do teto de tamanho não é resgatado');
  assert.equal(relaxed() - before2, 0);
});
