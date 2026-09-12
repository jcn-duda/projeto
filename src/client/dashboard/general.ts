/* Adom Power-Movie — /dashboard: processo, serviços e contadores (C3, ESM).
 * Pinta #generalDiagnostics sob a seção Geral com o que o /dashboard-status.json
 * JÁ entrega a cada poll e a tela descartava: memória do processo, estado dos
 * serviços (Jackett tri-estado) e contadores sem painel próprio. Sem rede, sem
 * ações. Nada toca o DOM no import. */

import { $, first, isObject, valueText } from './core.js';
import { empty, formatBytes, formatDuration, metric, metricGroupTitle } from './render.js';

// Tri-estado do Jackett: true/false/'naomedido' NÃO pode virar "não" nem "sim"
// por coerção; cada estado tem rótulo próprio (mesma convenção do estado vazio
// e do banner de saúde).
function generalServiceStateFlag(value: any): string {
  if (value === true) return 'online';
  if (value === false) return 'offline';
  if (value === 'naomedido') return 'não medido';
  return valueText(value);
}

// Contador de eventos (desde o restart) que não tem casa em outro painel. Zero é
// informação: diferente de uma medição ausente, "nunca aconteceu" vale para a
// janela do processo.
function generalCounter(counters: any, key: string): number {
  return Number(isObject(counters) ? counters[key] || 0 : 0);
}

export function renderGeneralDiagnostics(root: any): void {
  const box = $('generalDiagnostics');
  if (!box) return;
  box.textContent = '';
  const general = isObject(root) && isObject(root.general) ? root.general : null;
  if (!general) { empty(box, 'Sem dados de processo.'); return; }
  const memory = isObject(general.memory) ? general.memory : {};
  const services = isObject(general.services) ? general.services : {};
  const counters = isObject(root.metrics) && isObject(root.metrics.counters) ? root.metrics.counters : {};
  const magnetdb = isObject(root.magnetdb) ? root.magnetdb : {};
  const dbCounters = isObject(magnetdb.counters) ? magnetdb.counters : {};
  const idx = first(root, ['releaseIndex', 'index', 'idx'], {});

  // 1. Memória do processo — bytes crus do process.memoryUsage().
  metricGroupTitle(box, 'Memória do processo');
  metric(box, 'RSS', formatBytes(memory.rss || 0));
  metric(box, 'Heap usado', formatBytes(memory.heapUsed || 0));
  metric(box, 'Heap total', formatBytes(memory.heapTotal || 0));

  // 2. Serviços — prova local de cada dependência. `resolvers` é a contagem dos
  // resolvers embutidos vivos (0 é estado válido, não "não medido").
  metricGroupTitle(box, 'Serviços');
  metric(box, 'addon', generalServiceStateFlag(services.addon));
  metric(box, 'jackett', generalServiceStateFlag(services.jackett));
  metric(box, 'debrid', generalServiceStateFlag(services.debrid));
  metric(box, 'resolvers embutidos', services.resolvers);

  // 3. Contadores de diagnóstico sem painel próprio.
  metricGroupTitle(box, 'Contadores de diagnóstico (desde o restart)');
  metric(box, 'debrid.cleanup.protectedBrSkipped', generalCounter(counters, 'debrid.cleanup.protectedBrSkipped'));
  metric(box, 'debrid.instant.fromAliveAsCache', generalCounter(counters, 'debrid.instant.fromAliveAsCache'));
  metric(box, 'magnetdb.counters.dropped', Number(isObject(dbCounters) ? dbCounters.dropped || 0 : 0));

  // 4. Jackett desperdiçado — separado de propósito em resposta (caminho crítico
  // do usuário) e fundo (colhedor/enriquecimento), que são baldes distintos.
  metricGroupTitle(box, 'Jackett desperdiçado');
  metric(box, 'wastedQueries (resposta)', Number(idx.wastedQueries || 0));
  metric(box, 'wastedMs (resposta)', formatDuration(Number(idx.wastedMs || 0)));
  metric(box, 'wastedQueries.background', Number(idx.wastedQueriesBackground || 0));
  metric(box, 'wastedMs.background', formatDuration(Number(idx.wastedMsBackground || 0)));
}
