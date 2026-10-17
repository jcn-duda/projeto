#!/usr/bin/env node
/**
 * Construtor do corpus do golden `search-pool-coverage` (cobertura por pool).
 *
 * Cada `input` é uma STRING JSON: `{op, ...}` com `op` ∈ `pool` | `idx`.
 *
 * - `pool` → `poolCovered(items, {season, requireDubbed})`. `minSeeders` é o
 *   piso do melhor-swarm: o oráculo o aplica na config VIVA do autofetch antes
 *   da chamada (é o que o TS lê dentro da função) e o teste Rust usa o mesmo
 *   número por parâmetro.
 * - `idx` → `idxPoolCovered(releases, {season, episode})`; o oráculo devolve
 *   `{covered, packOnly}`, com `packOnly` MEDIDO pela métrica
 *   `search.idx.packOnly` (efeito real), não inferido.
 *
 * Uso: node scripts/golden/build-corpus-search-pool-coverage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts', 'golden', 'corpus-search-pool-coverage.json');

const cases = [];
const add = (id, req) => {
  cases.push({ id, input: JSON.stringify(req) });
};
const h = (c) => c.repeat(40);

// --- poolCovered -----------------------------------------------------------
add('pool-lista-vazia', { op: 'pool', items: [], minSeeders: 3 });
add('pool-br-dublado', {
  op: 'pool',
  items: [{ hash: h('a'), title: 'Filme (2024) 1080p Dublado', seeders: 0, isBr: true }],
  minSeeders: 3,
});
add('pool-br-dual-inferido', {
  op: 'pool',
  items: [{ hash: h('b'), title: 'Filme (2024) 720p Dual Áudio', seeders: 0, isBr: true }],
  minSeeders: 3,
});
add('pool-br-national-inferido', {
  op: 'pool',
  items: [{ hash: h('c'), title: 'Filme Nacional (2024) 1080p', seeders: 0, isBr: true }],
  minSeeders: 3,
});
add('pool-br-legendado-cai-no-swarm', {
  op: 'pool',
  items: [{ hash: h('d'), title: 'Filme (2024) 1080p Legendado', seeders: 0, isBr: true }],
  minSeeders: 3,
});
add('pool-swarm-com-seeders', {
  op: 'pool',
  items: [{ hash: h('e'), title: 'Movie (2024) 1080p BluRay', seeders: 42 }],
  minSeeders: 3,
});
add('pool-swarm-abaixo-do-minimo', {
  op: 'pool',
  items: [{ hash: h('f'), title: 'Movie (2024) 1080p BluRay', seeders: 2 }],
  minSeeders: 3,
});
add('pool-swarm-minimo-zero', {
  op: 'pool',
  items: [{ hash: h('0'), title: 'Movie (2024) 1080p BluRay', seeders: 2 }],
  minSeeders: 0,
});
add('pool-swarm-exatamente-no-minimo', {
  op: 'pool',
  items: [{ hash: h('1'), title: 'Movie (2024) 1080p BluRay', seeders: 3 }],
  minSeeders: 3,
});
add('pool-swarm-um-abaixo-do-minimo', {
  op: 'pool',
  items: [{ hash: h('2'), title: 'Movie (2024) 1080p BluRay', seeders: 3 }],
  minSeeders: 4,
});
add('pool-sem-hash', {
  op: 'pool',
  items: [{ title: 'Filme (2024) 1080p Dublado', seeders: 99, isBr: true }],
  minSeeders: 3,
});
add('pool-dubbed-false-manda-sobre-titulo', {
  op: 'pool',
  items: [{ hash: h('3'), title: 'Filme (2024) 1080p Dublado', seeders: 0, isBr: true, dubbed: false }],
  minSeeders: 3,
});
add('pool-dubbed-ausente-infere-do-titulo', {
  op: 'pool',
  items: [{ hash: h('3'), title: 'Filme (2024) 1080p Dublado', seeders: 0, isBr: true }],
  minSeeders: 3,
  requireDubbed: true,
});
add('pool-dubbed-true-em-global', {
  op: 'pool',
  items: [{ hash: h('4'), title: 'Movie (2024) 1080p', seeders: 0, dubbed: true }],
  minSeeders: 3,
});
add('pool-require-dubbed-so-swarm', {
  op: 'pool',
  items: [{ hash: h('5'), title: 'Movie (2024) 1080p BluRay', seeders: 50 }],
  minSeeders: 3,
  requireDubbed: true,
});
add('pool-require-dubbed-com-br', {
  op: 'pool',
  items: [{ hash: h('6'), title: 'Filme (2024) 1080p Dublado', seeders: 0, isBr: true }],
  minSeeders: 3,
  requireDubbed: true,
});
add('pool-cam-br-dublado-fora', {
  op: 'pool',
  items: [{ hash: h('7'), title: 'Filme (2024) CAM Dublado', seeders: 0, isBr: true }],
  minSeeders: 3,
});
add('pool-cam-global-fora-ate-do-swarm', {
  op: 'pool',
  items: [{ hash: h('8'), title: 'Movie (2024) CAM', seeders: 999 }],
  minSeeders: 0,
});
add('pool-titulo-pelo-name', {
  op: 'pool',
  items: [{ hash: h('9'), name: 'Filme (2024) Dublado 1080p', seeders: 0, isBr: true }],
  minSeeders: 3,
});
add('pool-titulo-pelo-Title', {
  op: 'pool',
  items: [{ hash: h('a'), Title: 'Filme (2024) Dublado 1080p', seeders: 0, isBr: true }],
  minSeeders: 3,
});
add('pool-hash-pelo-infohash', {
  op: 'pool',
  items: [{ infoHash: h('b'), title: 'Filme (2024) Dublado', seeders: 0, isBr: true }],
  minSeeders: 3,
});
add('pool-hash-pelo-magnet', {
  op: 'pool',
  items: [{
    magnet: `magnet:?xt=urn:btih:${h('c')}&dn=Filme`,
    title: 'Filme (2024) Dublado',
    seeders: 0,
    isBr: true,
  }],
  minSeeders: 3,
});
add('pool-seeders-como-string', {
  op: 'pool',
  items: [{ hash: h('d'), title: 'Movie (2024) 1080p', seeders: '5' }],
  minSeeders: 3,
});
add('pool-seeders-pascal-case', {
  op: 'pool',
  items: [{ hash: h('e'), title: 'Movie (2024) 1080p', Seeders: 7 }],
  minSeeders: 3,
});
add('pool-seeders-underscore', {
  op: 'pool',
  items: [{ hash: h('f'), title: 'Movie (2024) 1080p', _seeders: 8 }],
  minSeeders: 3,
});
add('pool-dubbed-null-presente-nao-cai-no-titulo', {
  op: 'pool',
  items: [{ hash: h('a'), title: 'Filme (2024) 1080p Dublado', seeders: 5, isBr: true, dubbed: null }],
  minSeeders: 3,
  requireDubbed: true,
});
add('pool-dubbed-ausente-cai-no-titulo', {
  op: 'pool',
  items: [{ hash: h('a'), title: 'Filme (2024) 1080p Dublado', seeders: 5, isBr: true }],
  minSeeders: 3,
  requireDubbed: true,
});
add('pool-dubbed-null-presente-sem-seeders', {
  op: 'pool',
  items: [{ hash: h('b'), title: 'Filme (2024) 1080p Dublado', seeders: 0, isBr: true, dubbed: null }],
  minSeeders: 3,
});
add('pool-global-evidencia-pt', {
  op: 'pool',
  items: [{ hash: h('c'), title: 'Movie (2024) DUBLADO 1080p', seeders: 0 }],
  minSeeders: 3,
});
add('pool-global-dual-audio', {
  op: 'pool',
  items: [{ hash: h('d'), title: 'Movie (2024) 1080p Dual Áudio', seeders: 0 }],
  minSeeders: 3,
});
add('pool-titulo-vazio-com-hash', {
  op: 'pool',
  items: [{ hash: h('e'), title: '   ', seeders: 99 }],
  minSeeders: 3,
});
add('pool-mistura-pools-vence-br', {
  op: 'pool',
  items: [
    { hash: h('f'), title: 'Movie (2024) 1080p', seeders: 100 },
    { hash: h('0'), title: 'Filme (2024) 720p Dublado', seeders: 0, isBr: true },
  ],
  minSeeders: 3,
});

// --- idxPoolCovered --------------------------------------------------------
const pack = (hash) => ({
  hash,
  title: 'True Detective 2ª Temporada (2015) [1080p DUBLADO 22.41 GB]',
  seeders: 40,
  quality: '1080p',
  isBr: true,
  dubbed: true,
});
const doEp = (hash) => ({
  hash,
  title: 'True Detective 2ª Temporada – (2015) E01 [720p DUBLADO opção 2]',
  seeders: 1,
  quality: '720p',
  isBr: true,
  dubbed: true,
});

add('idx-lista-vazia', { op: 'idx', releases: [], season: null, episode: null, minSeeders: 3 });
add('idx-so-pack-em-episodio', {
  op: 'idx', releases: [pack(h('a'))], season: 2, episode: 1, minSeeders: 3,
});
add('idx-pack-mais-episodio', {
  op: 'idx', releases: [pack(h('b')), doEp(h('c'))], season: 2, episode: 1, minSeeders: 3,
});
add('idx-episodio-errado', {
  op: 'idx', releases: [doEp(h('d'))], season: 2, episode: 7, minSeeders: 3,
});
add('idx-filme-so-pack', {
  op: 'idx', releases: [pack(h('e'))], season: null, episode: null, minSeeders: 3,
});
add('idx-temporada-sem-episodio', {
  op: 'idx', releases: [pack(h('f'))], season: 2, episode: null, minSeeders: 3,
});
add('idx-so-autofetch-vira-vazio', {
  op: 'idx',
  releases: [{ ...pack(h('0')), source: 'autofetch' }],
  season: 2,
  episode: 1,
  minSeeders: 3,
});
add('idx-autofetch-e-release-real', {
  op: 'idx',
  releases: [{ ...pack(h('1')), source: 'autofetch' }, doEp(h('2'))],
  season: 2,
  episode: 1,
  minSeeders: 3,
});
add('idx-global-saudavel-no-minimo', {
  op: 'idx',
  releases: [{ hash: h('3'), title: 'Movie (2024) 1080p BluRay', seeders: 5, source: 'jackett' }],
  season: null,
  episode: null,
  minSeeders: 3,
});
add('idx-global-fraco-no-piso-zero', {
  op: 'idx',
  releases: [{ hash: h('4'), title: 'Movie (2024) 1080p BluRay', seeders: 1, source: 'jackett' }],
  season: null,
  episode: null,
  minSeeders: 0,
});
add('idx-global-fraco-no-piso-tres', {
  op: 'idx',
  releases: [{ hash: h('5'), title: 'Movie (2024) 1080p BluRay', seeders: 1, source: 'jackett' }],
  season: null,
  episode: null,
  minSeeders: 3,
});
add('idx-br-dublado-sempre-cobre', {
  op: 'idx',
  releases: [{ hash: h('6'), title: 'Filme (2024) 720p Dublado', seeders: 0, isBr: true, dubbed: true }],
  season: null,
  episode: null,
  minSeeders: 9,
});
add('idx-episodio-nomeado-em-pack-gigante', {
  op: 'idx',
  releases: [{
    hash: h('7'),
    title: 'Serie S02E01 1080p Dublado',
    seeders: 0,
    isBr: true,
    dubbed: true,
  }],
  season: 2,
  episode: 1,
  minSeeders: 3,
});
add('idx-episodio-de-outra-temporada', {
  op: 'idx',
  releases: [{
    hash: h('8'),
    title: 'Serie S03E01 1080p Dublado',
    seeders: 0,
    isBr: true,
    dubbed: true,
  }],
  season: 2,
  episode: 1,
  minSeeders: 3,
});

const doc = {
  _doc:
    'Corpus do golden `search-pool-coverage` (F-1). Cada input é uma STRING JSON '
    + 'com `op` ∈ {pool, idx}. `minSeeders` é o piso do melhor-swarm: o oráculo o '
    + 'aplica na config VIVA do autofetch (é o que o TS lê dentro de '
    + '`poolCovered`) e o teste Rust usa o mesmo número por parâmetro. Para `idx`, '
    + 'o oráculo devolve {covered, packOnly} com `packOnly` medido pela métrica '
    + '`search.idx.packOnly`.',
  cases,
};
fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`[corpus] ${path.relative(REPO, OUT)}: ${cases.length} casos`);
