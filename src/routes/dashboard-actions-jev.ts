import type express from 'express';
import type { AppServices } from './types.js';
import { aiControl } from '../ai/index.js';

/**
 * Ações do Jev (runtime TypeSafe shadow), extraídas por arquivo seguindo o
 * precedente de dashboard-actions-autofetch.ts: mesmo `ActionDeps`, handlers
 * exportados nomeados e entradas no mapa do despacho.
 *
 * NENHUMA é destrutiva — por isso nenhuma entra em DESTRUCTIVE_ACTIONS: a
 * pausa é efêmera (memória) e reversível, o drain só REAGENDA o esvaziamento
 * da fila (nada é descartado) e o reset de cooldown limpa só o breaker,
 * sem tocar fila nem janelas de custo.
 *
 * O import da FACHADA (`../ai/index.js`) é a única porta para `src/ai/` fora
 * dela — o teste de grafo (test/typesafe-shadow-graph.test.ts) reprova
 * qualquer outro caminho.
 */

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

type JevAction = (deps: ActionDeps) => Promise<express.Response> | express.Response;

export const jevPause: JevAction = ({ services, res, action }) => {
  aiControl.pause();
  services.metrics.count('dashboard.jev.pause');
  services.log.info('[dashboard] Jev pausado (as duas perguntas shadow)');
  return res.json({ ok: true, action, paused: true, status: aiControl.status() });
};

export const jevResume: JevAction = ({ services, res, action }) => {
  aiControl.resume();
  services.metrics.count('dashboard.jev.resume');
  services.log.info('[dashboard] Jev retomado');
  return res.json({ ok: true, action, paused: false, status: aiControl.status() });
};

export const jevDrain: JevAction = ({ services, res, action }) => {
  aiControl.drainNow();
  services.metrics.count('dashboard.jev.drain');
  services.log.info('[dashboard] drenagem das filas do Jev reagendada');
  return res.json({ ok: true, action, status: aiControl.status() });
};

export const jevCooldownReset: JevAction = ({ services, res, action }) => {
  aiControl.resetCooldown();
  services.metrics.count('dashboard.jev.cooldown_reset');
  services.log.info('[dashboard] cooldown do Jev zerado');
  return res.json({ ok: true, action, status: aiControl.status() });
};
