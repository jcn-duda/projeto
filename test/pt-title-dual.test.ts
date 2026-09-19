// Recuperação de DUAL global pelo título pt-BR do TMDB (ptTitleDual).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPtTitleDual } from '../src/providers/pt-title-dual.js';
import { toStremioStream, sortAndLimit } from '../src/utils/format.js';
import type { RawItem } from '../types/domain.js';

const HASH = 'a'.repeat(40);

function raw(title: string, extra: Partial<RawItem> = {}): RawItem {
  return {
    title,
    infoHash: HASH,
    seeders: 1,
    size: 2 * 1024 ** 3,
    tracker: 'kickasstorrents',
    indexer: 'kickasstorrents',
    ...extra,
  };
}

function marked(title: string, titles: { pt: string; original?: string; en?: string }) {
  const [out] = applyPtTitleDual([raw(title)], { titles });
  return out;
}

test('aplica ptTitleDual quando o título começa com pt TMDB distinto + DUAL literal', () => {
  assert.equal(
    marked('Lanternas.S01E04.WEB-DL.1080p.x264.DUAL.5.1-STARCKFILMES', {
      pt: 'Lanternas',
      original: 'Lanterns',
    }).ptTitleDual,
    true,
  );
  assert.equal(
    marked('O.Cavaleiro.dos.Sete.Reinos.S01E06.WEB-DL.1080p.x264.DUAL.5.1-SF', {
      pt: 'O Cavaleiro dos Sete Reinos',
      original: 'A Knight of the Seven Kingdoms',
    }).ptTitleDual,
    true,
  );
  assert.equal(
    marked('A.Rocha.1996.1080p.BluRay.DUAL-SF', {
      pt: 'A Rocha',
      original: 'The Rock',
    }).ptTitleDual,
    true,
  );
  assert.equal(
    marked('O Grande Truque (2006) BluRay 720p Dual Audio', {
      pt: 'O Grande Truque',
      original: 'The Prestige',
    }).ptTitleDual,
    true,
  );
  // Artigo do TMDB ausente na release: casa pelo pt sem determinante.
  assert.equal(
    marked('Grande Truque (2006) BluRay 720p Dual Audio', {
      pt: 'O Grande Truque',
      original: 'The Prestige',
    }).ptTitleDual,
    true,
  );
});

// Regressão b867c13: a guarda de tokens do strip é POR CAMINHO. O legado (só
// o pt perde o determinante) aceita 2 tokens ("O Corvo" → "corvo"); a dos
// dois lados (título E pt mutilados) segue exigindo 3.
test('regressão b867c13: pt de 2 tokens volta a marcar; guardas dos dois caminhos seguram', () => {
  // Medido: "Corvo 1994 … DUAL" × pt "O Corvo" — com a guarda de 3 no legado
  // o strip nem corta "o corvo" (2 tokens) e a marca some. Idem "A Origem".
  assert.equal(
    marked('Corvo 1994 1080p BluRay DUAL', { pt: 'O Corvo', original: 'The Crow' }).ptTitleDual,
    true,
  );
  assert.equal(
    marked('Origem 2010 1080p BluRay DUAL', { pt: 'A Origem', original: 'Inception' }).ptTitleDual,
    true,
  );
  // Determinante presente nas duas pontas: caminho 1 (prefixo direto).
  assert.equal(
    marked('O Corvo 1994 1080p BluRay DUAL', { pt: 'O Corvo', original: 'The Crow' }).ptTitleDual,
    true,
  );
  // Contraprova da guarda dos DOIS lados (3 tokens): "A Rocha" (2 tokens) NÃO
  // pode virar "rocha" contra o título mutilado "Na Rocha Queimada".
  assert.equal(
    marked('Na Rocha Queimada Dual', { pt: 'A Rocha', original: 'The Rock' }).ptTitleDual,
    undefined,
  );
  // Contraprova do legado: "rocha" casa o prefixo, mas "queimada" não é
  // ano/qualidade — AFTER_PT_OK_RE segura o post mais largo.
  assert.equal(
    marked('Rocha Queimada Dual', { pt: 'A Rocha', original: 'The Rock' }).ptTitleDual,
    undefined,
  );
});

test('não marca MULTI, pt==original, idioma estrangeiro, legendado, lied ou titles null', () => {
  assert.equal(
    marked('Dr.House.S06.HDLight.1080p.Multi.HEVC.5.1-Uzil', {
      pt: 'Dr House',
      original: 'House',
    }).ptTitleDual,
    undefined,
  );
  // DUAL+MULTI (cena francesa) e tokens da lista mínima não podem regredir.
  assert.equal(
    marked('A.Rocha.1996.1080p.BluRay.DUAL.MULTi', {
      pt: 'A Rocha',
      original: 'The Rock',
    }).ptTitleDual,
    undefined,
  );
  assert.equal(
    marked('A.Rocha.1996.BluRay.DUAL.VF', { pt: 'A Rocha', original: 'The Rock' }).ptTitleDual,
    undefined,
  );
  assert.equal(
    marked('A.Rocha.1996.DUAL.ESP', { pt: 'A Rocha', original: 'The Rock' }).ptTitleDual,
    undefined,
  );
  // Prefixo pt sem fronteira de release: homônimo não herda a obra.
  assert.equal(
    marked('A Rocha Queimada Dual Audio 1080p', {
      pt: 'A Rocha',
      original: 'The Rock',
    }).ptTitleDual,
    undefined,
  );
  assert.equal(
    marked('Moana.2026.1080p-Dual-Lat', { pt: 'Moana', original: 'Moana' }).ptTitleDual,
    undefined,
  );
  assert.equal(
    marked('A Rocha 1996 Dual Latino', { pt: 'A Rocha', original: 'The Rock' }).ptTitleDual,
    undefined,
  );
  assert.equal(
    marked('A Rocha 1996 1080p Dual Audio [Eng-Spa]', {
      pt: 'A Rocha',
      original: 'The Rock',
    }).ptTitleDual,
    undefined,
  );
  assert.equal(
    marked('A Rocha LEGENDADO DUAL', { pt: 'A Rocha', original: 'The Rock' }).ptTitleDual,
    undefined,
  );
  assert.equal(
    applyPtTitleDual([raw('A.Rocha.1996.1080p.BluRay.DUAL-SF', { lied: true })], {
      titles: { pt: 'A Rocha', original: 'The Rock' },
    })[0].ptTitleDual,
    undefined,
  );
  assert.equal(
    applyPtTitleDual([raw('A.Rocha.1996.1080p.BluRay.DUAL-SF')], { titles: null })[0].ptTitleDual,
    undefined,
  );
});

test('toStremioStream de item marcado: _br, _dubbed e chip BR no name', () => {
  const item = marked('A.Rocha.1996.1080p.BluRay.DUAL-SF', {
    pt: 'A Rocha',
    original: 'The Rock',
  });
  const stream = toStremioStream(item)!;
  assert.equal(stream._br, true);
  assert.equal(stream._dubbed, true);
  assert.match(String(stream.name), /\bBR\b/);
});

test('DUAL ptTitleDual com 1 seeder sobrevive ao pool-cut contra 1080p EN com 100+ seeders', () => {
  const dualRaw = marked('A.Rocha.1996.1080p.BluRay.DUAL.5.1-STARCKFILMES', {
    pt: 'A Rocha',
    original: 'The Rock',
  });
  const dual = toStremioStream({ ...dualRaw, infoHash: 'b'.repeat(40), seeders: 1 })!;
  const english = Array.from({ length: 40 }, (_, i) =>
    toStremioStream({
      title: `The Rock 1996 1080p BluRay x264`,
      infoHash: `${String(i).padStart(2, '0')}${'c'.repeat(38)}`,
      seeders: 100 + i,
      size: 2 * 1024 ** 3,
      tracker: 'The Pirate Bay',
      indexer: 'thepiratebay',
    })!,
  );
  // Sem _br o sort por seeders enterraria o DUAL; com brReserved o pool o
  // preserva (mesmo caminho que prepareCandidateStreams usa no pool-cut).
  const out = sortAndLimit([dual, ...english], {
    maxResults: 8,
    brReservedSlots: 2,
    brFirst: true,
    qualityLimits: { '1080p': 8 },
    candidateFactor: 1,
  });
  assert.ok(
    out.some((s) => s.infoHash === dual.infoHash && s._br === true),
    'DUAL pt-BR marcado tem que sobreviver ao pool-cut',
  );
});
