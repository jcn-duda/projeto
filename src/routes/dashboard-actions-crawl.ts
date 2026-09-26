// Ações do CRAWLER no painel (Fase 4 do plano "Raspagem total"), extraídas do
// despacho pelo mesmo precedente de dashboard-actions-autofetch.ts: mesmo
// `ActionDeps`, handlers nomeados e entradas no mapa do despacho.
//
// `crawl-reset` e `crawl-config-reset` são DESTRUTIVAS: o `confirm` é checado
// pelo despacho (DESTRUCTIVE_ACTIONS em dashboard-actions.ts), antes do
// admission do gate — a extração não muda a ordem allowlist → confirm → gate
// → execução. `crawl-simulate` NÃO é destrutiva: roda em dry-run e devolve a
// URL à fila (nenhum acervo nem estado de fila é consumido).
import type express from 'express';
import type { AppServices } from './types.js';
import { maxFromBody } from './dashboard-actions-shared.js';

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

type CrawlAction = (deps: ActionDeps) => Promise<express.Response> | express.Response;

export const crawlPause: CrawlAction = ({ services, req, res, action }) => {
  const result = services.crawler.setPaused(Boolean(req.body?.paused));
  services.log.info(`[dashboard] raspagem ${result.paused ? 'pausada' : 'retomada'}`);
  return res.json({ ok: true, action, ...result });
};

export const crawlSimulate: CrawlAction = async ({ services, req, res, action }) => {
  const result = await services.crawler.simulate(maxFromBody(req));
  services.log.info(`[dashboard] simulação da raspagem: ${result.pages} página(s)`);
  // `ok:false` é indisponibilidade (ocupado/pausado/sem adaptador), não erro
  // HTTP — devolve 200 com o motivo, como o `catalog-scan`.
  return res.json({ action, ...result });};

export const crawlReprocessErrors: CrawlAction = ({ services, req, res, action }) => {
  const site = typeof req.body?.site === 'string' ? req.body.site : undefined;
  const result = services.crawler.reprocessErrors(site);
  services.metrics.count('dashboard.crawl.reprocess');
  services.log.info(`[dashboard] erros da raspagem reprocessados: ${result.requeued} URL(s) (${result.site})`);
  return res.json({ ok: true, action, ...result });
};

export const crawlReset: CrawlAction = ({ services, req, res, action }) => {
  const site = typeof req.body?.site === 'string' ? req.body.site.trim() : '';
  const result = services.crawler.resetSite(site);
  if (!result.ok) {
    services.metrics.count('dashboard.crawl.reset.rejected');
    return res.status(400).json({ action, ...result });
  }
  services.metrics.count('dashboard.crawl.reset');
  services.log.warn(`[dashboard] site da raspagem zerado: ${result.site} (${result.urls} URL(s))`);
  return res.json({ action, ...result });
};

export const crawlConfigGet: CrawlAction = ({ services, res, action }) => {
  return res.json({ ok: true, action, config: services.crawlerLive.snapshot() });
};

export const crawlConfigSet: CrawlAction = ({ services, req, res, action }) => {
  const outcome = services.crawlerLive.set(req.body?.patch);
  if (!outcome.ok) {
    return res.status(400).json({ ok: false, error: 'validation_error', errors: outcome.errors });
  }
  services.metrics.count('dashboard.crawl.config.set');
  services.log.info(`[dashboard] config da raspagem atualizada: ${outcome.overriddenKeys.join(', ')}`);
  return res.json({ action, ...outcome });
};

export const crawlConfigReset: CrawlAction = ({ services, res, action }) => {
  const effective = services.crawlerLive.reset();
  services.metrics.count('dashboard.crawl.config.reset');
  services.log.info('[dashboard] config da raspagem restaurada aos padrões do .env');
  return res.json({ ok: true, action, effective });
};
