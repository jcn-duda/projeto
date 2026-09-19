// Resolução do arquivo que o play tocaria entra como `provenQuality` antes do
// toStremioStream, para release cujo título não diz 720p/1080p (FILMOGRAFIA
// COMPLETA JORNADA NAS ESTRELAS, 2026-09-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as cache from '../src/utils/cache.js';
import { recordFileSizes, clearFileSizes } from '../src/debrid/file-sizes.js';
import { videoQualityKey } from '../src/debrid/video-quality.js';
import { applyProbedQuality } from '../src/providers/probed-quality.js';
import { applyFileEvidence } from '../src/providers/stream-builder-pipeline.js';
import { toStremioStream, UNKNOWN_QUALITY } from '../src/utils/format.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { recordFileEvidence } from '../src/debrid/audio-audit.js';
import type { RawItem } from '../types/domain.js';

const GB = 1024 ** 3;
const HASH = 'e9'.repeat(20);
const PASTA = 'FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR';
const ARQUIVO_2009 = `${PASTA}/11 - Jornada nas Estrelas - Star Trek - 2009.mkv`;
const colecao = () => ({ title: PASTA, infoHash: HASH, seeders: 1, size: 22.45 * GB, fromAccount: true }) as RawItem;
const work = { n: ['Star Trek'], y: 2009 };

function seedCollection() {
  clearFileSizes();
  recordFileSizes(HASH, [
    { path: `${PASTA}/01 - Jornada nas Estrelas - O Filme - 1979.mp4`, size: 2.0 * GB, link: 'https://alldebrid.test/f/1' },
    { path: ARQUIVO_2009, size: 1.53 * GB, link: 'https://alldebrid.test/f/11' },
    { path: `${PASTA}/13 - Jornada nas Estrelas - Sem Fronteiras - 2016.mp4`, size: 2.23 * GB, link: 'https://alldebrid.test/f/13' },
  ]);
}

test('qualidade medida do arquivo escolhido vira o rótulo do stream', () => {
  seedCollection();
  const key = videoQualityKey(HASH, ARQUIVO_2009);
  cache.set(key, { q: '1080p', w: 1920, h: 800 }, 60);
  try {
    const [out] = applyProbedQuality([colecao()], { season: null, episode: null, workHint: work });
    assert.equal(out.provenQuality, '1080p');
    const stream = toStremioStream(out)!;
    assert.equal(stream._quality, '1080p');
    assert.match(String(stream.name), /1080p/, 'o nome leva a resolução para o chip do app');
    // Outro filme da mesma coleção não herda a medição do 2009.
    const [beyond] = applyProbedQuality([colecao()], { season: null, episode: null, workHint: { n: ['Star Trek: Sem Fronteiras'], y: 2016 } });
    assert.equal(beyond.provenQuality, undefined);
  } finally {
    cache.forget(key);
    clearFileSizes();
  }
});

test('título com resolução e arquivo com resolução no nome não precisam de medição', () => {
  seedCollection();
  try {
    const comTitulo = { ...colecao(), title: `${PASTA} 720p` } as RawItem;
    assert.equal(applyProbedQuality([comTitulo], { season: null, episode: null, workHint: work })[0].provenQuality, undefined);

    recordFileSizes(HASH, [{ path: `${PASTA}/11 - Star Trek - 2009 1080p.mkv`, size: 1.53 * GB }]);
    const [out] = applyProbedQuality([colecao()], { season: null, episode: null, workHint: work });
    assert.equal(out.provenQuality, '1080p', 'o nome do arquivo escolhido basta');
  } finally {
    clearFileSizes();
  }
});

test('sem medição e sem AllDebrid ativo, o item segue intacto e nada é agendado', () => {
  seedCollection();
  try {
    const [out] = applyProbedQuality([colecao()], { season: null, episode: null, workHint: work });
    assert.equal(out.provenQuality, undefined);
    assert.equal(cache.keysMatching('vres:').length, 0);
    // Sem lista de arquivos do hash não há arquivo escolhido.
    clearFileSizes();
    assert.equal(applyProbedQuality([colecao()], { season: null, episode: null, workHint: work })[0].provenQuality, undefined);
  } finally {
    clearFileSizes();
  }
});

test('evidência de arquivo "sem resolução" não sobrescreve a resolução do título', () => {
  if (!releaseIndex.status().enabled) return;
  const hash = 'f7'.repeat(20);
  releaseIndex.markFileEvidence(hash, { a: '', q: UNKNOWN_QUALITY, n: 'arquivo.mkv' });
  const [out] = applyFileEvidence([{ title: 'Filme 2009 1080p BluRay', infoHash: hash, seeders: 5 } as RawItem]);
  assert.equal(out.provenQuality, undefined);
  assert.equal(toStremioStream(out)!._quality, '1080p');
});

test('play de coleção não grava resolução nem nome do maior filme como prova do hash', () => {
  if (!releaseIndex.status().enabled) return;
  const colecaoHash = 'd4'.repeat(20);
  recordFileEvidence(colecaoHash, [
    { path: `${PASTA}/11 - Jornada nas Estrelas - Star Trek - 2009 720p.mkv`, size: 1.53 * GB },
    { path: `${PASTA}/13 - Jornada nas Estrelas - Sem Fronteiras - 2016 1080p DUBLADO.mp4`, size: 2.23 * GB },
  ]);
  const ev = releaseIndex.fileEvidence(colecaoHash);
  assert.ok(ev, 'o áudio dublado continua gravado');
  assert.equal(ev!.q, '', 'resolução do maior filme não vale para a coleção');
  assert.equal(ev!.n, '', 'nome do maior filme não vale para a coleção');

  const semResolucao = 'c5'.repeat(20);
  recordFileEvidence(semResolucao, [{ path: 'Filme.2009.DUBLADO.mkv', size: 2 * GB }]);
  assert.equal(releaseIndex.fileEvidence(semResolucao)!.q, '', '"sem resolução" não vira prova');
  clearFileSizes();
});
