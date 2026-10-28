import type express from 'express';
import type { AppServices } from './types.js';
import {
  autofetchEffectApplied,
  drainAutofetch,
  fetchAutofetchStatus,
  pauseAutofetch,
  setAutofetchConfig,
} from '../utils/autofetch-native.js';

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
 *
 * Fase B: a admin do gateway (`127.0.0.1:8711`) já publica
 * `GET /autofetch` + `POST /autofetch/{config,pause,drain}` e as ações passam a
 * REPASSAR a ordem por lá. Enquanto o worker nativo nasce desligado
 * (`enabled:false`, dreno com `effect:'none'`), o Chupim que executa é o do
 * Node: o caminho local continua sendo aplicado quando o gateway não confirma
 * efeito, senão o botão do painel ficaria decorativo. `confirm` acima de tudo e
 * o formato da resposta (`ok`/`action`/`paused`/`queues`/`items`/`effective`)
 * seguem iguais — `source` e `gateway` entram como ADITIVOS de diagnóstico.
 */

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

type AutofetchAction = (deps: ActionDeps) => Promise<express.Response> | express.Response;

export const autofetchPause: AutofetchAction = async ({ services, req, res, action }) => {
  const want = Boolean(req.body?.paused);
  const native = await pauseAutofetch(want);
  if (native?.ok) {
    // O gateway é a autoridade do worker; o overlay do Node recebe o MESMO
    // valor porque é ele que o Chupim de pé consulta (`isPaused`) até o corte.
    const paused = services.autofetchLive.setPaused(native.status?.paused ?? want);
    services.metrics.count(paused ? 'dashboard.autofetch.pause' : 'dashboard.autofetch.resume');
    services.log.info(`[dashboard] chupim ${paused ? 'pausado' : 'retomado'} (worker nativo)`);
    return res.json({ ok: true, action, paused, source: 'gateway', gateway: native });
  }
  const paused = services.autofetchLive.setPaused(want);
  services.metrics.count(paused ? 'dashboard.autofetch.pause' : 'dashboard.autofetch.resume');
  services.log.info(`[dashboard] chupim ${paused ? 'pausado' : 'retomado'}`);
  return res.json({ ok: true, action, paused, source: 'node', gateway: native ?? null });
};

export const autofetchDrain: AutofetchAction = async ({ services, res, action }) => {
  const native = await drainAutofetch();
  if (autofetchEffectApplied(native)) {
    // O worker drenou: o que sobra na fila é do MESMO KV, então a leitura do
    // Node é a medida de "restante" depois do dreno nativo.
    const left = services.autofetch.snapshot().queues;
    services.metrics.count('dashboard.autofetch.drain');
    services.log.info(`[dashboard] filas do chupim drenadas pelo worker nativo: ${native?.drained ?? 0} item(ns)`);
    return res.json({
      ok: true,
      action,
      queues: left.count,
      items: native?.drained ?? 0,
      source: 'gateway',
      gateway: native,
    });
  }
  const result = services.autofetch.drainQueues();
  services.metrics.count('dashboard.autofetch.drain');
  services.log.info(`[dashboard] filas do chupim drenadas: ${result.queues} fila(s), ${result.items} item(ns)`);
  return res.json({ ok: true, action, ...result, source: 'node', gateway: native ?? null });
};

export const autofetchConfigGet: AutofetchAction = async ({ services, res, action }) => {
  // A config ao vivo (schema do painel) é do Node; a admin só publica o estado
  // do worker (`paused`/`intervalMs`/`phase`), que vai ADITIVO em `gateway`.
  const native = await fetchAutofetchStatus();
  return res.json({
    ok: true,
    action,
    config: services.autofetchLive.snapshot(),
    source: native ? 'gateway' : 'node',
    gateway: native ?? null,
  });
};

/**
 * Leva ao worker o único par que a admin aceita (`paused`/`intervalMs`). O resto
 * do overlay (`autoFetchMax`, pools, prazos) é do Chupim do Node e continua só
 * aqui — mandar isso adiante levaria 400 de `deny_unknown_fields`.
 */
function pushWorkerPause(paused: boolean) {
  return setAutofetchConfig({ paused: paused === true });
}

export const autofetchConfigSet: AutofetchAction = async ({ services, req, res, action }) => {
  const patch = req.body?.patch;
  const outcome = services.autofetchLive.set(patch);
  if (!outcome.ok) {
    return res.status(400).json({ ok: false, error: 'validation_error', errors: outcome.errors });
  }
  const native = await pushWorkerPause(outcome.effective.paused);
  services.metrics.count('dashboard.autofetch.config.set');
  services.log.info(`[dashboard] config do chupim atualizada: ${outcome.overriddenKeys.join(', ')}`);
  return res.json({ action, ...outcome, nativeApplied: native?.ok === true, gateway: native ?? null });
};

export const autofetchConfigReset: AutofetchAction = async ({ services, res, action }) => {
  const effective = services.autofetchLive.reset();
  const native = await pushWorkerPause(effective.paused);
  services.metrics.count('dashboard.autofetch.config.reset');
  services.log.info('[dashboard] config do chupim restaurada aos padrões do .env');
  return res.json({ ok: true, action, effective, nativeApplied: native?.ok === true, gateway: native ?? null });
};
