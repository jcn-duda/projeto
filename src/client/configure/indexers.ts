/* Adom Power-Movie - /configure: saneamento do catálogo de indexers, cards,
 * status medido e prioridade. O status é atualizado por polling leve sem
 * reaplicar configuração — seleção, prioridade e demais opções continuam
 * exclusivamente sob controle do usuário. */

import { state } from './state.js';
import { render, setPresetChoice } from './view.js';

export function safeJackettIndexer(item: any): any {
  if (!item || typeof item !== 'object') return null;
  const id = item.id == null ? '' : String(item.id).trim().toLowerCase();
  if (!id) return null;
  const label = item.label == null ? id : String(item.label);
  const language = item.language == null ? '' : String(item.language);
  const isBr = item.isBr === true || item.isBr === 1 || item.isBr === 'true';
  const rawStatus = item.status;
  let status = null;
  if (rawStatus && typeof rawStatus === 'object') {
    const stateName = String(rawStatus.state || '');
    if (stateName === 'online' || stateName === 'slow' || stateName === 'degraded' || stateName === 'offline') {
      status = {
        state: stateName,
        ms: typeof rawStatus.ms === 'number' && isFinite(rawStatus.ms) && rawStatus.ms >= 0 ? rawStatus.ms : null,
        checkedAt: rawStatus.checkedAt == null ? null : String(rawStatus.checkedAt),
      };
    }
  }
  return { id, label, language, isBr, status };
}

export function statusText(status: any): string {
  if (!status || !status.state) return 'ainda não consultado';
  const text = status.ms != null ? status.state + ' · ' + (status.ms / 1000).toFixed(1) + 's' : status.state;
  const checked = Date.parse(status.checkedAt);
  if (!isFinite(checked)) return text;
  const age = Math.max(0, Math.floor((Date.now() - checked) / 1000));
  if (age < 60) return text + ' · medido agora';
  if (age < 3600) return text + ' · medido há ' + Math.floor(age / 60) + ' min';
  return text + ' · medido há ' + Math.floor(age / 3600) + ' h';
}

export function renderIndexerStatus(item: any): void {
  const el = state.el;
  let card = null;
  const cards = el.jackettIndexers.querySelectorAll('.indexer-card');
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].getAttribute('data-indexer-id') === item.id) {
      card = cards[i];
      break;
    }
  }
  if (!card) return;
  const statusEl = card.querySelector('.indexer-status');
  if (!statusEl) return;
  const status = item.status;
  const stateName = status && status.state ? status.state : 'unknown';
  statusEl.className = 'indexer-status status-' + stateName;
  statusEl.setAttribute('aria-label', 'Status: ' + statusText(status));
  const dot = statusEl.querySelector('.status-dot');
  const text = statusEl.querySelector('.status-text');
  if (dot) dot.setAttribute('aria-hidden', 'true');
  if (text) text.textContent = statusText(status);
}

export function renderIndexerStatuses(): void {
  state.jackettIndexers.forEach(renderIndexerStatus);
}

export function setIndexerStatus(id: string, status: any): void {
  for (let i = 0; i < state.jackettIndexers.length; i++) {
    if (state.jackettIndexers[i].id === id) {
      state.jackettIndexers[i].status = status;
      renderIndexerStatus(state.jackettIndexers[i]);
      return;
    }
  }
}

export function fillJackettIndexers(list: any): void {
  const el = state.el;
  state.jackettIndexers = [];
  el.jackettIndexers.textContent = '';
  (Array.isArray(list) ? list : []).forEach((raw: any) => {
    const item = safeJackettIndexer(raw);
    if (!item) return;
    for (let i = 0; i < state.jackettIndexers.length; i++) {
      if (state.jackettIndexers[i].id === item.id) return;
    }
    state.jackettIndexers.push(item);

    const card = document.createElement('div');
    card.className = 'indexer-card';
    card.setAttribute('data-indexer-id', item.id);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip indexer-toggle';
    chip.setAttribute('data-value', item.id);
    chip.setAttribute('aria-pressed', 'false');
    chip.setAttribute('aria-label', 'Ativar indexador ' + item.label);
    // textContent evita que um label da instância vire HTML.
    chip.textContent = item.label + (item.isBr ? ' · BR' : '') + (item.language ? ' · ' + item.language : '');

    const status = document.createElement('div');
    status.className = 'indexer-status';
    status.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    const statusLabel = document.createElement('span');
    statusLabel.className = 'status-text';
    status.appendChild(dot);
    status.appendChild(statusLabel);

    const limitControl = document.createElement('label');
    limitControl.className = 'indexer-limit-control';
    const limitLabel = document.createElement('span');
    limitLabel.className = 'indexer-limit-label';
    limitLabel.textContent = 'Limite';
    const limit = document.createElement('select');
    limit.className = 'indexer-limit';
    limit.setAttribute('data-indexer-id', item.id);
    limit.setAttribute('aria-label', 'Limite individual de streams para ' + item.label);
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'padrão geral';
    limit.appendChild(defaultOption);
    const unlimitedOption = document.createElement('option');
    unlimitedOption.value = '0';
    unlimitedOption.textContent = 'sem limite';
    limit.appendChild(unlimitedOption);
    for (let limitValue = 1; limitValue <= 20; limitValue++) {
      const option = document.createElement('option');
      option.value = String(limitValue);
      option.textContent = String(limitValue);
      limit.appendChild(option);
    }
    limitControl.setAttribute('aria-label', 'Limite individual de streams para ' + item.label);
    limitControl.appendChild(limitLabel);
    limitControl.appendChild(limit);
    limitControl.addEventListener('click', (ev) => { ev.stopPropagation(); });
    limit.addEventListener('click', (ev) => { ev.stopPropagation(); });
    limit.addEventListener('change', (ev) => {
      ev.stopPropagation();
      setPresetChoice('custom');
      render();
    });

    const priority = document.createElement('button');
    priority.type = 'button';
    priority.className = 'priority-btn';
    priority.setAttribute('data-value', item.id);
    priority.setAttribute('aria-pressed', 'false');
    priority.setAttribute('aria-label', 'Marcar ' + item.label + ' como prioridade alta');
    priority.setAttribute('title', 'Prioridade alta');
    priority.textContent = '☆';

    card.appendChild(chip);
    card.appendChild(status);
    card.appendChild(limitControl);
    card.appendChild(priority);
    el.jackettIndexers.appendChild(card);
    renderIndexerStatus(item);
  });
}

export function allJackettIndexerIds(): string[] {
  return state.jackettIndexers.map((item) => item.id);
}

export function normalizePriority(values: any): string[] {
  const result: string[] = [];
  if (!Array.isArray(values)) return result;
  for (let i = 0; i < values.length; i++) {
    const id = String(values[i]).trim().toLowerCase();
    let known = false;
    for (let j = 0; j < state.jackettIndexers.length; j++) {
      if (state.jackettIndexers[j].id === id) { known = true; break; }
    }
    if (known && result.indexOf(id) === -1) result.push(id);
  }
  return result;
}

export function refreshIndexerStatuses(defaults: any): void {
  const latest: Record<string, any> = {};
  const list = defaults && Array.isArray(defaults.jackettIndexers) ? defaults.jackettIndexers : [];
  list.forEach((raw: any) => {
    const item = safeJackettIndexer(raw);
    if (item) latest[item.id] = item.status;
  });
  // Atualiza somente a medição dos cards existentes; seleção e prioridade
  // continuam sendo exclusivamente controladas pelo usuário.
  state.jackettIndexers.forEach((item) => {
    if (Object.prototype.hasOwnProperty.call(latest, item.id)) setIndexerStatus(item.id, latest[item.id]);
  });
}

export function pollIndexerStatuses(): void {
  if (state.indexerStatusPollInFlight) return;
  state.indexerStatusPollInFlight = true;
  // O parâmetro variável impede que navegador ou proxy devolva o catálogo
  // anterior, sem depender de opções modernas da API de fetch.
  fetch('/defaults.json?statusAt=' + new Date().getTime())
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(refreshIndexerStatuses)
    .catch(() => {
      // Falha no polling não interrompe a configuração nem substitui a
      // última medição visível.
    })
    .then(() => { state.indexerStatusPollInFlight = false; });
}
