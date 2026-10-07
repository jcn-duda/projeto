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

// CASO REAL (hash c229…, medido 2026-10-07): título SILÊNCIOSO (sem faixa,
// sem temporada, sem episódio), 💾 do tracker = total do pack e fsz com os 42
// capítulos. O título não declara episódio nenhum: o total não está provado
// ser o dele — com lista de arquivos, o Cap 001 medido (825.763.824 B) vence.
const CAP001 = 825_763_824;
const tituloSilencioso = 'Jesus Novela [720p HDTV DUBLADO]\n👤 5 💾 30.00 GB ⚙️ Apache Torrent';
const streamSilencioso = () => ({
  name: 'DUB BR 720p',
  title: tituloSilencioso,
  infoHash: JESUS,
  _br: true,
  _dubbed: false,
  // Byte EXATO declarado pelo Apache no idx:v14 (32212254720 = 30,00 GiB;
  // o relato anterior citava "30.71 GB", rótulo impreciso — honesto é 30.00 GB).
  _bytes: 32212254720,
}) as Stream;

const fszCapitulos = () => {
  const files = Array.from({ length: 42 }, (_, i) => ({
    path: `Jesus Novela [720p HDTV DUBLADO]/Cap 001 ao 042/${String(i + 1).padStart(3, '0')} - Capitulo.mp4`,
    size: 600_000_000 + i,
  }));
  files[0] = { ...files[0], size: CAP001 };
  return files;
};

test('título silencioso com lista de arquivos: o capítulo medido vence o total', () => {
  clearFileSizes();
  recordFileSizes(JESUS, fszCapitulos());
  const [out] = annotateEpisodeSizes([streamSilencioso()], { season: 1, episode: 1, meta: null });
  assert.match(titleOf(out), /💾 787\.51 MB 📦 pack 30\.00 GB/, 'o 💾 passa a ser o Cap 001 medido pelo basename');
  assert.equal(streamSizeLabel(titleOf(out)), '787.51 MB', 'o chip é o capítulo, não o pack');
  assert.equal((out as Stream & { _packBytes?: number })._packBytes, undefined, 'o total fica na marca 📦 pack do título');
  assert.equal((out as Stream & { _br?: boolean })._br, true, 'campos internos sobrevivem');
  clearFileSizes();
});

test('título silencioso sem lista de arquivos: o total do tracker sai da linha', () => {
  clearFileSizes();
  const [out] = annotateEpisodeSizes([streamSilencioso()], { season: 1, episode: 1, meta: null });
  assert.doesNotMatch(titleOf(out), /💾|30\.00 GB/, 'total não provado não fica em canal nenhum');
  assert.equal(streamSizeLabel(titleOf(out)), null);
  clearFileSizes();
});

test('reanotação do cache: silencioso que perdeu o total ganha o 💾 medido na leitura seguinte', () => {
  clearFileSizes();
  const [primeira] = annotateEpisodeSizes([streamSilencioso()], { season: 1, episode: 1, meta: null });
  assert.doesNotMatch(titleOf(primeira), /💾/);
  // A lista de arquivos chega DEPOIS (checagem, play): a passada seguinte mede.
  recordFileSizes(JESUS, fszCapitulos());
  const [segunda] = annotateEpisodeSizes([primeira], { season: 1, episode: 1, meta: null });
  assert.match(titleOf(segunda), /👤 5 💾 787\.51 MB ⚙️ Apache Torrent$/, 'fillMissingSizes mede o episódio na volta');
  clearFileSizes();
});
