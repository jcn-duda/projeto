// Ações do COLHEDOR no painel (pausar/retomar, drenar, limpar fila).
//
// Desde a Fase 5 a fila (`harvest:v1:q`), o worker e o balde horário vivem no
// gateway Rust: o Node não tem mais fila própria para pausar/drenar/limpar.
// Estas ações só repassam a ordem pela ponte (`harvest-native`) e traduzem o
// resultado para o que a aba Colhedor mostra.
//
// Regra da tradução: `null` (ponte em backoff/tempo esgotado) ou `paused:false`
// depois de pedir pausa é INDISPONIBILIDADE — a resposta diz "colhedor nativo
// indisponível" em vez de um `ok:true` que o gateway nunca aplicou. Um `0` de
// drenagem/limpeza é ambíguo (fila vazia × ponte caída), então quem desempata é
// o refresh do snapshot: só ele fala com o gateway na hora do clique.
import type express from 'express';
import type { AppServices } from './types.js';
import { maxFromBody } from './dashboard-actions-shared.js';
import {
  pauseNativeHarvest,
  drainNativeHarvest,
  clearNativeHarvest,
  harvestStatusSnapshot,
  harvestNativeOnline,
  refreshHarvestStatus,
  type NativeHarvestStatus,
} from '../utils/harvest-native.js';

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

/** Mensagem única quando a ponte não confirma o efeito (o painel a exibe). */
export const HARVEST_OFFLINE = 'colhedor nativo indisponível';

/**
 * O refresh só SUBSTITUI o espelho quando o gateway respondeu; em falha (ou
 * backoff) devolve a MESMA referência. Sem isso, um snapshot `online` antigo
 * faria um `0` de drenagem/limpeza parecer "fila vazia" quando na verdade a
 * ponte nunca falou com o gateway.
 */
function refreshLanded(before: NativeHarvestStatus | null, after: NativeHarvestStatus | null): boolean {
  return after !== null && after !== before;
}

/** `harvester-pause` — `{paused:bool}`; devolve o estado efetivo do gateway. */
export async function harvestPause({ services, req, res, action }: ActionDeps): Promise<express.Response> {
  const want = Boolean(req.body?.paused);
  const paused = await pauseNativeHarvest(want);
  // Pedir pausa e receber `false` = o gateway não aplicou (colhedor desligado
  // lá); pedir retomada e receber `false` é o estado desejado.
  if (paused === null || (want && paused !== true)) {
    services.metrics.count('dashboard.harvest.unavailable');
    services.log.warn(`[dashboard] pausa do colhedor nativo não aplicada (paused=${want})`);
    return res.json({ ok: false, action, paused: false, error: HARVEST_OFFLINE });
  }
  services.metrics.count(paused ? 'dashboard.harvest.pause' : 'dashboard.harvest.resume');
  services.log.info(`[dashboard] colhedor nativo ${paused ? 'pausado' : 'retomado'}`);
  return res.json({ ok: true, action, paused });
}

/** `harvester-drain` — sem `max` no corpo vale o HARVEST_DRAIN_MAX_WORKS do gateway. */
export async function harvestDrain({ services, req, res, action }: ActionDeps): Promise<express.Response> {
  const before = harvestStatusSnapshot();
  const drained = await drainNativeHarvest(maxFromBody(req));
  const after = await refreshHarvestStatus();
  if (drained <= 0 && (!refreshLanded(before, after) || !harvestNativeOnline())) {
    services.metrics.count('dashboard.harvest.unavailable');
    services.log.warn('[dashboard] drenagem do colhedor nativo indisponível');
    return res.json({ ok: false, action, drained: 0, error: HARVEST_OFFLINE });
  }
  services.metrics.count('dashboard.harvest.drain', drained);
  services.log.info(`[dashboard] fila do colhedor nativo drenada: ${drained} obra(s)`);
  return res.json({
    ok: true,
    action,
    drained,
    // Contrato antigo preservado (`drain()` devolvia os três campos).
    // `null` = o snapshot não respondeu; o painel mostra 0 e o poll corrige.
    queueRemaining: after?.depth ?? null,
    paused: after?.paused ?? false,
  });
}

/** `harvester-clear-queue` — destrutiva; o `confirm` é checado no despacho. */
export async function harvestClearQueue({ services, res, action }: ActionDeps): Promise<express.Response> {
  const before = harvestStatusSnapshot();
  const cleared = await clearNativeHarvest();
  const after = await refreshHarvestStatus();
  if (cleared <= 0 && (!refreshLanded(before, after) || !harvestNativeOnline())) {
    services.metrics.count('dashboard.harvest.unavailable');
    services.log.warn('[dashboard] limpeza da fila do colhedor nativo indisponível');
    return res.json({ ok: false, action, cleared: 0, error: HARVEST_OFFLINE });
  }
  services.metrics.count('dashboard.harvest.clear_queue');
  services.log.info(`[dashboard] fila do colhedor nativo limpa: ${cleared} obra(s) removida(s)`);
  return res.json({ ok: true, action, cleared });
}
