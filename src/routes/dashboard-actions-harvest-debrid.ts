import type express from 'express';
import type { AppServices } from './types.js';

/**
 * Ações "API de debrid do Colhedor" (conta de fundo das operações em segundo
 * plano: quota-warn e warmer RD), extraídas do despacho para o arquivo ficar
 * sob o teto de linhas. O operador escolhe serviço + chave SEM editar o `.env`;
 * o painel override é fonte única e vence o `.env` (gate de operador preservado).
 *
 * Nenhuma das duas é destrutiva: a chave fica cifrada no SQLite via
 * RESOLVE_SECRET e o snapshot nunca a ecoa. `set` com key vazio apenas
 * restaura o `.env`; o teste da chave é o `debrid-account-test` já existente
 * (o front da aba reutiliza — nada de teste duplicado aqui).
 */

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

type HarvestDebridAction = (deps: ActionDeps) => express.Response;

export const harvestDebridGet: HarvestDebridAction = ({ services, res, action }) => {
  return res.json({ ok: true, action, config: services.harvesterDebrid.snapshot() });
};

export const harvestDebridSet: HarvestDebridAction = ({ services, req, res, action }) => {
  const service = typeof req.body?.service === 'string' ? req.body.service : '';
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  const outcome = services.harvesterDebrid.set(service, key);
  if (!outcome.ok) {
    return res.status(400).json({ ok: false, action, error: 'validation_error', reason: outcome.reason, fix: outcome.fix });
  }
  services.metrics.count(key ? 'dashboard.harvest.debrid.set' : 'dashboard.harvest.debrid.clear');
  // Log sem credencial: só serviço e origem (o snapshot traz a identidade segura).
  services.log.info(
    `[dashboard] conta de fundo do colhedor ${key ? 'salva' : 'restaurada'} (origem: ${services.harvesterDebrid.snapshot().source})`,
  );
  return res.json({ ok: true, action, config: services.harvesterDebrid.snapshot() });
};