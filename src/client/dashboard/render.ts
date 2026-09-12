/* Adom Power-Movie — /dashboard: helpers de renderização (C3, ESM nativo).
 * Aqui mora só o que DESENHA (formatação, criação de nós, metric/card/
 * sparkline). HTTP continua no core; o estado mutável vive em state.ts. Os
 * helpers puros de _origem também vêm do core, porque módulos não-visuais os
 * consomem. Nada toca o DOM no import. */

import { $, first, isObject, isAmostraCedo, origemOf, origemTitle, origemValue, own, valueText } from './core.js';
import { hooks } from './hooks.js';

export function titleText(value: any): string {
  return String(value || 'sem nome').replace(/[-_]+/g, ' ');
}

export function formatBytes(value: any): string {
  let number = Number(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  if (!isFinite(number) || number < 0) return valueText(value);
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit += 1; }
  return number.toFixed(unit === 0 ? 0 : number < 10 ? 1 : 0) + ' ' + units[unit];
}

export function formatDuration(value: any): string {
  let number = Number(value);
  if (!isFinite(number)) return valueText(value);
  if (number < 1000) return Math.round(number) + ' ms';
  number /= 1000;
  if (number < 60) return number.toFixed(1) + ' s';
  return Math.floor(number / 60) + ' min ' + Math.round(number % 60) + ' s';
}

export function formatDate(value: any): string {
  if (!value) return '—';
  const date = new Date(value);
  return isNaN(date.getTime()) ? valueText(value) : date.toLocaleString('pt-BR');
}

export function prettyKey(key: any): string {
  return titleText(key).replace(/\b(ms|id|br|db|rss|l1|l2)\b/gi, (part) => part.toUpperCase());
}

export function displayValue(key: any, value: any): string {
  const lower = String(key).toLowerCase();
  if (lower.indexOf('bytes') !== -1 || lower.indexOf('memory') !== -1 || lower === 'rss' || lower === 'heapused') return formatBytes(value);
  // metrics.ts produz uptimeS em SEGUNDOS ((now - startedAt)/1000);
  // formatDuration espera milissegundos. Sem a conversão, um container de pé
  // há 1 h (3612 s) renderizava "3.6 s" — erro de 1000x.
  if (lower === 'uptimes') return formatDuration(value * 1000);
  if (lower.indexOf('uptime') !== -1 || lower.indexOf('duration') !== -1 || lower.indexOf('latency') !== -1 || /ms$/.test(lower)) return formatDuration(value);
  // Data é a chave que TERMINA em "at" (generatedAt, lastRunAt...), não a que
  // contém "at" em qualquer posição: com indexOf, hitRate, deadlineMetadata e
  // brLate viravam 31/12/1969 no painel.
  if (/at$/.test(lower) && (typeof value === 'string' || typeof value === 'number')) return formatDate(value);
  return valueText(value);
}

export function stateName(value: any): string {
  const text = String(value === undefined || value === null ? 'unknown' : value).toLowerCase();
  if (value === true || text === 'ok' || text === 'online' || text === 'ready' || text === 'healthy' || text === 'up' || text === 'available') return 'online';
  if (text.indexOf('slow') !== -1 || text.indexOf('degrad') !== -1 || text === 'warn' || text === 'warning' || text === 'partial') return 'warn';
  if (value === false || text === 'offline' || text === 'error' || text === 'dead' || text === 'down' || text === 'failed' || text === 'unusable') return 'error';
  return 'unknown';
}

export function stateLabel(value: any): string {
  const state = stateName(value);
  return state === 'online' ? 'online' : state === 'warn' ? 'atenção' : state === 'error' ? 'offline' : 'não medido';
}

export function element(name: string, className?: string, text?: any): any {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function empty(container: any, text: string): void {
  container.textContent = '';
  container.appendChild(element('div', 'empty', text));
}

// Título de grupo dentro do grid de métricas: separa procedência (persistente ×
// amostra) sem criar seção nova no HTML. Vive aqui (desenho puro) porque o
// painel do MagnetDB e os subpainéis também o consomem.
export function metricGroupTitle(container: any, text: string): void {
  container.appendChild(element('p', 'metric-group', text));
}

export function clear(container: any): void { container.textContent = ''; }

export function applyOrigem(el: any, value: any, kind: string | null, uptimeS: any): void {
  if (!el) return;
  el.textContent = origemValue(value, kind);
  const title = origemTitle(kind, uptimeS);
  if (title) el.title = title;
  else if (typeof el.removeAttribute === 'function') el.removeAttribute('title');
  if (kind === 'amostra' && isAmostraCedo(uptimeS)) {
    el.className = String(el.className || '').replace(/\bamostra-cedo\b/g, '').replace(/\s+/g, ' ').trim() + ' amostra-cedo';
  }
}

// KPI sem corte: o CSS nunca trunca chave nem valor (sem line-clamp); o texto
// integral no title segue como tooltip/hover para textos longos.
export function metricOrigem(container: any, key: string, value: any, kind: string | null, uptimeS: any): void {
  const item = element('div', 'metric');
  const text = origemValue(value, kind);
  const content = element('span', 'value' + (String(text).length > 20 ? ' small' : ''), text);
  const title = origemTitle(kind, uptimeS);
  content.title = title ? title : String(text);
  if (kind === 'amostra' && isAmostraCedo(uptimeS)) content.className += ' amostra-cedo';
  const keyEl = element('span', 'key', prettyKey(key));
  keyEl.title = prettyKey(key);
  item.appendChild(keyEl);
  item.appendChild(content);
  container.appendChild(item);
}

// Fail-open: sem _origem[field] cai no metric() antigo (payload sem o campo).
export function metricMaybeOrigem(container: any, key: string, value: any, map: any, field: string, uptimeS: any): void {
  const kind = origemOf(map, field);
  if (kind) metricOrigem(container, key, value, kind, uptimeS);
  else metric(container, key, value);
}

export function metric(container: any, key: any, value: any): void {
  const item = element('div', 'metric');
  const shown = displayValue(key, value);
  const keyEl = element('span', 'key', prettyKey(key));
  const valueEl = element('span', 'value' + (String(valueText(value)).length > 20 ? ' small' : ''), shown);
  keyEl.title = prettyKey(key);
  valueEl.title = String(shown);
  item.appendChild(keyEl);
  item.appendChild(valueEl);
  container.appendChild(item);
}

export function renderMetrics(container: any, object: any, excluded?: any): void {
  if (!isObject(object)) { empty(container, 'Nenhuma métrica disponível.'); return; }
  const keys = Object.keys(object);
  for (let i = 0; i < keys.length; i += 1) {
    if (excluded && excluded[keys[i]]) continue;
    if (object[keys[i]] === null || typeof object[keys[i]] === 'object') continue;
    metric(container, keys[i], object[keys[i]]);
  }
  if (!container.children.length) empty(container, 'Nenhuma métrica disponível.');
}

export function asList(value: any, preferredKey?: string): any[] {
  const result: any[] = [];
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return result;
  if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
  if (Array.isArray(value.items)) return value.items;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const item = value[keys[i]];
    if (isObject(item)) {
      if (!own(item, 'id') && !own(item, 'name') && !own(item, 'label')) item.id = keys[i];
      result.push(item);
    } else {
      result.push({ id: keys[i], value: item });
    }
  }
  return result;
}

export function renderCollection(container: any, source: any, preferredKey?: string, options?: any): void {
  const list = asList(source, preferredKey);
  container.textContent = '';
  if (!list.length) { empty(container, 'Nenhum item reportado.'); return; }
  for (let i = 0; i < list.length; i += 1) card(container, list[i], options || {});
}

export function card(container: any, item: any, options?: any): void {
  const box = element('details', 'card');
  const head = element('summary', 'card-head');
  const title = first(item, ['label', 'name', 'title', 'id'], (options && options.fallback) || 'sem nome');
  let state = first(item, ['state', 'status', 'health', 'online', 'ready'], 'unknown');
  if (isObject(state)) state = first(state, ['state', 'status', 'health'], 'unknown');
  const stateBox = element('span', 'state status-' + stateName(state));
  const dot = element('span', 'dot');
  const stateText = element('span', '', stateLabel(state));
  const excluded: Record<string, boolean> = { id: true, label: true, name: true, title: true, state: true, status: true, health: true, online: true, ready: true, error: true, message: true };
  const rows = element('div', 'status-list');
  box.setAttribute('data-status', stateName(state));
  head.appendChild(element('h3', '', titleText(title)));
  stateBox.appendChild(dot); stateBox.appendChild(stateText);
  head.appendChild(stateBox); box.appendChild(head);
  if (first(item, ['description', 'detail', 'message', 'error'], null)) box.appendChild(element('p', 'card-subtitle', valueText(first(item, ['description', 'detail', 'message', 'error'], ''))));
  if (item.reason && item.fix) box.appendChild(element('p', 'guidance' + (item.reason === 'rate' ? '' : ' error'), 'Como corrigir: ' + valueText(item.fix)));
  const keys = Object.keys(item);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]; const value = item[key];
    if (excluded[key] || value === null || typeof value === 'object') continue;
    const line = element('div', 'status-line');
    line.appendChild(element('span', '', prettyKey(key)));
    line.appendChild(element('strong', '', displayValue(key, value)));
    rows.appendChild(line);
  }
  if (rows.children.length) box.appendChild(rows);
  if (options && options.testable) {
    // Resolver BR tem teste próprio (/test-resolver.json): botão e handler
    // distintos, o card em si continua igual ao do indexador. Os handlers são
    // hooks (probes.ts) — render não cita o módulo das sondas e wiring
    // incompleto falha explicitamente, em vez de deixar um botão inerte.
    let button: any;
    if (options.kind === 'resolver') {
      button = element('button', 'mini-action', 'Testar este resolver');
      button.type = 'button';
      button.setAttribute('data-resolver-id', String(first(item, ['id', 'key', 'name'], '')));
      button.addEventListener('click', () => { hooks.call('runResolverTest', button.getAttribute('data-resolver-id'), button); });
    } else {
      button = element('button', 'mini-action', 'Testar este indexador');
      button.type = 'button';
      button.setAttribute('data-indexer-id', String(first(item, ['id', 'key', 'name'], '')));
      button.addEventListener('click', () => { hooks.call('runIndexerTest', button.getAttribute('data-indexer-id'), button); });
    }
    box.appendChild(button);
  }
  container.appendChild(box);
}

export function drawSparkline(id: string, values: number[], color: string): void {
  const el = $(id);
  if (!el || values.length < 2) return;
  const max = Math.max.apply(Math, values);
  const min = Math.min.apply(Math, values);
  const points: string[] = [];
  let i: number;
  if (el.getContext) {
    const context = el.getContext('2d');
    if (context) {
      context.clearRect(0, 0, el.width, el.height);
      context.beginPath();
      context.strokeStyle = color;
      context.lineWidth = 2;
      for (i = 0; i < values.length; i += 1) {
        const x = (i / (values.length - 1)) * el.width;
        const y = max === min ? el.height / 2 : el.height - ((values[i] - min) / (max - min)) * (el.height - 4) - 2;
        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    }
  }
  const poly = el.querySelector ? el.querySelector('polyline, path') : null;
  if (poly) {
    for (i = 0; i < values.length; i += 1) {
      const sx = Math.round((i / (values.length - 1)) * 1000) / 10;
      const sy = max === min ? 12 : Math.round((22 - ((values[i] - min) / (max - min)) * 20) * 10) / 10;
      points.push(sx + ',' + sy);
    }
    if (String(poly.tagName).toLowerCase() === 'polyline') poly.setAttribute('points', points.join(' '));
    else poly.setAttribute('d', 'M ' + points.join(' L '));
    if (color) poly.style.stroke = color;
  }
}
