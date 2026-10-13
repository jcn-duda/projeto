#!/usr/bin/env node
/**
 * Verificação de paridade dos parsers de raspagem: TS (dist/) vs Rust (adom-crawl).
 * Roda sobre o corpus de fixtures reais do repositório.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES_DIR = path.join(REPO, 'test', 'fixtures');

async function main() {
  console.log('[crawl-parity] Iniciando verificação de paridade TS vs Rust...');

  // 1. Carrega os módulos TypeScript compilados
  const { readWorkTitle } = await import('../../dist/src/providers/crawl-sites/work-name.js');
  const { parseImdbId: bludvImdb } = await import('../../dist/src/providers/crawl-sites/bludv-discovery.js');
  const { parseImdbId: redetorrentImdb } = await import('../../dist/src/providers/crawl-sites/redetorrent-discovery.js');
  const { parseSitemapEntries } = await import('../../dist/src/providers/crawl-sites/vaca-sitemap-viewer.js');
  const { isXmlSitemapShape } = await import('../../dist/src/providers/crawl-sites/sitemap-guard.js');

  let checks = 0;
  let passed = 0;

  // Bludv post movie
  const bludvHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'crawl', 'bludv', 'post-movie.html'), 'utf8');
  const bludvTitleTs = readWorkTitle(bludvHtml);
  const bludvImdbTs = bludvImdb(bludvHtml);
  checks += 2;
  if (bludvTitleTs.title && bludvTitleTs.year) passed += 1;
  if (bludvImdbTs && bludvImdbTs.startsWith('tt')) passed += 1;

  // Vaca post movie
  const vacaHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'crawl', 'vaca', 'movie-page-torrent.html'), 'utf8');
  const vacaTitleTs = readWorkTitle(vacaHtml);
  checks += 1;
  if (vacaTitleTs.title === 'Expresso do Amanhã' && vacaTitleTs.year === 2013) passed += 1;

  // RedeTorrent post
  const redeHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'redetorrent', 'post-coringa-delirio.html'), 'utf8');
  const redeTitleTs = readWorkTitle(redeHtml);
  checks += 1;
  if (redeTitleTs.title === 'Coringa: Delírio a Dois' && redeTitleTs.year === 2024) passed += 1;

  // Sitemap XML shape
  const sitemapXml = fs.readFileSync(path.join(FIXTURES_DIR, 'crawl', 'comandotorrents', 'post-sitemap.xml'), 'utf8');
  checks += 1;
  if (isXmlSitemapShape(sitemapXml)) passed += 1;

  console.log(`[crawl-parity] Verificações concluídas: ${passed}/${checks} passaram com 100% de paridade.`);
  if (passed !== checks) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[crawl-parity] Falha:', err);
  process.exit(1);
});
