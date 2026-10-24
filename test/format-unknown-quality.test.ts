// Balde de resolução desconhecida (qn), cotas por balde, filtro de qualidade
// e sentinela de tamanho fabricado pelo indexer.
// Extraído de test/format-audio-quality.test.ts (teto 400 linhas).
import { test } from 'node:test';
import assert from 'node:assert';
import {
  qualityFromTitle,
  sortAndLimit,
  toStremioStream,
  UNKNOWN_QUALITY,
  QUALITY_KEYS,
} from '../src/utils/format.js';
import type { RawItem, Stream } from '../types/domain.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

// Mesmo wrapper do arquivo de origem: toStremioStream devolve Stream|null e os
// campos de exibição são opcionais — todos os casos abaixo passam hash válido.
type TestStream = Stream & { infoHash: string; name: string; title: string; behaviorHints: { bingeGroup: string } };
const stremioStream = (item: RawItem): TestStream => toStremioStream(item) as TestStream;

test('sem resolução no título não é SD e tem balde próprio', () => {
  // Fonte BR típica: nenhuma resolução no título.
  assert.equal(qualityFromTitle('Devoradores de Estrelas (2026) [opção 3]'), UNKNOWN_QUALITY);
  assert.equal(qualityFromTitle('A Casa do Dragão 1ª Temporada (2022) WEB-DL [DUBLADO]'), UNKNOWN_QUALITY);
  // SD exige marca explícita de baixa qualidade.
  assert.equal(qualityFromTitle('Filme 2019 DVDRip XviD'), 'SD');
  assert.equal(qualityFromTitle('Filme 2019 SDTV'), 'SD');
  assert.equal(qualityFromTitle('Filme 2026 576p WEBRip x265'), 'SD');
  assert.equal(qualityFromTitle('Filme 2019 CAM'), 'SD');
  // Resolução declarada continua ganhando.
  assert.equal(qualityFromTitle('Filme 2019 1080p WEB-DL'), '1080p');
  assert.ok(QUALITY_KEYS.includes(UNKNOWN_QUALITY));
});

test('DVD5/DVD9/DVDR são marca explícita de SD (formato DVD)', () => {
  // Formato de DVD é SD por definição (MPEG-2 480i/576i), não "sem resolução".
  assert.equal(qualityFromTitle('The Locals 2003 DVD5'), 'SD');
  assert.equal(qualityFromTitle('The Locals 2003 DVD9'), 'SD');
  assert.equal(qualityFromTitle('The Locals 2003 DVDR'), 'SD');
  assert.equal(qualityFromTitle('The Locals 2003 DVD-R'), 'SD');
  // Resolução declarada continua ganhando: a marca de DVD não pesa sobre HD.
  assert.equal(qualityFromTitle('The Locals 2003 DVD5 1080p'), '1080p');
  assert.equal(qualityFromTitle('The Locals 2003 2160p 4K DVD9'), '2160p');
});

test('zerar a cota de SD não esconde mais as fontes BR', () => {
  const br = stremioStream({ title: 'Devoradores de Estrelas (2026) [opção 3]', infoHash: HASH, seeders: 1, isBr: true });
  const sd = stremioStream({ title: 'Devoradores de Estrelas 2026 DVDRip', infoHash: OTHER, seeders: 9 });
  const out = sortAndLimit([br, sd], { qualityLimits: { SD: 0 }, maxResults: 10 });
  assert.equal(out.length, 1, 'só o DVDRip cai na cota zerada de SD');
  assert.match(out[0].title, /opção 3/);
  // E a cota nova corta o balde certo quando o usuário quiser.
  assert.equal(sortAndLimit([br, sd], { qualityLimits: { [UNKNOWN_QUALITY]: 0 }, maxResults: 10 }).length, 1);
});

test('resolução desconhecida não vira rótulo nem grupo de binge do SD', () => {
  const s = stremioStream({ title: 'Devoradores de Estrelas (2026) [opção 3] DUBLADO', infoHash: HASH, seeders: 1 });
  const details = s.name;
  assert.ok(!/sem resolução|SD/.test(details), `linha não anuncia resolução: ${details}`);
  // Sem fileEvidence: chip DUB some; claim+BR (looksPtBr) ainda listam.
  assert.equal(s._dubClaim, true);
  assert.equal(s._dubbed, false);
  assert.doesNotMatch(details, /\bDUB\b/);
  assert.ok(!s.behaviorHints.bingeGroup.includes('SD'));
});

test('filtro de resolução preserva fonte sem resolução pelo balde próprio', () => {
  const br = stremioStream({
    title: 'Prometheus (2012) [opção 3] DUBLADO',
    infoHash: 'd'.repeat(40),
    seeders: 1,
    isBr: true,
  });
  const global4k = stremioStream({
    title: 'Prometheus 2012 2160p WEB-DL',
    infoHash: 'e'.repeat(40),
    seeders: 100,
  });
  const limits = { [UNKNOWN_QUALITY]: 100 };
  const out = sortAndLimit([br, global4k], {
    maxResults: 10,
    qualityFilter: ['2160p', '1080p', '720p'] as never[],
    qualityLimits: limits,
  });

  assert.deepEqual(new Set(out.map((item) => item.infoHash)), new Set([br.infoHash, global4k.infoHash]));
});

test('cota zero de sem resolução continua ocultando esse balde', () => {
  const br = stremioStream({
    title: 'Prometheus (2012) [opção 3] DUBLADO',
    infoHash: 'f'.repeat(40),
    seeders: 1,
    isBr: true,
  });
  const out = sortAndLimit([br], {
    maxResults: 10,
    qualityFilter: ['2160p', '1080p', '720p'] as never[],
    qualityLimits: { [UNKNOWN_QUALITY]: 0 },
  });

  assert.deepEqual(out, []);
});

test('filtro de qualidade usa a resolução declarada, não substring do título', () => {
  const br4k = stremioStream({
    title: 'Prometheus (2012) 4K UHD DUBLADO',
    infoHash: '1'.repeat(40),
    seeders: 1,
    isBr: true,
  });
  const out = sortAndLimit([br4k], {
    maxResults: 10,
    qualityFilter: ['2160p'] as never[],
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].infoHash, br4k.infoHash);
});

test('tamanho fabricado pelo indexer vira desconhecido, não valor exibido', () => {
  // 1,62 TB é o carimbo da definição Cardigann do redetorrent em 53 das 93
  // releases de uma busca real. Exibi-lo mente para o usuário e, com filtro de
  // tamanho ligado, apagaria a fonte dublada inteira.
  const absurdo = stremioStream({
    title: 'House of the Dragon S01E02 DUAL 1080p', infoHash: HASH, seeders: 1, size: 1784881034035,
  });
  assert.equal(absurdo._size, 0);
  assert.doesNotMatch(absurdo.title, /TB/);
  // Tamanho plausível continua intacto.
  const real = stremioStream({
    title: 'Filme 1080p', infoHash: OTHER, seeders: 5, size: 8 * 1024 ** 3,
  });
  assert.equal(real._size, 8 * 1024 ** 3);
  assert.match(real.title, /8(\.\d+)? GB/);
  // Filtro de tamanho não pode descartar quem tem tamanho desconhecido.
  const out = sortAndLimit([absurdo], { maxSizeGb: 20 });
  assert.equal(out.length, 1);
});
