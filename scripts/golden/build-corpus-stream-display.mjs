#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-stream-display.json`: casos de `streamDisplayName`
 * (`src/utils/stream-display.ts`). Gerador descartável; o arquivo commitado é a
 * fonte (o dump stream-display lê só ele).
 *
 * O corpus é a MATRIZ de entradas que o oráculo roda contra o `dist` real:
 *  - `config.style`     ∈ default | compact | full   (default = env AUSENTE)
 *  - `config.showSource`∈ default | true | false      (default = env AUSENTE)
 *  - `input` (string JSON) = `{ opts, userOpts? }`
 *      `opts`     → objeto passado a streamDisplayName;
 *      `userOpts` → config crua da URL (chaves CURTAS do SCHEMA do runtime),
 *                   aplicada pelo oráculo com `runtime.normalize` + `run` REAIS.
 *
 * Por que `config` é dimensão separada: o módulo lê `config.streamNameStyle` /
 * `config.streamNameShowSource` no IMPORT (process.env congelado). Um child novo
 * por grupo de config é a única forma de exercitar default/full/hideSource — o
 * dump agrupa por `config` e conta os grupos no manifest.
 *
 * `input` sai de `JSON.stringify` com ordem de chave canônica (OPT_KEYS), então
 * o gerador é determinístico. Nunca inclui segredo/credencial.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-stream-display.json');

const OPT_KEYS = ['title', 'quality', 'audio', 'source', 'edition', 'tracker', 'isBr', 'seeders', 'fromFallback', 'style', 'showSource'];
const optsObj = (o) => { const r = {}; for (const k of OPT_KEYS) if (o[k] !== undefined) r[k] = o[k]; return r; };

const cases = [];
let n = 0;
const D = (style, showSource) => ({ style: style ?? 'default', showSource: showSource ?? 'default' });
const DEFAULT_CFG = D();
const FULL = D('full');
const FULL_NO_SRC = D('full', 'false');
const NO_SRC = D('default', 'false');

function add(note, opts, { config = DEFAULT_CFG, userOpts } = {}) {
  n += 1;
  const payload = userOpts === undefined ? { opts: optsObj(opts) } : { opts: optsObj(opts), userOpts };
  cases.push({
    id: `sd-${String(n).padStart(3, '0')}`,
    config: { style: config.style, showSource: config.showSource },
    input: JSON.stringify(payload),
    note,
  });
}

// --- Resolução (balde DUAL / UNKNOWN sem chip / SD) --------------------------
for (const quality of [undefined, '', 'sem resolução', '2160p', '4K', '1080p', '720p', '480p', 'SD', '576p', 'UHD', 'HD']) {
  add(`quality=${JSON.stringify(quality)}`, { title: 'Filme Teste', quality, tracker: 'TorrentDosFilmes', seeders: 12 });
}

// --- Áudio: chip compacto + prova PT do DUAL --------------------------------
for (const audio of ['Dublado', 'Legendado', 'Dual', 'Nacional', 'DUAL', 'Multi', 'Comentário', '']) {
  add(`audio=${JSON.stringify(audio)} sem prova PT`, { title: 'Filme Teste 1080p', audio, seeders: 3 });
}
for (const audio of ['Dublado', 'Legendado', 'Dual', 'Nacional']) {
  add(`audio=${JSON.stringify(audio)} isBr=true`, { title: 'Movie 2020', quality: '1080p', audio, isBr: true, seeders: 4 });
}
add('Dual com prova por título dublado', { title: 'Ação Dublada 1080p', audio: 'Dual', seeders: 5 });
add('Dual com prova por título dublado (2)', { title: 'Filme Dublado 1080p', audio: 'Dual', seeders: 5 });
add('Dual EN sem prova PT', { title: 'Movie Dual Audio YTS 1080p', audio: 'Dual', seeders: 9 });
add('Dual com sinal PT (áudio)', { title: 'O Filme DUAL ÁUDIO 1080p', audio: 'Dual', seeders: 9 });
add('Dual + isBr prova', { title: 'Movie 2020', quality: '1080p', audio: 'Dual', isBr: true, seeders: 2 });

// --- Corte do filme (edition) -------------------------------------------------
for (const edition of ['DC', 'Extended', 'IMAX', 'Cinema', 'Uncut', 'Alt.Ver', 'Alt.End', 'Remaster', 'Versão Estendida', '']) {
  add(`edition=${JSON.stringify(edition)}`, { title: 'Filme Teste', quality: '1080p', source: 'BluRay', edition, seeders: 1 });
}

// --- Fonte (source) -----------------------------------------------------------
for (const source of ['BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'CAM', 'TV', '']) {
  add(`source=${JSON.stringify(source)}`, { title: 'Filme Teste', quality: '1080p', source, seeders: 1 });
}

// --- isBr ---------------------------------------------------------------------
add('isBr true com nome informativo', { title: 'Filme BR', quality: '1080p', isBr: true, seeders: 6 });
add('isBr false com nome informativo', { title: 'Filme BR', quality: '1080p', isBr: false, seeders: 6 });
add('isBr true sem qualidade (BR puro)', { title: 'Filme BR', isBr: true, seeders: 6 });
add('isBr false sem qualidade', { title: 'Filme BR', isBr: false, seeders: 6 });

// --- Seeders / fallback do acervo (📦 / ~) -----------------------------------
add('seeders 0 sem chip', { title: 'Filme', quality: '1080p', seeders: 0 });
add('seeders 1', { title: 'Filme', quality: '1080p', seeders: 1 });
add('seeders 42', { title: 'Filme', quality: '1080p', seeders: 42 });
add('seeders 1000', { title: 'Filme', quality: '1080p', seeders: 1000 });
add('seeders string numérica', { title: 'Filme', quality: '1080p', seeders: '7' });
add('seeders negativa', { title: 'Filme', quality: '1080p', seeders: -3 });
add('fromFallback sem seeders', { title: 'Filme', quality: '1080p', fromFallback: true, seeders: 0, tracker: 'TorrentDosFilmes' });
add('fromFallback com seeders', { title: 'Filme', quality: '1080p', fromFallback: true, seeders: 8, tracker: 'TorrentDosFilmes' });
add('fromFallback sem detalhe nenhum', { title: 'Filme', fromFallback: true, seeders: 0 });
add('fromFallback sem detalhe com seeders', { title: 'Filme', fromFallback: true, seeders: 4 });

// --- Detalhe vazio → o título volta a valer ----------------------------------
add('só título', { title: 'Meu Filme Sem Info' });
add('só título + tracker', { title: 'Meu Filme Sem Info', tracker: 'TorrentDosFilmes' });
add('só título + seeders', { title: 'Meu Filme Sem Info', seeders: 5 });
add('só detalhe sem título', { quality: '1080p', seeders: 5 });
add('nem título nem detalhe', {});
add('detalhe sem título só áudio', { audio: 'Dublado' });

// --- Tracker (compactTracker: TLD, torrent(s), camelCase, separador, BOM, 14) -
const TRACKERS = [
  '', 'TorrentDosFilmes', 'ComandoTorrents', 'NerdFilmesTorrent', 'kickasstorrents.com',
  'kickasstorrents.com.br', 'Torrent9', 'abcdefghijklmn', 'abcdefghijklmno', 'meusite_torrent',
  'Site-Muito-Longo-Aqui', 'A_B_SiteSuperLongo', '  FilmesTorrent  ', '\uFEFFNerdFilmesTorrent',
  'Curt😀', 'filme😀', 'AAAAABBBBBCCC😀DD', 'abcdefghijklm😀nop', '\uFEFFAAAAABBBBBCCC😀.com',
  'AAAAABBBBBCCC\u{2A6E0}DD', 'ThePirateFilmes', 'HDTorrents', 'BluDV',
];
for (const tracker of TRACKERS) {
  add(`tracker=${JSON.stringify(tracker)}`, { title: 'Filme', quality: '1080p', tracker, seeders: 2 });
}

// --- showSource / style por PARÂMETRO (precede config e userOpts) -------------
add('param showSource=false', { title: 'Filme', quality: '1080p', tracker: 'TorrentDosFilmes', seeders: 5, showSource: false });
add('param showSource=true', { title: 'Filme', quality: '1080p', tracker: 'TorrentDosFilmes', seeders: 5, showSource: true });
add('param showSource=null (false explícito)', { title: 'Filme', quality: '1080p', tracker: 'TorrentDosFilmes', seeders: 5, showSource: null });
add('param style vazio cai no config', { title: 'Filme', quality: '1080p', tracker: 'TorrentDosFilmes', seeders: 5, style: '' });
add('param style null cai no config', { title: 'Filme', quality: '1080p', tracker: 'TorrentDosFilmes', seeders: 5, style: null });
add('param style=full compact override', { title: 'Filme', quality: '1080p', tracker: 'TorrentDosFilmes', seeders: 5, style: 'full' });

// --- config full (env STREAM_NAME_STYLE=full) --------------------------------
const configRepresentative = [
  ['kitchen sink', { title: 'Filme Teste 1080p', quality: '1080p', source: 'WEB-DL', audio: 'Dublado', tracker: 'TorrentDosFilmes', seeders: 12 }],
  ['unknown quality', { title: 'Filme', quality: 'sem resolução', tracker: 'TorrentDosFilmes', seeders: 3 }],
  ['só título', { title: 'Meu Filme' }],
  ['título vazio com detalhe', { quality: '2160p' }],
  ['sem nada', {}],
  ['fallback', { title: 'Filme', quality: '1080p', fromFallback: true, seeders: 6, tracker: 'TorrentDosFilmes' }],
  ['isBr', { title: 'Filme BR', quality: '1080p', isBr: true, seeders: 2 }],
];
for (const [label, opts] of configRepresentative) add(`config full: ${label}`, opts, { config: FULL });

// --- config showSource=false -------------------------------------------------
const noSourceRepresentative = [
  ['tracker + seeders', { title: 'Filme', quality: '1080p', tracker: 'TorrentDosFilmes', seeders: 5 }],
  ['só tracker', { title: 'Filme', quality: '1080p', tracker: 'TorrentDosFilmes' }],
  ['tracker + título (detalhe vazio)', { title: 'Filme', tracker: 'TorrentDosFilmes' }],
  ['fallback', { title: 'Filme', quality: '1080p', fromFallback: true, seeders: 3, tracker: 'TorrentDosFilmes' }],
];
for (const [label, opts] of noSourceRepresentative) add(`config hideSource: ${label}`, opts, { config: NO_SRC });
for (const [label, opts] of configRepresentative.slice(0, 3)) add(`config full+hideSource: ${label}`, opts, { config: FULL_NO_SRC });

// --- userOpts (config da URL) via runtime.normalize + run REAIS --------------
const K = { title: 'Filme', quality: '1080p', tracker: 'TorrentDosFilmes', seeders: 9 };
add('userOpts ns=full sobre default', { ...K }, { userOpts: { ns: 'full' } });
add('userOpts ns=compact sobre default', { ...K }, { userOpts: { ns: 'compact' } });
add('userOpts ns=full st=false', { ...K }, { userOpts: { ns: 'full', st: false } });
add('userOpts st=false', { ...K }, { userOpts: { st: false } });
add('userOpts st=true', { ...K }, { userOpts: { st: true } });
add('userOpts ns vazio cai no config', { ...K }, { userOpts: { ns: '' } });
add('userOpts ns=full + param style=compact (param vence)', { ...K, style: 'compact' }, { userOpts: { ns: 'full' } });
add('userOpts ns=full + param style vazio (userOpts vence)', { ...K, style: '' }, { userOpts: { ns: 'full' } });
add('userOpts st=false + param showSource=true (param vence)', { ...K, showSource: true }, { userOpts: { st: false } });
add('userOpts st=true + param showSource=false (param vence)', { ...K, showSource: false }, { userOpts: { st: true } });
add('userOpts st=true + param showSource=null (null vence)', { ...K, showSource: null }, { userOpts: { st: true } });
add('config full + userOpts ns=compact', { ...K }, { config: FULL, userOpts: { ns: 'compact' } });
add('config full + userOpts ns vazio (config vence)', { ...K }, { config: FULL, userOpts: { ns: '' } });
add('config hideSource + userOpts st=true', { ...K }, { config: NO_SRC, userOpts: { st: true } });
add('config full+hideSource + userOpts ns=compact st=true', { ...K }, { config: FULL_NO_SRC, userOpts: { ns: 'compact', st: true } });

const groups = [...new Set(cases.map((c) => `${c.config.style}|${c.config.showSource}`))].sort();
writeFileSync(
  OUT,
  `${JSON.stringify({
    version: 'corpus-stream-display/1',
    note: 'Entradas de streamDisplayName (src/utils/stream-display.ts). config = env do grupo (default = variável AUSENTE). input = { opts, userOpts? }; userOpts usa as chaves curtas do SCHEMA do runtime. expectedJson do golden é o contrato para o leitor Rust (lone surrogate de compactTracker não entra no campo expected).',
    groups,
    cases,
  }, null, 2)}\n`,
);
console.log(`[corpus] ${cases.length} casos em ${groups.length} grupos: ${groups.join(', ')}`);
