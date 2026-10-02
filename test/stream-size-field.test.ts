// Campo `size` na resposta: o chip de tamanho do Power Movie.
//
// Motivo medido (True Detective S01E01, 2026-09-20): o app monta o chip de
// `json.size`, depois de `behaviorHints.videoSize`, e por último do PRIMEIRO
// "N GB" do texto. Em pack BR o primeiro número é o do nome do post, e o chip
// mostrava "12.41 GB" (a temporada inteira) ao lado de um `💾 1.55 GB` correto.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyNoticeOrigin } from '../src/providers/index.js';
import { streamSizeLabel } from '../src/providers/episode-size.js';
import type { Stream } from '../types/domain.js';

const HASH = 'c1'.repeat(20);
const PACK_TITLE = 'True Detective 1ª Temporada (2014) [1080p DUBLADO 12.41 GB]\n👤 1 💾 1.55 GB 📦 pack 12.41 GB (média) ⚙️ NerdFilmesTorrent';

const withTitle = (title: string) => ({ name: '[PM⚡] 1080p DUB BR', title, infoHash: HASH }) as Stream;
const sizeOf = (stream: Stream) => (stream as Stream & { size?: string }).size;

test('pack BR: size é o 💾 do episódio, não o número do nome do post', () => {
  const [out] = applyNoticeOrigin([withTitle(PACK_TITLE)]);
  assert.equal(sizeOf(out), '1.55 GB');
});

test('tamanho do .torrent em KB não vira chip (o app já ignorava KB)', () => {
  assert.equal(streamSizeLabel('True.Detective.S01E01.1080p.HEVC.x265-MeGusta\n👤 87 💾 65.95 KB ⚙️ TheRARBG'), null);
  const [out] = applyNoticeOrigin([withTitle('X\n👤 87 💾 65.95 KB ⚙️ TheRARBG')]);
  assert.equal(sizeOf(out), undefined);
});

test('sem 💾 não inventa size: o app segue com o fallback de sempre', () => {
  const [out] = applyNoticeOrigin([withTitle('True Detective S01E01 1080p AMZN WEB-DL\n👤 65 ⚙️ TheRARBG')]);
  assert.equal(sizeOf(out), undefined);
});

test('release de um arquivo só: size é o próprio 💾', () => {
  const [out] = applyNoticeOrigin([withTitle('True Detective S01E01 720p AMZN WEB DL\n👤 27 💾 1.86 GB ⚙️ LimeTorrents')]);
  assert.equal(sizeOf(out), '1.86 GB');
});

test('a marca interna do fallback continua saindo junto', () => {
  const [out] = applyNoticeOrigin([{ ...withTitle(PACK_TITLE), _fromFallback: true } as Stream]);
  assert.equal((out as Stream & { _fromFallback?: boolean })._fromFallback, undefined);
  assert.equal(sizeOf(out), '1.55 GB');
});
