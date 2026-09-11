import config from './config.js';
import jackett from './providers/jackett.js';
import { hasUserTraffic } from './providers/activity.js';
import { planJackettQueries, ptSweepQueryFor } from './providers/search-plan.js';
import { getMeta } from './utils/cinemeta.js';
import * as tmdb from './utils/tmdb.js';
import { buildSearchQuery, resolveSearchNames } from './utils/format.js';
import { mapLimit } from './utils/concurrency.js';
import * as log from './utils/logger.js';

type WarmupTitle = { imdbId: string; type: 'movie' | 'series' };

function parseTitles(): WarmupTitle[] {
  return config.warmup.titles.flatMap((raw) => {
    const [imdbId, type] = String(raw).trim().split(':');
    return /^tt\d+$/.test(imdbId) && (type === 'movie' || type === 'series') ? [{ imdbId, type }] : [];
  });
}

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function warmTitle({ imdbId, type }: WarmupTitle, deadlineAt: number) {
  if (hasUserTraffic() || Date.now() >= deadlineAt) return;
  const [meta, titles] = await Promise.all([getMeta(type, imdbId), tmdb.getTitles(imdbId)]);
  const searchMeta = resolveSearchNames({ meta, titles, imdbId });
  if (!searchMeta?.name) {
    log.warn(`[warmup] ${imdbId}: metadados insuficientes; título ignorado`);
    return;
  }
  // S01E01 cria as mesmas chaves de episódio/temporada que a busca real.
  const episode = type === 'series' ? { season: 1, episode: 1 } : {};
  const query = buildSearchQuery(searchMeta, episode);
  const ptQuery = titles?.pt && titles.pt !== titles.original
    ? buildSearchQuery({ name: titles.pt, year: titles.year }, episode)
    : null;
  const sweepQuery = config.jackett.ptSweepGlobal ? ptSweepQueryFor({ titles }) : null;
  const plan = planJackettQueries(
    query, ptQuery, config.jackett.indexers, config.jackett.ptBrIndexers,
    config.jackett.slowIndexers, sweepQuery,
  );
  const slow = new Set([...config.jackett.ptBrIndexers, ...config.jackett.slowIndexers]);
  for (const task of plan) {
    for (const indexer of task.indexers) {
      if (hasUserTraffic() || Date.now() >= deadlineAt) return;
      if (config.warmup.skipSlow && slow.has(indexer)) continue;
      await jackett.search(task.query, type, [indexer], {
        variantQuery: task.variant,
        fallbackQuery: task.fallback,
        franchiseQuery: task.franchise,
        recordStatus: false,
        skipResolve: true,
      });
      if (config.warmup.indexerDelayMs > 0) await pause(config.warmup.indexerDelayMs);
    }
  }
}

async function start() {
  if (!config.warmup.enabled || config.rawCache.maxItems <= 0 || config.jackett.indexers.length === 0) {
    log.info('[warmup] desativado ou sem cache bruto/indexers configurados');
    return;
  }
  const titles = parseTitles();
  if (!titles.length) return;
  const deadlineAt = Date.now() + Math.max(0, config.warmup.timeoutMs);
  await mapLimit(titles, Math.max(1, config.warmup.concurrency), async (title) => {
    if (hasUserTraffic() || Date.now() >= deadlineAt) return;
    try {
      await warmTitle(title, deadlineAt);
    } catch (err) {
      log.warn(`[warmup] ${title.imdbId}: falha ao aquecer:`, err?.message || err);
    }
  });
  log.info(`[warmup] ${hasUserTraffic() ? 'interrompido por tráfego' : 'concluído'}`);
}

export { start };
export default { start };
