// Ações do CRAWLER no painel (Fase 4 do plano "Raspagem total"), extraídas do
// despacho pelo mesmo precedente de dashboard-actions-autofetch.ts: mesmo
// `ActionDeps`, handlers nomeados e entradas no mapa do despacho.
//
// `crawl-reset`, `crawl-config-reset` e `crawl-site-config-reset` são
// DESTRUTIVAS: o `confirm` é checado pelo despacho (DESTRUCTIVE_ACTIONS em
// dashboard-actions.ts), antes do admission do gate — a extração não muda a
// ordem allowlist → confirm → gate → execução. `crawl-simulate` NÃO é
// destrutiva: roda em dry-run e devolve a URL à fila (nenhum acervo nem estado
// de fila é consumido).
//
// Fase 8 (multi-site): as três ações por site (`crawl-site-pause`,
// `crawl-site-config-set`, `crawl-site-config-reset`) recebem `site` no corpo e
// age SÓ naquele site; sem `site`, elas caem no site ATIVO (o que o painel está
// mostrando), nunca "o primeiro da lista" às cegas.
//
// T3-L3: o sidecar Rust passou a ter rota própria para as ações que ainda
// pediam o motor local — `crawl-reprocess-no-work` vira
// `POST /crawl/reprocess-no-work` com `{ site }`. O Node não abre o `crawl.db`
// para agir: só resolve o alvo e transporta.
import type express from 'express';
import type { AppServices } from './types.js';
import { maxFromBody } from './dashboard-actions-shared.js';
import { knownSites } from '../utils/crawler-live-schema.js';
import config from '../config.js';

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

type CrawlAction = (deps: ActionDeps) => Promise<express.Response> | express.Response;

/** Resposta do sidecar: `ok` decide o ramo, `status` o mapeamento de erro,
 * `error` traz o motivo do envelope `{ok:false,error}` quando houve. */
type SidecarReply = {
  ok: boolean;
  status: number;
  sidecarError?: string;
  error?: string;
  result?: Record<string, unknown>;
};

/** `POST` no sidecar (loopback + mesmo token/timeout). Fail-open: nunca lança. */
async function postToSidecar(path: string, payload: Record<string, unknown>): Promise<SidecarReply> {
  const url = `http://127.0.0.1:${config.crawl.sidecarPort}${path}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.jackett.testToken ? { 'X-Indexer-Test-Token': config.jackett.testToken } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const result = await resp.json().catch(() => null) as Record<string, unknown> | null;
      if (result) return { ok: true, status: resp.status, result };
      return { ok: false, status: resp.status, sidecarError: 'sidecar respondeu corpo inválido' };
    }
    const body = await resp.json().catch(() => null) as Record<string, unknown> | null;
    return {
      ok: false,
      status: resp.status,
      sidecarError: `sidecar respondeu HTTP ${resp.status}`,
      ...(typeof body?.error === 'string' ? { error: body.error } : {}),
    };
  } catch {
    return { ok: false, status: 0, sidecarError: 'sidecar não acessível' };
  }
}

/** Encaminha uma ação do `/action` ao sidecar Rust. Fail-open: se o sidecar não
 * responde, devolve 502 com o motivo (não crash). */
function forwardToSidecar(action: string, body: Record<string, unknown>): Promise<SidecarReply> {
  return postToSidecar('/action', { action, ...body });
}

/**
 * Falha da ponte na ação por site: 400 é erro do PEDIDO (validação, o sidecar
 * recusou o `site`) e vira 400 `validation_error`; 401/500/transporte são falha
 * da ponte e viram 502 `internal_error`. Só a mensagem do envelope do sidecar
 * viaja para o painel — o token nunca sai daqui.
 */
function sidecarFailed(
  services: AppServices, res: express.Response, action: string, site: string, fwd: SidecarReply,
): express.Response {
  const message = fwd.error ?? fwd.sidecarError ?? 'sidecar recusou o pedido';
  if (fwd.status === 400) {
    services.metrics.count('dashboard.crawl.reprocess.rejected');
    return res.status(400).json({ ok: false, action, site, error: 'validation_error', errors: [message] });
  }
  services.metrics.count('dashboard.crawl.reprocess.sidecar-error');
  return res.status(502).json({ ok: false, action, site, error: 'internal_error', errors: [message] });
}

/** `site` do corpo: string limpa, ou `''` (o handler decide o alvo). */
function siteFromBody(req: express.Request): string {
  return typeof req.body?.site === 'string' ? req.body.site.trim() : '';
}

export const crawlPause: CrawlAction = ({ services, req, res, action }) => {
  const result = services.crawler.setPaused(Boolean(req.body?.paused));
  services.log.info(`[dashboard] raspagem ${result.paused ? 'pausada' : 'retomada'}`);
  return res.json({ action, ...result });
};

/** Fase 8: pausa manual de UM site (a global é `crawl-pause`). */
export const crawlSitePause: CrawlAction = ({ services, req, res, action }) => {
  const site = siteFromBody(req);
  if (!site) return res.status(400).json({ ok: false, action, error: 'site obrigatório' });
  const result = services.crawler.setPaused(Boolean(req.body?.paused), site);
  if (result.ok === false) {
    services.metrics.count('dashboard.crawl.pause.site.rejected');
    return res.status(400).json({ ok: false, action, site, error: 'validation_error', errors: [result.error ?? 'site inválido'] });
  }
  services.metrics.count(result.paused ? 'dashboard.crawl.pause.site' : 'dashboard.crawl.resume.site');
  services.log.info(`[dashboard] site ${site} ${result.paused ? 'pausado' : 'retomado'}`);
  return res.json({ action, ...result });
};

export const crawlSimulate: CrawlAction = async ({ services, req, res, action }) => {
  const result = await services.crawler.simulate(maxFromBody(req), siteFromBody(req) || undefined);
  services.log.info(`[dashboard] simulação da raspagem: ${result.pages} página(s)${result.site ? ` (${result.site})` : ''}`);
  // `ok:false` é indisponibilidade (ocupado/pausado/sem adaptador), não erro
  // HTTP — devolve 200 com o motivo, como o `catalog-scan`.
  return res.json({ action, ...result });};

export const crawlReprocessErrors: CrawlAction = async ({ services, req, res, action }) => {
  // Mesmo tratamento das outras ações por site: id sem espaços nas bordas.
  const site = typeof req.body?.site === 'string' ? req.body.site.trim() : '';
  // O sidecar Rust é o dono do `crawl.db` dos nove sites: a ação vai a ele.
  const fwd = await forwardToSidecar(action, { confirm: Boolean(req.body?.confirm), site });
  if (!fwd.ok) {
    services.metrics.count('dashboard.crawl.reprocess.sidecar-error');
    return res.status(502).json({ ok: false, action, error: fwd.sidecarError });
  }
  services.metrics.count('dashboard.crawl.reprocess');
  services.log.info(`[dashboard] erros reprocessados (sidecar Rust): ${site || 'global'}`);
  return res.json({ action, ...fwd.result });
};

/** Site recusado pelo motor: 400 com o motivo, nunca "0 URL(s)" em HTTP 200 —
 * era assim que a ação de um site ligado pelo painel falhava sem aviso. */
function rejectReprocess(
  services: AppServices, res: express.Response, action: string,
  result: { site: string | null; reason?: string },
): express.Response {
  services.metrics.count('dashboard.crawl.reprocess.rejected');
  return res.status(400).json({
    ok: false, action, site: result.site, error: 'validation_error', errors: [result.reason ?? 'site inválido'],
  });
}

/** "Reprocessar sem obra": `no-work` do site volta à fila (não é destrutiva:
 * nada é apagado, a página só é raspada e identificada de novo). A escrita é
 * do sidecar; aqui só se resolve o alvo (o sidecar EXIGE `site`: ele não tem
 * "primeiro site configurado") e se transporta o `{ site }`. */
export const crawlReprocessNoWork: CrawlAction = async ({ services, req, res, action }) => {
  const known = knownSites(services.crawlerLive.effective());
  // Sem `site` no corpo, o alvo é o site ativo do motor (o primeiro da lista),
  // como era na ação local — nunca um id inventado.
  const site = siteFromBody(req) || known[0] || '';
  if (!site) return rejectReprocess(services, res, action, { site: null, reason: 'sem-site' });
  if (!known.includes(site)) return rejectReprocess(services, res, action, { site, reason: 'site-desconhecido' });
  const fwd = await postToSidecar('/crawl/reprocess-no-work', { site });
  if (!fwd.ok) return sidecarFailed(services, res, action, site, fwd);
  services.metrics.count('dashboard.crawl.reprocess.noWork');
  services.log.info(`[dashboard] sem obra reprocessadas (sidecar Rust): ${fwd.result?.requeued ?? 0} URL(s) (${site})`);
  return res.json({ action, ...fwd.result });
};

export const crawlReset: CrawlAction = async ({ services, req, res, action }) => {
  const site = typeof req.body?.site === 'string' ? req.body.site.trim() : '';
  // O sidecar Rust é o dono do `crawl.db` dos nove sites: a ação vai a ele.
  const fwd = await forwardToSidecar(action, { confirm: Boolean(req.body?.confirm), site });
  if (!fwd.ok) {
    services.metrics.count('dashboard.crawl.reset.sidecar-error');
    return res.status(502).json({ ok: false, action, error: fwd.sidecarError });
  }
  services.metrics.count('dashboard.crawl.reset');
  services.log.warn(`[dashboard] site da raspagem zerado (sidecar Rust): ${site || '(global)'}`);
  return res.json({ action, ...fwd.result });
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

/**
 * Fase 8: override de UM site (`enabled`/`dryRun`/`delayMs`/`maxPerHour`).
 * Grava em `siteOverrides[id]` e persiste; o resto da config não é tocado.
 * Chave fora do subconjunto fechado é 400 — erro de painel, não override
 * silencioso.
 */
export const crawlSiteConfigSet: CrawlAction = ({ services, req, res, action }) => {
  const site = siteFromBody(req);
  const outcome = services.crawlerLive.setSiteOverride(site, (req.body?.patch ?? {}) as Record<string, unknown>);
  if (!outcome.ok) {
    services.metrics.count('dashboard.crawl.site.config.rejected');
    return res.status(400).json({ ok: false, action, site: outcome.site, error: 'validation_error', errors: outcome.errors });
  }
  services.metrics.count('dashboard.crawl.site.config.set');
  services.log.info(`[dashboard] config do site ${site} atualizada: ${outcome.overriddenKeys.join(', ') || '(nenhuma)'}`);
  return res.json({ ok: true, action, site: outcome.site, overriddenKeys: outcome.overriddenKeys, effective: outcome.effective });
};

/** Fase 8: apaga o override do site (volta aos padrões do `.env`). */
export const crawlSiteConfigReset: CrawlAction = ({ services, req, res, action }) => {
  const site = siteFromBody(req);
  const outcome = services.crawlerLive.clearSiteOverride(site);
  if (!outcome.ok) {
    return res.status(400).json({ ok: false, action, site: outcome.site, error: 'validation_error', errors: outcome.errors });
  }
  services.metrics.count('dashboard.crawl.site.config.reset');
  services.log.info(`[dashboard] config do site ${site} restaurada aos padrões do .env`);
  return res.json({ ok: true, action, site: outcome.site, removedKeys: outcome.overriddenKeys, effective: outcome.effective });
};
