/* Adom Power-Movie — /dashboard: diagnóstico de stall do Chupim (C3, ESM).
 * O /dashboard-status.json já entrega os lotes de recheck (autofetch.lots), os
 * locks pendentes, os slots de busca ocupados e as buscas em voo — nenhum deles
 * aparecia na tela. Pinta #afStallMetrics. Nada toca o DOM no import. */

import { $, isObject, valueText } from './core.js';
import { asList, element, empty, formatDate, formatDuration, metric, metricGroupTitle } from './render.js';

function afSkipsTotal(skips: any): number {
  let total = 0;
  if (!isObject(skips)) return 0;
  const keys = Object.keys(skips);
  for (let i = 0; i < keys.length; i += 1) total += Number(skips[keys[i]] || 0);
  return total;
}

// Uma linha por lote: o que o recheck está segurando e há quanto tempo. O id é o
// sha256(searchKey) truncado — nunca a chave de busca crua.
function afLotsTable(lots: any[]): any {
  const table = element('table', 'timer-table');
  const head = element('thead');
  const headRow = element('tr');
  const body = element('tbody');
  const headers = ['lote', 'hashes', 'tentativas', 'idade', 'recusas', 'estado'];
  for (let i = 0; i < headers.length; i += 1) headRow.appendChild(element('th', '', headers[i]));
  head.appendChild(headRow);
  table.appendChild(head);
  for (let i = 0; i < lots.length; i += 1) {
    let state = lots[i].isSettle ? 'settle' : 'recheck';
    if (lots[i].inFlight) state += ' · em voo';
    const row = element('tr');
    row.appendChild(element('td', 'timer-name', valueText(lots[i].id)));
    row.appendChild(element('td', 'num', valueText(lots[i].hashes)));
    row.appendChild(element('td', 'num', valueText(lots[i].attempts)));
    row.appendChild(element('td', 'num', formatDuration(lots[i].ageMs)));
    row.appendChild(element('td', 'num', valueText(lots[i].refusals)));
    row.appendChild(element('td', '', state));
    body.appendChild(row);
  }
  table.appendChild(body);
  return table;
}

function afSkipLine(entry: any): string {
  let text = valueText(entry.reason);
  if (entry.pool) text += ' · pool ' + valueText(entry.pool);
  if (entry.adapter) text += ' · ' + valueText(entry.adapter);
  if (entry.label) text += ' · ' + valueText(entry.label);
  if (entry.at) text += ' · ' + formatDate(entry.at);
  return text;
}

// Snapshot completo do estado de stall. `af` é o bloco autofetch inteiro:
// pendingLocks/searchSlots/seasonSearchKeys/searchesInFlight vêm do snapshot do
// runner + autofetchStatus (providers/index.ts).
export function renderAutofetchStall(af: any, uptimeS: any): void {
  const box = $('afStallMetrics');
  if (!box) return;
  box.textContent = '';
  if (!isObject(af)) { empty(box, 'Sem dados de stall do Chupim.'); return; }
  const slots = isObject(af.searchSlots) ? af.searchSlots : {};
  const lots = asList(af.lots, 'lots');
  const last = asList(af.lastSkips, 'lastSkips');

  metricGroupTitle(box, 'Stall: locks, slots e buscas');
  metric(box, 'pendingLocks', Number(af.pendingLocks || 0));
  metric(box, 'searchSlots (buscas)', Number(slots.searches || 0));
  metric(box, 'searchSlots (ocupados)', Number(slots.occupied || 0));
  metric(box, 'seasonSearchKeys', Number(af.seasonSearchKeys || 0));
  metric(box, 'searchesInFlight', Number(af.searchesInFlight || 0));
  metric(box, 'lotes recheck', lots.length);
  metric(box, 'desistências registradas', afSkipsTotal(af.skips));

  if (lots.length) {
    metricGroupTitle(box, 'Lotes em recheck/settle');
    box.appendChild(afLotsTable(lots));
  }

  metricGroupTitle(box, 'Últimas desistências');
  if (!last.length) {
    box.appendChild(element('p', 'guidance', 'Nenhuma desistência registrada desde o boot.'));
    return;
  }
  // Teto curto: o painel já mostra a contagem por motivo e o último registro;
  // aqui basta o rastro recente para correlacionar com um lote parado.
  for (let i = 0; i < last.length && i < 5; i += 1) {
    box.appendChild(element('p', 'guidance', afSkipLine(last[i])));
  }
}
