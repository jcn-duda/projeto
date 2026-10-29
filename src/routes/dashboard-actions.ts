// Despacho por AÇÃO do /dashboard-action.json (PLANO_MELHORIAS §5.8, item 8).
// O guard de token fica NA FRENTE em diagnostics.ts; a allowlist e o `confirm`
// das destrutivas rodam antes do admission do gate.

import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';
import { clearCache } from './dashboard-actions-cache.js';
import { harvestDebridGet, harvestDebridSet } from './dashboard-actions-harvest-debrid.js';
import { autofetchPause, autofetchDrain, autofetchConfigGet, autofetchConfigSet, autofetchConfigReset } from './dashboard-actions-autofetch.js';
import { autofetchSuppressedGet, autofetchSuppressedDrain } from './dashboard-actions-autofetch-suppressed.js';
import { magnetInspect, magnetClearBad, magnetSummary, magnetBankSummary, magnetBankSearch } from './dashboard-actions-magnet.js';
import { crawlPause, crawlSimulate, crawlReprocessErrors, crawlReprocessNoWork, crawlReset, crawlConfigGet, crawlConfigSet, crawlConfigReset, crawlSitePause, crawlSiteConfigSet, crawlSiteConfigReset } from './dashboard-actions-crawl.js';
// `max` do corpo: número finito positivo vira inteiro; qualquer outra coisa
// vira undefined (sem teto). Mora no módulo folha compartilhado para os dois
// lados do despacho usarem a MESMA normalização, sem cópia que possa divergir.
import { maxFromBody } from './dashboard-actions-shared.js';
// Ações do colhedor NATIVO (pausa/drenagem/limpeza): a fila, o worker e o
// balde horário vivem no gateway Rust e o Node só repassa pela ponte.
import { harvestPause, harvestDrain, harvestClearQueue, harvestConfigSet, harvestConfigReset } from './dashboard-actions-harvest.js';
// Varredura de mortos: ponte nativa da AllDebrid + ramo legado dos outros
// serviços (extraído pela catraca de 400 linhas).
import { sweepDead } from './dashboard-actions-sweep.js';

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

// Cada handler devolve a própria resposta (res.json / res.status().json()).
type ActionHandler = (deps: ActionDeps) => Promise<express.Response> | express.Response;

// Ações destrutivas ou irreversíveis: exigem `{"confirm": true}` no corpo.
// Sem ele, 400 `confirmation_required` — checado antes do admission do gate.
const DESTRUCTIVE_ACTIONS = new Set([
  'clear-cache',
  'sweep-dead',
  'autofetch-drain',
  'autofetch-config-reset',
  'autofetch-suppressed-drain',
  'harvest-config-reset',
  'harvester-clear-queue',
  'crawl-reset', 'crawl-config-reset', 'crawl-site-config-reset',
  'dedup-apply',
  'cleanup-apply',
  'manual-delete',
  'magnet-clear-bad',
]);

// Teto da chave no corpo do teste de conta: credencial tem dezenas de
// caracteres; 512 cobre folgado e impede payload gigante contra a API.
const MAX_TEST_KEY_LENGTH = 512;

const ACTIONS: Record<string, ActionHandler> = {
  'clear-cache': clearCache,

  // Varredura de mortos: AllDebrid do operador → varredura NATIVA no gateway;
  // AllDebrid BYO → erro explícito; demais serviços → adaptador legado.
  'sweep-dead': sweepDead,

  // Colhedor NATIVO: handlers em dashboard-actions-harvest.js (`ok:false` com
  // "colhedor nativo indisponível" quando a ponte não confirma o efeito).
  'harvester-pause': harvestPause,
  'harvester-drain': harvestDrain,
  'harvester-clear-queue': harvestClearQueue,

  'harvest-config-get': ({ services, res, action }) => {
    return res.json({ ok: true, action, config: services.harvesterLive.snapshot() });
  },

  // Config ao vivo: o Node grava o overlay e a ponte o aplica no gateway.
  'harvest-config-set': harvestConfigSet,
  'harvest-config-reset': harvestConfigReset,

  // Conta de fundo do colhedor: ações em dashboard-actions-harvest-debrid.js
  // (o teste da chave reutiliza o `debrid-account-test` do despacho).
  'harvester-debrid-get': harvestDebridGet,
  'harvester-debrid-set': harvestDebridSet,

  // Raspagem total (Fase 4): handlers em dashboard-actions-crawl.js; `crawl-reset`
  // é destrutivo (confirm acima) e apaga só o site. Fase 8: as `crawl-site-*` agem
  // por site (validado contra CRAWL_SITES); `crawl-site-config-reset` é destrutiva.
  'crawl-pause': crawlPause,
  'crawl-simulate': crawlSimulate,
  'crawl-reprocess-errors': crawlReprocessErrors, 'crawl-reprocess-no-work': crawlReprocessNoWork,
  'crawl-reset': crawlReset,
  'crawl-config-get': crawlConfigGet,
  'crawl-config-set': crawlConfigSet,
  'crawl-config-reset': crawlConfigReset,
  'crawl-site-pause': crawlSitePause, 'crawl-site-config-set': crawlSiteConfigSet, 'crawl-site-config-reset': crawlSiteConfigReset,

  'warm-pause': ({ services, res, action }) => {
    services.rdWarmer.setPaused(true);
    services.metrics.count('dashboard.rd.warm.pause');
    services.log.info('[dashboard] warmer RD pausado');
    return res.json({ ok: true, action, paused: true });
  },

  'warm-resume': ({ services, res, action }) => {
    services.rdWarmer.setPaused(false);
    services.metrics.count('dashboard.rd.warm.resume');
    services.log.info('[dashboard] warmer RD retomado');
    return res.json({ ok: true, action, paused: false });
  },

  'warm-drain': async ({ services, req, res, action }) => {
    const result = await services.rdWarmer.drain(maxFromBody(req));
    services.metrics.count('dashboard.rd.warm.drain', result.processed);
    services.log.info(`[dashboard] warmer RD drenado: ${result.processed} item(ns) processado(s), ${result.queueRemaining} restante(s)`);
    return res.json({ ok: true, action, ...result });
  },

  'refresh-inventory': ({ services, res, action }) => {
    const result = services.debrid.refreshInventory();
    services.metrics.count('dashboard.inventory.refresh');
    services.log.info(`[dashboard] memo de inventário invalidado: ${result.refreshed} conta(s)`);
    return res.json({ ok: true, action, ...result });
  },

  // Teste de conta NÃO destrutivo e SEM estado (Fase 1 do debrid configurável):
  // valida {service, key} contra o registry e consulta a saúde daquela chave,
  // sem memoizar/persistir nada nem trocar a config da instalação — é
  // diagnóstico ANTES de salvar; por isso não entra em DESTRUCTIVE_ACTIONS.
  'debrid-account-test': async ({ services, req, res, action }) => {
    const service = typeof req.body?.service === 'string' ? req.body.service.trim() : '';
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const adapter = service ? services.debrid.BY_ID.get(service) : undefined;
    if (!adapter) {
      return res.status(400).json({
        ok: false,
        action,
        reason: 'servico-desconhecido',
        error: 'serviço desconhecido; use um id do registry de debrid',
        fix: 'escolha um dos serviços suportados pelo addon',
      });
    }
    if (!key) {
      return res.status(400).json({
        ok: false,
        action,
        reason: 'chave-ausente',
        error: 'chave vazia; informe a chave da conta para testar',
        fix: 'cole a chave da conta do serviço e teste novamente',
      });
    }
    if (key.length > MAX_TEST_KEY_LENGTH) {
      return res.status(400).json({
        ok: false,
        action,
        reason: 'chave-invalida',
        error: `chave acima de ${MAX_TEST_KEY_LENGTH} caracteres`,
        fix: 'confira se a chave foi colada por inteiro, sem conteúdo extra',
      });
    }
    const outcome = await services.debrid.testAccount(adapter, key);
    services.metrics.count(outcome.ok ? 'dashboard.debrid.account_test.ok' : 'dashboard.debrid.account_test.fail');
    // Log só service/result: credencial, last4 e impressão digital nunca entram.
    services.log.info(
      `[dashboard] teste de conta de debrid (${service}): ${outcome.ok ? 'ok' : `falha (${outcome.reason})`}`,
    );
    return res.json({ ...outcome, action });
  },

  // O probe por indexer saiu junto com a busca do Node: `/test-indexer.json`
  // responde 410 e esta ação devolve o MESMO veredito (200 com tabela vazia
  // parecia "todos ok"). O painel mostra `error` no card, sem quebrar.
  'test-all-indexers': ({ services, res, action }) => {
    services.metrics.count('dashboard.indexers.test-all.native');
    services.log.info('[dashboard] teste de indexers recusado: a busca/coleta é nativa');
    return res.status(410).json({
      ok: false,
      action,
      reason: 'native-search',
      error: 'a busca e a coleta rodam no gateway nativo; o teste de indexers pelo Node foi aposentado (/test-indexer.json responde 410)',
      fix: 'veja o estado de cada fonte no bloco `indexers` do painel (aba Saúde)',
      results: [],
      total: 0,
      okCount: 0,
      downCount: 0,
    });
  },

  // Ações do Chupim: handlers em dashboard-actions-autofetch.js.
  'autofetch-pause': autofetchPause,
  'autofetch-drain': autofetchDrain,
  'autofetch-config-get': autofetchConfigGet,
  'autofetch-config-set': autofetchConfigSet,
  'autofetch-config-reset': autofetchConfigReset,

  // Fila de remoções represadas: handlers em dashboard-actions-autofetch-suppressed.js.
  // O drain é destrutivo (confirm acima) e drena SEM ligar o knob global.
  'autofetch-suppressed-get': autofetchSuppressedGet,
  'autofetch-suppressed-drain': autofetchSuppressedDrain,

  // Banco de magnets: handlers em dashboard-actions-magnet.js. Inspect,
  // summary, bank-summary e bank-search são leitura; clear-bad é destrutivo
  // (confirm acima) e idempotente. bank-summary/bank-search olham o banco VIVO
  // (`magnet-bank`), separado do estoque por conta do `magnet-summary`.
  'magnet-inspect': magnetInspect,
  'magnet-clear-bad': magnetClearBad,
  'magnet-summary': magnetSummary,
  'magnet-bank-summary': magnetBankSummary,
  'magnet-bank-search': magnetBankSearch,

  'catalog-scan': async ({ services, res, action }) => {
    const result = await services.debrid.catalogScanEnv();
    services.metrics.count('dashboard.catalog.scan', result.ok ? 1 : 0);
    // Indisponibilidade por MOTIVO (ex.: chave-operador-desativada): o 1/0
    // agregado não dizia por que o painel não via a conta do operador.
    if (!result.ok) {
      services.metrics.count(`dashboard.catalog.unavailable.${(result as { reason?: string }).reason || 'desconhecido'}`);
    }
    services.log.info('[dashboard] varredura do catálogo da conta executada');
    // `ok:false` aqui é indisponibilidade de diagnóstico (sem adapter/conta),
    // não erro HTTP — devolve 200 com o corpo do wrapper.
    return res.json({ ...result, action });
  },

  'catalog-report': ({ services, res, action }) => {
    const result = services.debrid.catalogStatusEnv();
    services.metrics.count('dashboard.catalog.report', result.ok ? 1 : 0);
    return res.json({ ...result, action });
  },

  'dedup-preview': ({ services, res, action }) => {
    const result = services.debrid.dedupPreviewEnv();
    services.metrics.count('dashboard.catalog.dedup_preview', result.ok ? 1 : 0);
    services.log.info('[dashboard] plano de deduplicação calculado');
    return res.json({ ...result, action });
  },

  'dedup-apply': async ({ services, req, res, action }) => {
    const result = await services.debrid.dedupApplyEnv(maxFromBody(req));
    services.metrics.count('dashboard.catalog.dedup', result.ok ? 1 : 0);
    services.log.info('[dashboard] deduplicação aplicada ao catálogo');
    return res.json({ ...result, action });
  },

  'catalog-list': ({ services, req, res, action }) => {
    const bucket = typeof req.body?.bucket === 'string' ? req.body.bucket : undefined;
    const result = services.debrid.catalogListEnv({ bucket, limit: maxFromBody(req) });
    return res.json({ ...result, action });
  },

  'manual-delete': async ({ services, req, res, action }) => {
    // Só ids: a seleção do operador é a autorização, mas o corpo vem da
    // rede — corta em 200 e normaliza para string antes de chegar ao plano.
    const ids = Array.isArray(req.body?.serviceIds)
      ? req.body.serviceIds.slice(0, 200).map((x: unknown) => String(x ?? '')).filter(Boolean)
      : [];
    const result = await services.debrid.manualDeleteEnv({ serviceIds: ids });
    if ('deleted' in result) {
      services.metrics.count('dashboard.catalog.manual', result.deleted);
      services.log.info(`[dashboard] deleção manual: ${result.deleted} de ${result.total} magnet(s)`);
    } else {
      services.log.info('[dashboard] deleção manual indisponível');
    }
    return res.json({ ...result, action });
  },

  'audit-requeue': ({ services, req, res, action }) => {
    const result = services.debrid.auditRequeueEnv({ max: maxFromBody(req) });
    if (result.ok) {
      services.metrics.count('dashboard.catalog.audit_requeue', result.requeued);
      services.log.info(`[dashboard] auditoria reenfileirada: ${result.requeued} linha(s), ${result.keptWithEvidence} com evidência viva`);
    } else {
      services.metrics.count('dashboard.catalog.audit_requeue', 0);
      services.log.info('[dashboard] reenfileiramento de auditoria indisponível');
    }
    return res.json({ ...result, action });
  },

  'audit-backfill': async ({ services, req, res, action }) => {
    const result = await services.debrid.auditBackfillEnv({ max: maxFromBody(req), concurrency: undefined });
    if (result.ok) {
      services.metrics.count('dashboard.catalog.audit', result.evidenced);
      services.log.info(`[dashboard] auditoria de arquivos: ${result.scanned} registro(s), ${result.evidenced} com prova`);
    } else {
      services.metrics.count('dashboard.catalog.audit', 0);
      services.log.info('[dashboard] auditoria de arquivos indisponível');
    }
    return res.json({ ...result, action });
  },

  'cleanup-preview': async ({ services, req, res, action }) => {
    const includeKnown = req.body?.includeKnown === true;
    const result = await services.debrid.cleanupPreviewEnv({ includeKnown });
    services.metrics.count('dashboard.catalog.cleanup_preview', result.ok ? 1 : 0);
    services.log.info('[dashboard] plano de limpeza BR calculado');
    return res.json({ ...result, action });
  },

  'cleanup-apply': async ({ services, req, res, action }) => {
    const includeKnown = req.body?.includeKnown === true;
    const result = await services.debrid.cleanupApplyEnv(maxFromBody(req), { includeKnown });
    services.metrics.count('dashboard.catalog.cleanup', result.ok ? 1 : 0);
    services.log.info('[dashboard] limpeza BR aplicada ao catálogo');
    return res.json({ ...result, action });
  },

  'catalog-versions': ({ services, res, action }) => {
    const result = services.debrid.catalogVersionsEnv();
    services.metrics.count('dashboard.catalog.versions', result.ok ? 1 : 0);
    return res.json({ ...result, action });
  },
};

// Allowlist do despacho: as próprias chaves do mapa. Ação fora dela é
// 'ação desconhecida' (400), como na cadeia de `if` original.
const DASHBOARD_ACTIONS = new Set(Object.keys(ACTIONS));

// Ponto de entrada chamado pelo handler de diagnostics.ts, que já aplicou o
// guard de token. Mantém a ordem original: allowlist → confirm → admission
// (gate) → execução com release no finally.
async function dispatchDashboardAction(services: AppServices, req: express.Request, res: express.Response): Promise<void> {
  const action = String(req.body?.action || '');
  const handler = ACTIONS[action];
  if (!handler) {
    return void res.status(400).json({ ok: false, error: 'ação desconhecida' });
  }
  if (DESTRUCTIVE_ACTIONS.has(action) && req.body?.confirm !== true) {
    return void res.status(400).json({ ok: false, error: 'confirmation_required' });
  }
  const admission = services.diagnosticGate.enter('global') as GateAdmission;
  if (!admission.ok) {
    return void res.status(admission.status).json({ ok: false, error: admission.error, reason: admission.reason });
  }
  try {
    await handler({ services, req, res, action });
  } finally {
    admission.release();
  }
}

export { dispatchDashboardAction, DASHBOARD_ACTIONS, DESTRUCTIVE_ACTIONS };
