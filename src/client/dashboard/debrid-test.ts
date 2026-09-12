/* Adom Power-Movie — /dashboard: teste pontual de conta de debrid (C3, ESM).
 * Consulta PONTUAL: POST debrid-account-test com { service, key } atrás do token
 * de diagnóstico. A chave viaja no CORPO do POST (nunca na URL), não é salva em
 * lugar nenhum e o teste NÃO altera a conta do operador nem o .env. Nada toca o
 * DOM no import. */

import { $, first, isObject, knownServices, requestJson, valueText } from './core.js';
import { clear, element, empty, prettyKey, stateLabel, stateName, titleText } from './render.js';
import { DashState } from './state.js';
import { reasonText } from './status-issues.js';

// Rótulos das capabilities do testAccount; chave nova do backend cai no prettyKey
// em vez de sumir.
const DEBRID_CAPABILITY_LABELS: Record<string, string> = {
  cacheCheck: 'consulta de cache',
  abortSafeCacheCheck: 'checagem abortável',
  accountStatus: 'consulta de ocupação',
  inventory: 'inventário da conta',
  autofetch: 'chupim (autofetch)',
  torrentStatus: 'estado de torrent',
  catalogCleanup: 'catálogo / limpeza',
};

function setDebridTestFeedback(text: string, kind?: string): void {
  const node = $('debridTestFeedback');
  if (!node) return;
  node.className = 'feedback' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
}

// O select nasce vazio no HTML e é preenchido da MESMA fonte dos cards de debrid
// (knownServices): serviço novo entra nos dois lugares juntos.
export function fillDebridTestServices(): void {
  const select = $('debridTestService');
  if (!select) return;
  select.textContent = '';
  for (let i = 0; i < knownServices.length; i += 1) {
    const option = document.createElement('option');
    option.value = knownServices[i].id;
    option.textContent = knownServices[i].label;
    select.appendChild(option);
  }
}

export function debridTestServiceLabel(id: any): string {
  const text = String(isObject(id) ? first(id, ['id', 'service'], '') : id || '').toLowerCase();
  for (let i = 0; i < knownServices.length; i += 1) {
    if (knownServices[i].id === text) return knownServices[i].label;
  }
  return text ? titleText(text) : 'serviço';
}

// Rótulo do serviço na resposta: o `label` do backend vence; o mapa local é o
// fallback (feedback antes do POST, resposta sem label).
function debridTestResponseLabel(data: any, serviceId: any): string {
  const label = isObject(data) ? data.label : null;
  return (typeof label === 'string' && label) ? label : debridTestServiceLabel(serviceId);
}

function debridTestState(data: any): string {
  if (!isObject(data)) return 'unknown';
  if (data.ok === false) return 'error';
  return stateName(first(data, ['status', 'state', 'health'], data.ok === true ? 'online' : 'unknown'));
}

// Motivo legível: reason traduzido pelo mapa do status, com o erro cru e o fix
// do backend anexados.
export function debridTestMotivo(data: any): string {
  const reason = isObject(data) ? data.reason : null;
  const detalhe = valueText(first(data, ['error', 'message'], ''));
  let motivo = reason ? reasonText(reason) : '';
  if (!motivo) motivo = detalhe !== '—' ? detalhe : 'motivo não informado';
  else if (detalhe !== '—') motivo += ' (' + detalhe + ')';
  if (isObject(data) && data.fix) motivo += ' — Como corrigir: ' + valueText(data.fix);
  return motivo;
}

// Magnets: o testAccount devolve account.magnets (total) + ready/active; formas
// alternativas (número solto, objeto com total/used/limit) seguem cobertas para o
// painel sobreviver a ajuste no backend.
function debridTestMagnetsText(data: any): string {
  const account = isObject(data) && isObject(data.account) ? data.account : {};
  const raw = first(data, ['magnets', 'magnetCount', 'magnetTotal'], first(account, ['magnets', 'magnetCount'], null));
  const partes: string[] = [];
  if (typeof raw === 'number' && isFinite(raw)) partes.push('total ' + String(raw));
  else if (typeof raw === 'string' && raw) return raw;
  if (isObject(raw)) {
    if (raw.total !== undefined && raw.total !== null) partes.push('total ' + valueText(raw.total));
    if (raw.used !== undefined && raw.used !== null) partes.push('usado ' + valueText(raw.used));
    if (raw.limit !== undefined && raw.limit !== null) partes.push('limite ' + valueText(raw.limit));
  }
  if (account.ready !== undefined && account.ready !== null) partes.push('prontos ' + valueText(account.ready));
  if (account.active !== undefined && account.active !== null) partes.push('baixando ' + valueText(account.active));
  return partes.join(' · ');
}

// Capabilities: objeto { cacheCheck: true, ... } ou lista de nomes. Booleano vira
// sim/não; rótulo conhecido traduz, desconhecido cai no prettyKey.
function debridTestCapLines(data: any): Array<{ label: string; value: string }> {
  const caps = first(data, ['capabilities', 'caps'], null);
  const lines: Array<{ label: string; value: string }> = [];
  if (Array.isArray(caps)) {
    for (let i = 0; i < caps.length; i += 1) {
      lines.push({ label: DEBRID_CAPABILITY_LABELS[caps[i]] || prettyKey(String(caps[i])), value: 'sim' });
    }
    return lines;
  }
  if (!isObject(caps)) return lines;
  const keys = Object.keys(caps);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const value = caps[key];
    if (value === null || typeof value === 'object') continue;
    lines.push({ label: DEBRID_CAPABILITY_LABELS[key] || prettyKey(key), value: valueText(value) });
  }
  return lines;
}

function debridTestLine(label: string, value: any): any {
  const line = element('div', 'status-line');
  line.appendChild(element('span', '', label));
  line.appendChild(element('strong', '', value));
  return line;
}

// Card simples, SEM <details>: o resultado do teste precisa estar visível de
// imediato, sem exigir um OK a mais no D-pad da TV para abrir.
function renderDebridTestResult(data: any): void {
  const out = $('debridTestOutput');
  if (!out) return;
  clear(out);
  if (!isObject(data)) { empty(out, 'Resposta do teste não chegou ao formato esperado.'); return; }
  const state = debridTestState(data);
  const box = element('div', 'card');
  box.setAttribute('data-status', state);
  const head = element('div', 'card-head');
  head.appendChild(element('h3', '', 'Teste · ' + debridTestResponseLabel(data, first(data, ['service', 'serviceId'], ''))));
  const stateBox = element('span', 'state status-' + state);
  stateBox.appendChild(element('span', 'dot'));
  stateBox.appendChild(element('span', '', stateLabel(state)));
  head.appendChild(stateBox);
  box.appendChild(head);
  const rows = element('div', 'status-list');
  rows.appendChild(debridTestLine('Serviço', debridTestResponseLabel(data, first(data, ['service', 'serviceId'], ''))));
  rows.appendChild(debridTestLine('Saúde', stateLabel(state)));
  const magnets = debridTestMagnetsText(data);
  if (magnets) rows.appendChild(debridTestLine('Magnets', magnets));
  const caps = debridTestCapLines(data);
  for (let i = 0; i < caps.length; i += 1) rows.appendChild(debridTestLine(caps[i].label, caps[i].value));
  box.appendChild(rows);
  if (data.ok === false) box.appendChild(element('p', 'guidance error', debridTestMotivo(data)));
  out.appendChild(box);
}

export function runDebridAccountTest(button?: any): void {
  const input = $('debridTestKey');
  const select = $('debridTestService');
  const service = select ? String(select.value || '') : '';
  const key = input ? String(input.value || '') : '';
  if (!service) { setDebridTestFeedback('Escolha o serviço da chave a testar.', 'warn'); return; }
  if (!key) { setDebridTestFeedback('Cole a chave de API do serviço escolhido.', 'warn'); return; }
  if (!DashState.token) { setDebridTestFeedback('Informe o token de diagnóstico antes de testar uma chave.', 'error'); if ($('token')) $('token').focus(); return; }
  if (button) button.disabled = true;
  setDebridTestFeedback('Testando chave no ' + debridTestServiceLabel(service) + '…', 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'debrid-account-test', service, key }),
  })
    .then((data: any) => {
      // A chave sai do input em TODO desfecho com resposta do servidor: em erro
      // de auth ela provou ser inválida e em sucesso já cumpriu o papel — reter
      // credencial no DOM depois do teste não tem valor.
      if (input) input.value = '';
      renderDebridTestResult(data);
      setDebridTestFeedback(
        data && data.ok ? 'Chave aceita pelo serviço.' : 'Teste sem sucesso: ' + debridTestMotivo(data) + '.',
        data && data.ok ? 'ok' : 'error',
      );
    })
    .catch((error: any) => {
      // Falhou ANTES de o servidor avaliar a chave (rede, token do painel, rate
      // limit): mesma regra uniforme — nenhum desfecho deixa a chave no input.
      if (input) input.value = '';
      setDebridTestFeedback('Teste não concluído: ' + valueText(error && error.message ? error.message : error), 'error');
    })
    .then(() => { if (button) button.disabled = false; });
}
