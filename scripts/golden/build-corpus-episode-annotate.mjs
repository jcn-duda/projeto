#!/usr/bin/env node
/**
 * Corpus do golden `episode-annotate` (Parte 5 da migração Rust): os núcleos
 * PUROS de `src/providers/episode-size.ts` — `episodesCovered`,
 * `exactEpisodeBytes`, `annotatePackSizes`, `annotateMovieSizes`,
 * `fillMissingSizes` e `fillTorrentTotals`.
 *
 * Casos derivados de `test/episode-size.test.ts` e
 * `test/torrent-total-size.test.ts` (cenários medidos ao vivo) mais variações
 * de fronteira. Determinístico: sem timestamp. Saída:
 * `scripts/golden/corpus-episode-annotate.json`.
 *
 * `input` de cada caso é JSON com `op`:
 * - `covered` — { title, season, meta:{temporada:episódios} }
 * - `exact`   — { infoHash, season, episode, files:[{path,size}] }
 * - `pack`    — { season, episode, meta, streams, files:{hash:[files]} }
 * - `movie`   — { work:{n,y}, streams, files }
 * - `fill`    — { season, episode, work, streams, files }
 * - `totals`  — { streams, files, totals:{hash:bytes} }
 *
 * Streams entram com os campos que os núcleos leem/escrevem (`title`, `name`,
 * `infoHash`, `_indexer`, `_multiWork`, `_multiWorkAdmitted`, `_size`) — o
 * oráculo popula o memo `fsz`/`tsz` do dist e mede a função real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = 'scripts/golden/corpus-episode-annotate.json';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const PACK = 'a1'.repeat(20);
const EPISODE = 'b2'.repeat(20);
const COLECAO = 'b8'.repeat(20);
const SEM_TAMANHO = 'c3'.repeat(20);
const TIO = 'a7'.repeat(20);
const EARL = 'e5'.repeat(20);
const RD = 'dd'.repeat(20);
const CACHED = 'aa'.repeat(20);

const stream = (infoHash, title, extra = {}) => ({
  name: '[AD⚡] 1080p',
  title,
  infoHash,
  ...extra,
});

const GOLIATH_TITLE = 'Goliath.S03.2160p.AMZN.WEB-DL.x265.10bit.HDR.DDP5.1-SKGTV\n👤 10 💾 41.67 GB ⚙️ thepiratebay';
const EARL_TITLE = 'My Name Is Earl (2005) Season 1 4 S01 S04 (1080p Mixed x265) REPACK\n👤 80 💾 70.36 GB ⚙️ LimeTorrents';
const SILIGNCOSO = 'True Detective [720p BLU-RAY DUAL]\n👤 1 💾 3.30 GB ⚙️ Apache Torrent';
const COLECAO_TITLE = 'FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR\n👤 1 💾 22.45 GB ⚙️ AllDebrid';
const SEM_TAMANHO_TITLE = 'Tira da Pesada (1984) BluRay 5.1 [1080p BLURAY DUBLADO opção 2]\n👤 1 ⚙️ torrentdosfilmesv2';
const KB_TITLE = 'True.Detective.S01E01.The.Long.Bright.Dark.1080p.HEVC.x265-MeGusta\n👤 87 💾 65.95 KB ⚙️ TheRARBG';
const SEM_MARCA_TITLE = 'True Detective [720p BLU-RAY DUAL]\n👤 1 ⚙️ Apache Torrent';
const WORK_ST = { n: ['Star Trek', 'Jornada nas Estrelas'], y: 2009 };

const goliathFiles = [
  { path: 'Goliath.S03/Goliath.S03E01.2160p.mkv', size: 5.1 * GB },
  { path: 'Goliath.S03/Goliath.S03E03.2160p.mkv', size: 4.9 * GB },
  { path: 'Goliath.S03/Sample/goliath.s03e03.sample.mkv', size: 60 * MB },
];
const colecaoFiles = [
  { path: 'Star Trek/Star.Trek.2009.1080p.BluRay.DUAL.mkv', size: 2.1 * GB },
  { path: 'Star Trek/Star.Trek.Into.Darkness.2013.1080p.BluRay.DUAL.mkv', size: 2.4 * GB },
  { path: 'Star Trek/Star.Trek.Beyond.2016.1080p.BluRay.DUAL.mkv', size: 2.3 * GB },
];

const cases = [];
const add = (id, op, input) => cases.push({ id, input: JSON.stringify({ op, ...input }) });

// ── episodesCovered ────────────────────────────────────────────────────────
add('covered-pack-multi-temporada', 'covered', {
  title: EARL_TITLE, season: 1, meta: { 1: 24, 2: 23, 3: 22, 4: 27 },
});
add('covered-multi-temporada-sem-contagem', 'covered', {
  title: EARL_TITLE, season: 1, meta: { 1: 24 },
});
add('covered-temporada-unica', 'covered', {
  title: GOLIATH_TITLE, season: 3, meta: { 3: 8 },
});
add('covered-serie-completa', 'covered', {
  title: 'A Serie Completa Todas as Temporadas 1080p\n👤 5 💾 70 GB', season: 2, meta: { 1: 8, 3: 3 },
});
add('covered-serie-completa-vazia', 'covered', {
  title: 'A Serie Completa Todas as Temporadas 1080p\n👤 5 💾 70 GB', season: 2, meta: {},
});
add('covered-meta-zero', 'covered', {
  title: GOLIATH_TITLE, season: 3, meta: { 3: 0 },
});
add('covered-faixa-de-capitulos', 'covered', {
  title: 'Novela Capítulo 001 ao 010 720p\n👤 2 💾 3.30 GB', season: 1, meta: { 1: 154 },
});
add('covered-episodio-avulso', 'covered', {
  title: 'Goliath S03E03 Good Morning Central Valley 1080p\n👤 43 💾 2.19 GB', season: 3, meta: { 3: 8 },
});

// ── exactEpisodeBytes ──────────────────────────────────────────────────────
add('exact-pack-episodio-e-sample', 'exact', {
  infoHash: PACK, season: 3, episode: 3, files: goliathFiles,
});
add('exact-episodio-ausente', 'exact', {
  infoHash: EPISODE, season: 1, episode: 3,
  files: [
    { path: 'Serie.S01E01.mkv', size: 1 * GB },
    { path: 'Serie.S01E02.mkv', size: 1.5 * GB },
  ],
});
add('exact-avulso-unica', 'exact', {
  infoHash: EPISODE, season: 1, episode: 2,
  files: [{ path: 'Serie.S01E02.mkv', size: 1.5 * GB }],
});
add('exact-arquivo-ambiguo', 'exact', {
  infoHash: EPISODE, season: 1, episode: 2,
  files: [
    { path: 'Serie.S01E02.CD1.mkv', size: 700 * MB },
    { path: 'Serie.S01E02.CD2.mkv', size: 690 * MB },
  ],
});
add('exact-lista-vazia', 'exact', { infoHash: EPISODE, season: 1, episode: 1, files: [] });
add('exact-sem-video', 'exact', {
  infoHash: EPISODE, season: 1, episode: 1, files: [{ path: 'leia.txt', size: 10 }],
});
add('exact-nome-sem-sxxeyy', 'exact', {
  infoHash: TIO, season: 1, episode: 1,
  files: [{ path: '01 Adim Farah.avi', size: 1.36 * GB }],
});
add('exact-weak-ep-marcador', 'exact', {
  infoHash: EPISODE, season: 2, episode: 7,
  files: [{ path: 'Serie.S02.EP 7 1080p.mkv', size: 920 * MB }],
});

// ── annotatePackSizes ──────────────────────────────────────────────────────
const packOpts = (season, episode, meta) => ({ season, episode, meta });
add('pack-exato', 'pack', {
  ...packOpts(3, 3, { 3: 8 }),
  streams: [stream(PACK, GOLIATH_TITLE, { _size: Math.round(41.67 * GB) })],
  files: { [PACK]: goliathFiles },
});
add('pack-media', 'pack', {
  ...packOpts(3, 3, { 3: 8 }),
  streams: [stream(PACK, GOLIATH_TITLE, { _size: Math.round(41.67 * GB) })],
});
add('pack-media-sem-_size', 'pack', {
  ...packOpts(3, 3, { 3: 8 }),
  streams: [stream(PACK, GOLIATH_TITLE)],
});
add('pack-media-varias-temporadas', 'pack', {
  ...packOpts(1, 1, { 1: 24, 2: 23, 3: 22, 4: 27 }),
  streams: [stream(EARL, EARL_TITLE, { _size: Math.round(70.36 * GB) })],
});
add('pack-multitemporada-sem-contagem', 'pack', {
  ...packOpts(1, 1, { 1: 24 }),
  streams: [stream(EARL, EARL_TITLE, { _size: Math.round(70.36 * GB) })],
});
add('pack-torrentio-por-arquivo', 'pack', {
  ...packOpts(1, 1, { 1: 24 }),
  streams: [stream(TIO, 'Adim Farah Season 1 720p HDTV\n01 Adim Farah.avi\n👤 1 💾 1.36 GB ⚙️ Rutracker', { _indexer: 'torrentio' })],
  files: { [TIO]: [{ path: '01 Adim Farah.avi', size: 1.36 * GB }] },
});
add('pack-sem-marcador-de-tamanho', 'pack', {
  ...packOpts(1, 1, { 1: 8 }),
  streams: [stream(RD, SEM_MARCA_TITLE, { _size: Math.round(3.3 * GB) })],
});
add('pack-avulso-fica', 'pack', {
  ...packOpts(3, 3, { 3: 8 }),
  streams: [stream(EPISODE, 'Goliath S03E03 Good Morning Central Valley 1080p AMZN WEB-DL\n👤 43 💾 2.19 GB ⚙️ kickass', { _size: Math.round(2.19 * GB) })],
});
add('pack-silencioso-medido-pelos-arquivos', 'pack', {
  ...packOpts(1, 1, { 1: 8 }),
  streams: [stream(RD, SILIGNCOSO, { _size: Math.round(3.3 * GB) })],
  files: {
    [RD]: [
      { path: 'True Detective 1ª Temporada/T01E01 - A Longa Escuridão.mkv', size: 441 * MB },
      { path: 'True Detective 1ª Temporada/T01E02 - Vendo Coisas.mkv', size: 430 * MB },
    ],
  },
});
add('pack-silencioso-sem-arquivos', 'pack', {
  ...packOpts(1, 1, { 1: 8 }),
  streams: [stream(RD, SILIGNCOSO, { _size: Math.round(3.3 * GB) })],
});
add('pack-faixa-nomeada-com-medida', 'pack', {
  ...packOpts(1, 1, { 1: 154 }),
  streams: [stream(RD, 'Novela Capítulo 001 ao 010 720p\n👤 2 💾 3.30 GB ⚙️ Apache Torrent', { _size: Math.round(3.3 * GB) })],
  files: { [RD]: [{ path: 'Novela/Cap.001-010.mkv', size: 441 * MB }] },
});
add('pack-faixa-nomeada-sem-medida', 'pack', {
  ...packOpts(1, 1, { 1: 154 }),
  streams: [stream(RD, 'Novela Capítulo 001 ao 010 720p\n👤 2 💾 3.30 GB ⚙️ Apache Torrent', { _size: Math.round(3.3 * GB) })],
});
add('pack-exato-nao-menor', 'pack', {
  ...packOpts(3, 3, { 3: 8 }),
  streams: [stream(PACK, GOLIATH_TITLE, { _size: Math.round(41.67 * GB) })],
  files: { [PACK]: [{ path: 'Goliath.S03E03.2160p.mkv', size: Math.round(41.67 * GB) }] },
});
add('pack-contagem-um', 'pack', {
  ...packOpts(3, 3, { 3: 1 }),
  streams: [stream(PACK, GOLIATH_TITLE, { _size: Math.round(41.67 * GB) })],
});
add('pack-ja-anotado', 'pack', {
  ...packOpts(1, 1, { 1: 8 }),
  streams: [stream(RD, 'True.Detective.2014.S01.1080p.BDRip.x265-ToVaR\n👤 1 💾 1.55 GB 📦 pack 12.41 GB (média) ⚙️ nerdfilmes')],
});
add('pack-titulo-sem-hash', 'pack', {
  ...packOpts(3, 3, { 3: 8 }),
  streams: [{ name: '[AD⚡] 4K WEB-DL', title: GOLIATH_TITLE, _size: Math.round(41.67 * GB) }],
});

// ── annotateMovieSizes ─────────────────────────────────────────────────────
add('movie-exato', 'movie', {
  work: WORK_ST,
  streams: [stream(COLECAO, COLECAO_TITLE, { _multiWork: true, _multiWorkAdmitted: true })],
  files: { [COLECAO]: colecaoFiles },
});
add('movie-sem-arquivos', 'movie', {
  work: WORK_ST,
  streams: [stream(COLECAO, COLECAO_TITLE, { _multiWork: true })],
});
add('movie-nao-menor', 'movie', {
  work: WORK_ST,
  streams: [stream(COLECAO, COLECAO_TITLE, { _multiWork: true, _size: Math.round(2.1 * GB) })],
  files: { [COLECAO]: [colecaoFiles[0]] },
});
add('movie-sem-obra', 'movie', {
  work: { n: [], y: null },
  streams: [stream(COLECAO, COLECAO_TITLE, { _multiWork: true })],
  files: { [COLECAO]: colecaoFiles },
});
add('movie-avulso-fica', 'movie', {
  work: WORK_ST,
  streams: [stream(COLECAO, COLECAO_TITLE, { _multiWork: false })],
  files: { [COLECAO]: colecaoFiles },
});
add('movie-sem-marcador', 'movie', {
  work: WORK_ST,
  streams: [stream(COLECAO, 'FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-PTBR\n👤 1 ⚙️ AllDebrid', { _multiWork: true })],
  files: { [COLECAO]: colecaoFiles },
});
add('movie-ja-anotado', 'movie', {
  work: WORK_ST,
  streams: [{ name: '[AD⚡] DUB BR', title: COLECAO_TITLE, infoHash: COLECAO, _multiWork: true, _packBytes: Math.round(22.45 * GB) }],
  files: { [COLECAO]: colecaoFiles },
});
add('movie-torrentio-fica', 'movie', {
  work: WORK_ST,
  streams: [stream(COLECAO, COLECAO_TITLE, { _multiWork: true, _indexer: 'torrentio' })],
  files: { [COLECAO]: colecaoFiles },
});

// ── fillMissingSizes ───────────────────────────────────────────────────────
add('fill-filme-com-arquivos', 'fill', {
  season: null, episode: null, work: null,
  streams: [stream(SEM_TAMANHO, SEM_TAMANHO_TITLE)],
  files: {
    [SEM_TAMANHO]: [
      { path: 'Tira.da.Pesada.1984.1080p.mkv', size: 2.34 * GB },
      { path: 'Sample/sample.mkv', size: 50 * MB },
    ],
  },
});
add('fill-episodio-com-arquivos', 'fill', {
  season: 1, episode: 2, work: null,
  streams: [stream(SEM_TAMANHO, 'Serie S01E02 1080p DUBLADO\n👤 ~ ⚙️ comandotorrents')],
  files: {
    [SEM_TAMANHO]: [
      { path: 'Serie.S01E01.mkv', size: 1 * GB },
      { path: 'Serie.S01E02.mkv', size: 1.5 * GB },
    ],
  },
});
add('fill-sem-arquivos', 'fill', {
  season: null, episode: null, work: null,
  streams: [stream(SEM_TAMANHO, SEM_TAMANHO_TITLE)],
});
add('fill-episodio-null-maior-video', 'fill', {
  season: 1, episode: null, work: null,
  streams: [stream(SEM_TAMANHO, 'Serie S01 1080p DUBLADO\n👤 ~ ⚙️ comandotorrents')],
  files: {
    [SEM_TAMANHO]: [
      { path: 'Serie.S01E01.mkv', size: 1 * GB },
      { path: 'Serie.S01E02.mkv', size: 1.5 * GB },
    ],
  },
});
add('fill-colecao-sem-obra', 'fill', {
  season: null, episode: null, work: null,
  streams: [stream(SEM_TAMANHO, SEM_TAMANHO_TITLE, { _multiWork: true })],
  files: {
    [SEM_TAMANHO]: [
      { path: 'Filme.1.mkv', size: 3 * GB },
      { path: 'Filme.2.mkv', size: 4 * GB },
    ],
  },
});
add('fill-colecao-com-obra', 'fill', {
  season: null, episode: null, work: WORK_ST,
  streams: [stream(COLECAO, 'FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR\n👤 1 ⚙️ AllDebrid', { _multiWork: true })],
  files: { [COLECAO]: colecaoFiles },
});
add('fill-ja-tem-tamanho', 'fill', {
  season: null, episode: null, work: null,
  streams: [stream(EPISODE, 'Goliath S03E03 1080p\n👤 43 💾 2.19 GB ⚙️ kickass')],
  files: { [EPISODE]: [{ path: 'Goliath.S03E03.mkv', size: 5 * GB }] },
});
add('fill-sem-seeder', 'fill', {
  season: null, episode: null, work: null,
  streams: [stream(SEM_TAMANHO, 'Tira da Pesada (1984) [1080p BLURAY DUBLADO opção 2]')],
  files: { [SEM_TAMANHO]: [{ path: 'Tira.da.Pesada.1984.1080p.mkv', size: 2.34 * GB }] },
});
add('fill-sem-hash', 'fill', {
  season: null, episode: null, work: null,
  streams: [{ name: '[AD⚡] 1080p', title: SEM_TAMANHO_TITLE }],
  files: { [SEM_TAMANHO]: [{ path: 'Tira.da.Pesada.1984.1080p.mkv', size: 2.34 * GB }] },
});

// ── fillTorrentTotals ──────────────────────────────────────────────────────
add('totals-sem-tamanho-ganha-total', 'totals', {
  streams: [stream(CACHED, 'True Detective S01E01 The Long Bright Dark 1080p AMZN WEB-DL\n👤 65 ⚙️ TheRARBG')],
  totals: { [CACHED]: Math.round(4.22 * GB) },
});
add('totals-kb-trocado', 'totals', {
  streams: [stream(CACHED, KB_TITLE)],
  totals: { [CACHED]: 647765771 },
});
add('totals-pack-total-vira-entrada-da-media', 'totals', {
  streams: [stream(RD, 'True.Detective.2014.S01.1080p.BDRip.x265-ToVaR\n👤 1 ⚙️ nerdfilmes')],
  totals: { [RD]: Math.round(12.41 * GB) },
});
add('totals-real-nao-tocado', 'totals', {
  streams: [stream(CACHED, 'True Detective S01E01 720p AMZN WEB DL\n👤 27 💾 1.86 GB ⚙️ LimeTorrents')],
  totals: { [CACHED]: 900 * MB },
});
add('totals-com-fsz-kb-sai', 'totals', {
  streams: [stream(CACHED, KB_TITLE)],
  files: { [CACHED]: [{ path: 'True.Detective.S01E01.mkv', size: 600 * MB }] },
  totals: { [CACHED]: 647765771 },
});
add('totals-com-fsz-sem-tamanho-fica', 'totals', {
  streams: [stream(RD, SEM_MARCA_TITLE)],
  files: {
    [RD]: [
      { path: 'True Detective 1ª Temporada/T01E01.mkv', size: 441 * MB },
      { path: 'True Detective 1ª Temporada/T01E02.mkv', size: 430 * MB },
    ],
  },
  totals: { [RD]: Math.round(3.3 * GB) },
});
add('totals-sem-total', 'totals', {
  streams: [stream(CACHED, 'True Detective S01E01 1080p\n👤 65 ⚙️ TheRARBG')],
});
add('totals-post-silencioso', 'totals', {
  streams: [stream(RD, SEM_MARCA_TITLE)],
  totals: { [RD]: Math.round(3.3 * GB) },
});
add('totals-faixa-de-capitulos', 'totals', {
  streams: [stream(RD, 'Novela Capítulo 001 ao 010 720p\n👤 2 ⚙️ Apache Torrent')],
  totals: { [RD]: Math.round(3.3 * GB) },
});
add('totals-sem-hash', 'totals', {
  streams: [{ name: '[AD⚡] 1080p', title: 'True Detective S01E01\n👤 65 ⚙️ TheRARBG' }],
  totals: { [CACHED]: Math.round(4.22 * GB) },
});
add('totals-kb-no-fim-do-titulo', 'totals', {
  streams: [stream(CACHED, 'Release 1080p\n👤 87 💾 65.95 KB')],
  totals: { [CACHED]: 647765771 },
});
add('totals-zero', 'totals', {
  streams: [stream(CACHED, 'True Detective S01E01 1080p\n👤 65 ⚙️ TheRARBG')],
  totals: { [CACHED]: 0 },
});

const body = JSON.stringify({
  cases,
  config: {
    note: 'Parte 5 da migração Rust — núcleos puros de src/providers/episode-size.ts.',
    ops: ['covered', 'exact', 'pack', 'movie', 'fill', 'totals'],
  },
}, null, 2);

fs.writeFileSync(path.join(REPO, OUT), `${body}\n`);
console.log(`[corpus] gerado: ${OUT} (${cases.length} casos)`);
