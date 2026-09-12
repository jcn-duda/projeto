/* Adom Power-Movie — /dashboard: latências e percentis (C3, ESM nativo).
 * Tabela a partir de metrics.timers (count/avgMs/p50Ms/p95Ms/maxMs): uma linha
 * por indexer.<id> e pelos timers search.* relevantes. É o quadro "quem está
 * puxando o prazo", que o back-end já entrega em cada poll. Nada toca o DOM no
 * import. */

import { $, isObject } from './core.js';
import { element, empty, formatDuration } from './render.js';

const TIMER_HEADERS = ['timer', 'n', 'média', 'p50', 'p95', 'máx'];

// Filtro de relevância: índice por indexador e a família search.* do caminho da
// resposta. O resto (debrid.*, cache.*, autofetch.*) tem painel próprio.
function timerSelected(name: string): boolean {
  return name.indexOf('indexer.') === 0 || name.indexOf('search.') === 0;
}

function timerRow(name: string, timing: any): any {
  const t = isObject(timing) ? timing : {};
  return { name, count: t.count, avg: t.avgMs, p50: t.p50Ms, p95: t.p95Ms, max: t.maxMs };
}

function timerMs(value: any): string {
  const n = Number(value);
  if (!isFinite(n)) return '—';
  return formatDuration(n);
}

function timerCount(value: any): string {
  const n = Number(value);
  if (!isFinite(n)) return '—';
  return String(n);
}

// indexer.* primeiro (onde mora a latência de rede), search.* depois — cada
// bloco em ordem alfabética para a leitura não depender da ordem de escrita.
function timerRows(timers: any): any[] {
  const indexers: any[] = [];
  const search: any[] = [];
  if (!isObject(timers)) return indexers;
  const keys = Object.keys(timers).sort();
  for (let i = 0; i < keys.length; i += 1) {
    const name = keys[i];
    if (!timerSelected(name)) continue;
    if (name.indexOf('indexer.') === 0) indexers.push(timerRow(name, timers[name]));
    else search.push(timerRow(name, timers[name]));
  }
  return indexers.concat(search);
}

function timerTable(rows: any[]): any {
  const table = element('table', 'timer-table');
  const head = element('thead');
  const headRow = element('tr');
  const body = element('tbody');
  for (let i = 0; i < TIMER_HEADERS.length; i += 1) headRow.appendChild(element('th', '', TIMER_HEADERS[i]));
  head.appendChild(headRow);
  table.appendChild(head);
  for (let i = 0; i < rows.length; i += 1) {
    const row = element('tr');
    row.appendChild(element('td', 'timer-name', rows[i].name));
    row.appendChild(element('td', 'num', timerCount(rows[i].count)));
    row.appendChild(element('td', 'num', timerMs(rows[i].avg)));
    row.appendChild(element('td', 'num', timerMs(rows[i].p50)));
    row.appendChild(element('td', 'num', timerMs(rows[i].p95)));
    row.appendChild(element('td', 'num', timerMs(rows[i].max)));
    body.appendChild(row);
  }
  table.appendChild(body);
  return table;
}

// Painel do bloco `metrics.timers`. Container próprio (#timerMetrics) sob a
// seção Geral; recebe o root inteiro porque o payload de timers mora em metrics.
export function renderTimersPanel(root: any): void {
  const box = $('timerMetrics');
  const metrics = isObject(root) && isObject(root.metrics) ? root.metrics : {};
  if (!box) return;
  const rows = timerRows(metrics.timers);
  box.textContent = '';
  if (!rows.length) {
    empty(box, 'Sem medições de latência ainda.');
    return;
  }
  box.appendChild(element('p', 'metric-group', 'Latência por indexador e busca'));
  box.appendChild(timerTable(rows));
}
