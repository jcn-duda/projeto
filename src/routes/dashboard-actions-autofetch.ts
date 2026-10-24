import type express from 'express';
import type { AppServices } from './types.js';

/**
 * Ações do Chupim (autofetch live), extraídas do despacho para o arquivo ficar
 * sob o teto de linhas (catraca de 400) — movimentação pura, sem comportamento
 * novo. Segue o precedente de dashboard-actions-harvest-debrid.ts: mesmo
 * `ActionDeps`, handlers exportados nomeados e entradas no mapa do despacho.
 *
 * O `autofetch-drain` e o `autofetch-config-reset` continuam DESTRUTIVOS: o
 * `confirm` é checado pelo despacho (DESTRUCTIVE_ACTIONS em
 * dashboard-actions.ts), antes do admission do gate — a extração não muda a
 * ordem allowlist → confirm → gate → execução.
 */

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

type AutofetchAction = (deps: ActionDeps) => Promise<express.Response> | express.Response;

export const autofetchPause: AutofetchAction = ({ services, req, res, action }) => {
  const paused = services.autofetchLive.setPaused(Boolean(req.body?.paused));
  services.metrics.count(paused ? 'dashboard.autofetch.pause' : 'dashboard.autofetch.resume');
  services.log.info(`[dashboard] chupim ${paused ? 'pausado' : 'retomado'}`);
  return res.json({ ok: true, action, paused });
};

export const autofetchDrain: AutofetchAction = ({ services, res, action }) => {
  const result = services.autofetch.drainQueues();
  services.metrics.count('dashboard.autofetch.drain');
  services.log.info(`[dashboard] filas do chupim drenadas: ${result.queues} fila(s), ${result.items} item(ns)`);
  return res.json({ ok: true, action, ...result });
};

export const autofetchConfigGet: AutofetchAction = ({ services, res, action }) => {
  return res.json({ ok: true, action, config: services.autofetchLive.snapshot() });
};

export const autofetchConfigSet: AutofetchAction = ({ services, req, res, action }) => {
  const patch = req.body?.patch;
  const outcome = services.autofetchLive.set(patch);
  if (!outcome.ok) {
    return res.status(400).json({ ok: false, error: 'validation_error', errors: outcome.errors });
  }
  services.metrics.count('dashboard.autofetch.config.set');
  services.log.info(`[dashboard] config do chupim atualizada: ${outcome.overriddenKeys.join(', ')}`);
  return res.json({ action, ...outcome });
};

export const autofetchConfigReset: AutofetchAction = ({ services, res, action }) => {
  const effective = services.autofetchLive.reset();
  services.metrics.count('dashboard.autofetch.config.reset');
  services.log.info('[dashboard] config do chupim restaurada aos padrões do .env');
  return res.json({ ok: true, action, effective });
};
