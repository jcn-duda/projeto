// Despacho por AÇÃO do /dashboard-action.json (PLANO_MELHORIAS §5.8, item 8).
// Extraído de diagnostics.ts: mapa ação→handler — cada ação nova entra sem
// tocar o despacho. O guard de token fica NA FRENTE em diagnostics.ts; a
// allowlist e o `confirm` das destrutivas rodam antes do admission do gate.

import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';
import { errorMessage } from '../utils/logger.js';
import { streamsCacheScope } from '../utils/request-key.js';
import { harvestDebridGet, harvestDebridSet } from './dashboard-actions-harvest-debrid.js';
import {
  autofetchPause, autofetchDrain, autofetchConfigGet, autofetchConfigSet, autofetchConfigReset,
} from './dashboard-actions-autofetch.js';
import { autofetchSuppressedGet, autofetchSuppressedDrain } from './dashboard-actions-autofetch-suppressed.js';

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

// Cada handler devolve a própria resposta (res.json / res.status().json()).
// O despacho não decide status — a decisão mora na ação, como antes da
// extração.
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
  'dedup-apply',
  'cleanup-apply',
  'manual-delete',
]);

// Teto da chave no corpo do teste de conta: credencial tem dezenas de
// caracteres; 512 cobre folgado e impede payload gigante contra a API.
const MAX_TEST_KEY_LENGTH = 512;

// `max` do corpo: número finito positivo vira inteiro; qualquer outra coisa
// vira undefined (sem teto). Mesma normalização que as ações já aplicavam —
// extraída porque seis ações repetiam o ternário idêntico. Mora no módulo
// folha compartilhado com os arquivos de ações extraídos para não haver cópia
// paralela que possa divergir (ciclo com o despacho é evitado assim).
import { maxFromBody } from './dashboard-actions-shared.js';

const ACTIONS: Record<string, ActionHandler> = {
  'clear-cache': ({ services, req, res, action }) => {
    const entriesBefore = services.cache.size();
    const scope = req.body?.scope;
    let removed = entriesBefore;
    let appliedScope: { kind: 'global' | 'namespace' | 'installation'; namespace?: string } = { kind: 'global' };
    if (scope != null) {
      if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
        return res.status(400).json({ ok: false, error: 'escopo de cache inválido' });
      }
      const namespace = typeof scope.namespace === 'string' ? scope.namespace : '';
      const installation = scope.installation === true;
      if (namespace && installation) {
        return res.status(400).json({ ok: false, error: 'escolha namespace ou instalação, não os dois' });
      }
      if (namespace) {
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(namespace)) {
          return res.status(400).json({ ok: false, error: 'namespace de cache inválido' });
        }
        removed = services.cache.clearNamespace(namespace);
        appliedScope = { kind: 'namespace', namespace };
      } else if (installation) {
        if (!services.runtime.prefix()) {
          return res.status(400).json({ ok: false, error: 'escopo por instalação exige URL configurada' });
        }
        const suffix = `:${streamsCacheScope(services.runtime.opts())}`;
        removed = services.cache.clearWhere((key) => key.startsWith('streams:') && key.endsWith(suffix));
        appliedScope = { kind: 'installation' };
      } else {
        return res.status(400).json({ ok: false, error: 'escopo de cache inválido' });
      }
    } else {
      services.cache.clear();
    }
    services.metrics.count('dashboard.cache.clear');
    return res.json({ ok: true, action, scope: appliedScope, removed, entriesBefore, entriesAfter: services.cache.size() });
  },

  'sweep-dead': async ({ services, res, action }) => {
    const result = (await services.debrid.sweepDeadCurrent()) ?? (await services.debrid.sweepDeadEnv());
    services.metrics.count('dashboard.sweep-dead');
    return res.json({
      ok: result != null,
      action,
      result,
      error: result == null ? 'varredura indisponível: o debrid ativo não implementa varredura, ou ela está desligada' : undefined,
    });
  },

  'harvester-pause': ({ services, req, res, action }) => {
    const paused = services.harvester.setPaused(Boolean(req.body?.paused));
    services.metrics.count(paused ? 'dashboard.harvest.pause' : 'dashboard.harvest.resume');
    services.log.info(`[dashboard] colhedor ${paused ? 'pausado' : 'retomado'}`);
    return res.json({ ok: true, action, paused });
  },

  'harvester-drain': async ({ services, res, action }) => {
    const result = await services.harvester.drain();
    services.metrics.count('dashboard.harvest.drain', result.drained);
    services.log.info(`[dashboard] fila do colhedor drenada: ${result.drained} obra(s)`);
    return res.json({ ok: true, action, ...result });
  },

  'harvester-clear-queue': ({ services, res, action }) => {
    const result = services.harvester.clearQueue();
    services.metrics.count('dashboard.harvest.clear_queue');
    services.log.info(`[dashboard] fila do colhedor limpa: ${result.cleared} obra(s) removida(s)`);
    return res.json({ ok: true, action, ...result });
  },

  'harvest-config-get': ({ services, res, action }) => {
    return res.json({ ok: true, action, config: services.harvesterLive.snapshot() });
  },

  'harvest-config-set': ({ services, req, res, action }) => {
    const patch = req.body?.patch;
    const outcome = services.harvesterLive.set(patch);
    if (!outcome.ok) {
      return res.status(400).json({ ok: false, error: 'validation_error', errors: outcome.errors });
    }
    services.metrics.count('dashboard.harvest.config.set');
    services.log.info(`[dashboard] config do colhedor atualizada: ${outcome.overriddenKeys.join(', ')}`);
    return res.json({ action, ...outcome });
  },

  'harvest-config-reset': ({ services, res, action }) => {
    const effective = services.harvesterLive.reset();
    services.metrics.count('dashboard.harvest.config.reset');
    services.log.info('[dashboard] config do colhedor restaurada aos padrões do .env');
    return res.json({ ok: true, action, effective });
  },

  // Conta de fundo do colhedor: ações em dashboard-actions-harvest-debrid.js
  // (o teste da chave reutiliza o `debrid-account-test` do despacho).
  'harvester-debrid-get': harvestDebridGet,
  'harvester-debrid-set': harvestDebridSet,

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
  // valida {service, key} contra o registry, consulta a saúde da chave
  // informada e devolve payload seguro. De propósito NÃO memoiza (o memo do
  // painel serve só às contas já configuradas), NÃO persiste nada (davail/
  // magnetdb/ledger intocados) e NÃO troca config de instalação alguma — é
  // diagnóstico de credencial ANTES de salvar, não aplicação dela. Não entra
  // em DESTRUCTIVE_ACTIONS: nada na conta é criado, modificado ou apagado.
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

  'test-all-indexers': async ({ services, res, action }) => {
    const catalog = await services.jackettCatalog.load();
    const results: any[] = [];
    for (const indexer of catalog) {
      try {
        results.push({ id: indexer.id, ...(await services.jackett.test(indexer.id, '', 'movie')) });
      } catch (err: unknown) {
        results.push({ id: indexer.id, ok: false, error: errorMessage(err) });
      }
    }
    const okCount = results.filter((result) => result.ok).length;
    services.log.info(`[dashboard] teste sequencial de ${results.length} indexador(es) concluído`);
    services.metrics.count('dashboard.indexers.test-all');
    return res.json({ ok: true, action, results, total: results.length, okCount, downCount: results.length - okCount });
  },

  // Ações do Chupim: handlers em dashboard-actions-autofetch.js (extração de
  // arquivo, comportamento intacto — inclusive o confirm das destrutivas).
  'autofetch-pause': autofetchPause,
  'autofetch-drain': autofetchDrain,
  'autofetch-config-get': autofetchConfigGet,
  'autofetch-config-set': autofetchConfigSet,
  'autofetch-config-reset': autofetchConfigReset,

  // Fila de remoções represadas: handlers em
  // dashboard-actions-autofetch-suppressed.js. O drain é destrutivo (confirm
  // acima) e drena SEM ligar o knob global — a porta supervisionada.
  'autofetch-suppressed-get': autofetchSuppressedGet,
  'autofetch-suppressed-drain': autofetchSuppressedDrain,

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
    return void res.status(admission.status).json({ ok: false, error: admission.error });
  }
  try {
    await handler({ services, req, res, action });
  } finally {
    admission.release();
  }
}

export { dispatchDashboardAction, DASHBOARD_ACTIONS, DESTRUCTIVE_ACTIONS };
