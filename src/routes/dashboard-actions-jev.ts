import type express from 'express';
import type { AppServices } from './types.js';
import { aiControl, jevDisagreements as aiJevDisagreements } from '../ai/index.js';

/**
 * Ações do Jev (runtime TypeSafe shadow), extraídas por arquivo seguindo o
 * precedente de dashboard-actions-autofetch.ts: mesmo `ActionDeps`, handlers
 * exportados nomeados e entradas no mapa do despacho.
 *
 * NENHUMA é destrutiva — por isso nenhuma entra em DESTRUCTIVE_ACTIONS: a
 * pausa é efêmera (memória) e reversível, o drain só REAGENDA o esvaziamento
 * da fila (nada é descartado), o reset de cooldown limpa só o breaker, sem
 * tocar fila nem janelas de custo, e `jev-disagreements` é LEITURA pura do
 * anel em memória (nada muda).
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
  // Com o Jev pausado, `drainNow()` é NO-OP (o drain do core retorna cedo em
  // `if (paused)`): responder `ok` sem drenar nada afirmaria uma drenagem que
  // não aconteceu. `drained:false` + `reason:'paused'` (união fechada) é a
  // resposta honesta — o painel troca o toast de sucesso. Não é erro de
  // protocolo, então `ok` continua `true`.
  if (aiControl.isPaused()) {
    services.metrics.count('dashboard.jev.drain.paused');
    services.log.info('[dashboard] drenagem do Jev não agendada: Jev pausado');
    return res.json({ ok: true, action, drained: false, reason: 'paused', status: aiControl.status() });
  }
  aiControl.drainNow();
  services.metrics.count('dashboard.jev.drain');
  services.log.info('[dashboard] drenagem das filas do Jev reagendada');
  return res.json({ ok: true, action, drained: true, status: aiControl.status() });
};

export const jevCooldownReset: JevAction = ({ services, res, action }) => {
  aiControl.resetCooldown();
  services.metrics.count('dashboard.jev.cooldown_reset');
  services.log.info('[dashboard] cooldown do Jev zerado');
  return res.json({ ok: true, action, status: aiControl.status() });
};

/**
 * LEITURA do anel em memória das últimas discordâncias (teto 50 por pergunta).
 * Não é destrutiva e não passa pelo poll: o `sample` carrega título, então só
 * sai nesta resposta autenticada. Payload por allowlist — o anel já nasce
 * `{ at, side, n, dim, sample }`, sem hash, credencial nem conta.
 */
export const jevDisagreements: JevAction = ({ services, res, action }) => {
  const data = aiJevDisagreements();
  services.metrics.count('dashboard.jev.disagreements');
  return res.json({ ok: true, action, audioClassify: data.audioClassify, dubLie: data.dubLie });
};
