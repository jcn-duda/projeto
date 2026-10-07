// O TOTAL de um torrent multi-episódio fora dos canais que o Power Movie lê.
//
// Motivo medido (Jesus tt8747430 S01E01 pelo Apache, 2026-10-07): o post BR
// publica o tamanho no próprio título ("…Temporada Completa 30GB") e o tamanho
// do Jackett vem sentinela (1 KB → sem 💾) — sem `size` na resposta, o chip do
// app mostrava 30 GB lido do TEXTO (`_resolveStreamSize` lê o primeiro
// "N GB" de description+title+name quando não há `size` nem `videoSize`).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { annotateEpisodeSizes, streamSizeLabel } from '../src/providers/episode-size.js';
import { recordFileSizes, clearFileSizes } from '../src/debrid/file-sizes.js';
import type { Stream } from '../types/domain.js';

const GB = 1024 ** 3;
const JESUS = 'e7'.repeat(20);
const jesusStream = (title = 'Jesus 1ª Temporada Completa Dual Audio 30GB 720p\n👤 3 ⚙️ Apache Torrent') => ({
  name: 'DUB BR 720p',
  title,
  infoHash: JESUS,
}) as Stream;

const titleOf = (stream: Stream | null | undefined) => String(stream?.title || '');

test('faixa de novela sem medida: o total sai do texto e nenhum size é publicado', () => {
  clearFileSizes();
  const [out] = annotateEpisodeSizes([jesusStream()], { season: 1, episode: 1, meta: { episodes: { 1: 154 } } });
  assert.doesNotMatch(titleOf(out), /💾|30 ?GB/i, 'o total da temporada não fica em canal nenhum');
  assert.match(titleOf(out), /👤 3 ⚙️ Apache Torrent$/);
  assert.equal(streamSizeLabel(titleOf(out)), null, 'sem 💾, a resposta não publica size');
  assert.equal((out as Stream & { _packBytes?: number })._packBytes, 30 * GB, 'o total lido do post segue interno');
  clearFileSizes();
});

test('faixa de novela com lista de arquivos: o capítulo exato vence, sem média', () => {
  clearFileSizes();
  recordFileSizes(JESUS, [
    { path: 'Jesus/T01E01 - O Batismo.mkv', size: 300 * 1024 ** 2 },
    { path: 'Jesus/T01E02 - Continuação.mkv', size: 290 * 1024 ** 2 },
  ]);
  const comTotal = jesusStream('Jesus Capítulo 001 ao 154 Dublado 720p\n👤 3 💾 30.00 GB ⚙️ Apache Torrent');
  const [out] = annotateEpisodeSizes([comTotal], { season: 1, episode: 1, meta: { episodes: { 1: 154 } } });
  assert.match(titleOf(out), /💾 300\.00 MB 📦 pack 30\.00 GB/, 'medida exata do capítulo; faixa parcial não tem média');
  assert.doesNotMatch(titleOf(out), /média/);
  assert.equal(streamSizeLabel(titleOf(out)), '300.00 MB', 'o chip é o capítulo, não a temporada');
  clearFileSizes();
});

test('pack anotado não passa pelo guard: o 💾 do episódio e o total anotado ficam', () => {
  clearFileSizes();
  const anotado = jesusStream('Jesus Temporada Completa 720p\n👤 3 💾 195.00 MB 📦 pack 30.00 GB (média) ⚙️ Apache Torrent');
  const [out] = annotateEpisodeSizes([anotado], { season: 1, episode: 1, meta: { episodes: { 1: 154 } } });
  assert.equal(titleOf(out), titleOf(anotado), 'anotação existente é intocada');
  assert.equal(streamSizeLabel(titleOf(out)), '195.00 MB');
  clearFileSizes();
});
