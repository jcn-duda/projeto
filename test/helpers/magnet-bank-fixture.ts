// Bancada compartilhada dos testes do banco vivo (Etapa 5). Guarda o setup
// determinístico (memória via diretório, SQL via arquivo), o seed canônico e o
// restore de config — os arquivos `magnet-bank-*.test.ts` não duplicam isso.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../../src/config.js';
import * as bank from '../../src/utils/magnet-bank.js';

export let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

export const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bank-status-'));
// 40 hex distintos: 39 caracteres repetidos + um sufixo.
export const hexHash = (c: string, tail = '0') => c.repeat(39) + tail;
export const H1 = hexHash('a', '1');
export const H2 = hexHash('b', '2');
export const H3 = hexHash('c', '3');
export const H4 = hexHash('d', '4');
export const H5 = hexHash('e', '5');
export const H6 = hexHash('f', '7');
export const sleeper = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

let saved: { enabled: boolean; queueMax: number; statusTtl: number } | null = null;

function save(): void {
  if (saved) return;
  saved = {
    enabled: config.magnetBank.enabled,
    queueMax: config.magnetBank.queueMax,
    statusTtl: config.magnetBank.statusTtlMs,
  };
}

export function configure(): void {
  save();
  config.magnetBank.enabled = true;
  config.magnetBank.queueMax = 500;
  config.magnetBank.statusTtlMs = 60000;
}

/** Engine de memória determinística (diretório como caminho). */
export function openMemory(): void {
  configure();
  bank.resetForTests();
  bank.open(FRESH_DIR());
}

export function openSql(): void {
  configure();
  bank.resetForTests();
  bank.open(path.join(FRESH_DIR(), 'magnets.db'));
}

/** 3 magnets distintos em 2 indexers; H1 aparece nos DOIS (hash distinto por
 * indexer). Obras: tt111 (filme) e tt222 S01E02 (série). */
export function seed(): void {
  const dn = `magnet:?xt=urn:btih:${H1}&dn=Filme%20Um`;
  bank.captureItems([
    { title: 'Filme Um Dublado 1080p', infoHash: H1, magnet: dn, size: 111, seeders: 10, isBr: true, dubbed: true, quality: '1080p' },
  ], 'nerdfilmes', { imdbId: 'tt111', season: null, episode: null });
  bank.captureItems([
    { title: 'Serie Dois S01E02 Dublada', infoHash: H2, magnet: `magnet:?xt=urn:btih:${H2}`, size: 222, seeders: 5 },
    { title: 'Serie Dois S01E02 Legendada', infoHash: H3, magnet: `magnet:?xt=urn:btih:${H3}`, size: 333, seeders: 2 },
  ], 'bludv', { imdbId: 'tt222', season: 1, episode: 2 });
  // Mesmo magnet H1 visto por outro indexer: prova hashes distintos por indexer.
  bank.captureItems([
    { title: 'Filme Um Dublado 1080p', infoHash: H1, magnet: `magnet:?xt=urn:btih:${H1}`, seeders: 11 },
  ], 'bludv', { imdbId: 'tt111', season: null, episode: null });
  bank.flushNow();
}

/** Títulos com curinga literal (`%`/`_`/`\`) e acento, para a busca. */
export function seedSpecial(): void {
  bank.captureItems([
    { title: 'Promo 100%_off\\barato', infoHash: H4, magnet: `magnet:?xt=urn:btih:${H4}`, size: 44 },
    { title: 'Extermínio', infoHash: H5, magnet: `magnet:?xt=urn:btih:${H5}`, size: 55 },
    { title: 'Épico', infoHash: H6, magnet: `magnet:?xt=urn:btih:${H6}`, size: 66 },
  ], 'nerdfilmes', {});
  bank.flushNow();
}

/** Hashes 40-hex distintos para seeds grandes (cap 100). */
export function hashAt(i: number): string {
  return i.toString(16).padStart(8, '0').repeat(5);
}

export function worksTotal(): number {
  return bank.worksFor(H1).length + bank.worksFor(H2).length + bank.worksFor(H3).length;
}

export function restoreConfig(): void {
  bank.resetForTests();
  if (saved) {
    config.magnetBank.enabled = saved.enabled;
    config.magnetBank.queueMax = saved.queueMax;
    config.magnetBank.statusTtlMs = saved.statusTtl;
  }
}
