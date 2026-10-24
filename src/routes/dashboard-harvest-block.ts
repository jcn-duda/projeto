// Bloco `harvest` do /dashboard-status.json.
//
// Desde a Fase 5 o colhedor roda no gateway Rust: o Node não tem mais fila,
// worker nem balde horário próprios. O bloco é a foto do `GET /harvest`
// espelhada em memória pela ponte (`harvestStatusSnapshot`), portanto LEITURA
// SÍNCRONA — quem fala com o gateway é o poll de fundo (`startHarvestPolling`),
// nunca este bloco.
//
// O shape é o MESMO que o painel já consome (`queueDepth`/`queuePreview`/
// `lastWorks`/…) porque trocar o nome dos campos obrigaria a mexer em todas as
// views; os campos nativos que não tinham equivalente (`ok`, `native`, `store`,
// `counters`, `inflight`, `intervalMs`) entram como ADITIVOS.
import type { AppServices } from './types.js';
import { harvestStatusSnapshot } from '../utils/harvest-native.js';

/** Estado neutro: gateway fora do ar ou ainda sem o primeiro poll. */
function offlineBlock(): Record<string, unknown> {
  return {
    // `ok:false` + `native:false` é o par que a view usa para dizer "sem
    // gateway" em vez de pintar "DESLIGADO" com zeros que ninguém mediu.
    ok: false,
    native: false,
    store: null,
    enabled: false,
    paused: false,
    inflight: false,
    queueDepth: 0,
    // Teto/intervalo são CONFIGURAÇÃO, não medida: sem snapshot o painel
    // mostra 0 (e a view omite o alvo do StatNumber) em vez de inventar 100/20.
    queueMax: 0,
    harvested: 0,
    queriesThisHour: 0,
    maxPerHour: 0,
    lastRunAt: null,
    intervalMs: 0,
    idleWindowMs: 0,
    queuePreview: [],
    lastWorks: [],
    counters: { drained: 0, failed: 0 },
    _origem: {
      queriesThisHour: 'naomedido',
      queueDepth: 'naomedido',
      enabled: 'naomedido',
      lastRunAt: 'naomedido',
      paused: 'naomedido',
      config: 'amostra',
    },
  };
}

/**
 * Bloco `harvest`. `ok`/`native`/`enabled` vêm do gateway; `queueMax` e
 * `idleWindowMs` são o knob local (`HARVEST_QUEUE_MAX`/`HARVEST_IDLE_WINDOW_MS`,
 * os MESMOS nomes que o gateway lê) e `config`/`debrid*` continuam sendo o
 * overlay do Node — o painel os usa para a config ao vivo e a conta de fundo.
 */
export function harvestBlock(services: AppServices): Record<string, unknown> {
  const native = harvestStatusSnapshot();
  const live = services.harvesterLive.effective();
  const local = {
    queueMax: live.harvestQueueMax,
    idleWindowMs: live.harvestIdleWindowMs,
    config: services.harvesterLive.snapshot(),
    debridAccount: services.harvesterDebrid.snapshot(),
    debridResolved: services.harvesterDebrid.resolveQuota()?.adapter?.id ?? null,
  };

  if (!native) return { ...offlineBlock(), ...local };

  // `last` chega em ordem cronológica (o `note_drain` do Rust empurra no fim).
  const lastAt = native.last.length > 0 ? native.last[native.last.length - 1].at : 0;

  return {
    ok: native.ok,
    native: true,
    store: native.store || null,
    enabled: native.enabled,
    paused: native.paused,
    inflight: native.inflight,
    queueDepth: native.depth,
    harvested: native.counters.drained,
    queriesThisHour: native.queriesThisHour,
    maxPerHour: native.maxPerHour,
    lastRunAt: lastAt > 0 ? new Date(lastAt).toISOString() : null,
    intervalMs: native.intervalMs,
    queuePreview: native.preview,
    // O worker Node gravava `recorded` (releases); o nativo publica `queries`
    // (consultas ao Jackett). A view lê `queries` e mantém `recorded` como
    // fallback de payload antigo — nada de inventar um número no lugar do outro.
    lastWorks: native.last.map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })),
    counters: { ...native.counters },
    ...local,
    // Mesma semântica de antes: fila/balde são duráveis (agora no store do
    // gateway); enabled/paused/lastRunAt são a foto do processo.
    _origem: {
      queriesThisHour: 'duravel',
      queueDepth: 'duravel',
      enabled: 'amostra',
      lastRunAt: 'amostra',
      paused: 'amostra',
      config: 'amostra',
    },
  };
}
