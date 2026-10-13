/**
//! Shadow mode e captura para o parser de páginas do raspador (`adom-crawl`).
//!
//! Roda em background fora do caminho crítico via `setImmediate`:
//! 1. `shadowCrawlPage`: compara campos estruturados do TS contra o Rust (`parseCrawlPage`).
//! 2. `captureCrawlPage`: salva o conteúdo e metadados no `CRAWL_CAPTURE_DIR` quando configurado.
*/
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import type { CrawlWorkResult } from '../providers/crawl-types.js';
import { getCore, getMode } from './rust-core.js';
import { crawlUrlKey } from './crawl-url-key.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

export function captureCrawlPage(
  site: string,
  kind: string,
  url: string,
  content: string,
): void {
  const captureDir = config.crawl.captureDir;
  if (!captureDir || !content) return;

  setImmediate(() => {
    try {
      const siteDir = path.join(captureDir, site);
      if (!fs.existsSync(siteDir)) {
        fs.mkdirSync(siteDir, { recursive: true });
      }
      const rawKey = crawlUrlKey(url);
      const safeKey = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'root';
      const ext = content.trim().startsWith('{') ? 'json' : 'html';
      const filePath = path.join(siteDir, `${safeKey}.${ext}`);
      const metaPath = path.join(siteDir, `${safeKey}.meta.json`);

      fs.writeFileSync(filePath, content, 'utf8');
      fs.writeFileSync(
        metaPath,
        JSON.stringify({ url, kind, site, capturedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch (err) {
      log.debug(`[crawl-capture] falha ao salvar ${site} (${url}):`, log.errorMessage(err));
    }
  });
}

export function shadowCrawlPage(
  site: string,
  kind: string,
  url: string,
  content: string,
  tsResult: CrawlWorkResult,
): void {
  // Captura opcional
  captureCrawlPage(site, kind, url, content);

  const mode = getMode();
  if (mode === 'off') return;
  const core = getCore();
  if (!core || typeof core.parseCrawlPage !== 'function') return;

  setImmediate(() => {
    metrics.count('rust.crawl.pages');
    metrics.count(`rust.crawl.${site}.pages`);
    try {
      const rustResult = core.parseCrawlPage!(site, kind, url, content);
      const diffs: string[] = [];

      // Status
      if (tsResult.status !== rustResult.status) {
        diffs.push(`status: ts=${tsResult.status} rust=${rustResult.status}`);
      }
      // IMDb (se ambos identificaram na página)
      if (tsResult.imdb && rustResult.imdb && tsResult.imdb !== rustResult.imdb) {
        diffs.push(`imdb: ts=${tsResult.imdb} rust=${rustResult.imdb}`);
      }
      // Título
      if (
        tsResult.title
        && rustResult.title
        && tsResult.title.trim().toLowerCase() !== rustResult.title.trim().toLowerCase()
      ) {
        diffs.push(`title: ts=${tsResult.title} rust=${rustResult.title}`);
      }
      // Ano
      if (tsResult.year && rustResult.year && tsResult.year !== rustResult.year) {
        diffs.push(`year: ts=${tsResult.year} rust=${rustResult.year}`);
      }
      // Contagem total de releases
      const tsCount = (tsResult.releases?.length ?? 0)
        + (tsResult.groups?.reduce((acc, g) => acc + g.releases.length, 0) ?? 0)
        + (tsResult.unlocated?.length ?? 0);

      const rustCount = rustResult.releases.length
        + rustResult.groups.reduce((acc, g) => acc + g.releases.length, 0)
        + rustResult.unlocated.length;

      if (tsCount !== rustCount) {
        diffs.push(`releases: ts=${tsCount} rust=${rustCount}`);
      }

      if (diffs.length > 0) {
        metrics.count('rust.crawl.diff');
        metrics.count(`rust.crawl.${site}.diff`);
        log.warn(`[rust-crawl] divergência em ${site} (${url}): ${diffs.join(', ')}`);
      }
    } catch (err) {
      metrics.count('rust.crawl.error');
      metrics.count(`rust.crawl.${site}.error`);
      log.debug(`[rust-crawl] erro ao avaliar ${site} (${url}):`, log.errorMessage(err));
    }
  });
}
