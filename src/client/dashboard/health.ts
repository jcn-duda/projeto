/* Adom Power-Movie — /dashboard: faixa de sinais vitais (C3, ESM nativo).
 * Faixa sticky com SEIS sinais (taxa ⚡, conta de debrid, indexers, cache, Chupim,
 * primeira resposta I0) + faixa de atenção que REUTILIZA collectStatusIssues via
 * hook. Abriga o estado vazio honesto sem token. Medição de render só com flag
 * (dashdebug=1). O pedido de consulta sai por hooks.call("loadStatus"). Nada toca
 * o DOM no import. */

import { $, TOKEN_KEY, first, isObject, readStored, removeStored, valueText, writeStored } from './core.js';
import { element, formatBytes, formatDate } from './render.js';
import { DashState } from './state.js';
import { hooks } from './hooks.js';

const DASH_DEBUG_KEY = 'adom.dashboard.debug';

export function dashDebugEnabled(): boolean {
  try {
    if (String(window.location.search || '').indexOf('dashdebug=1') !== -1) return true;
    return readStored(DASH_DEBUG_KEY) === '1';
  } catch (error) { return false; }
}

function pctOf(part: any, total: any): string {
  const n = Number(total);
  if (!isFinite(n) || n <= 0) return '—';
  return Math.round((Number(part || 0) / n) * 100) + '%';
}

// 1. Taxa ⚡ — debrid.check.cached / debrid.check.hashes. O hit local do davail
// (davail.servedHashes) NÃO entra: por contrato ele não é medição de rede.
function signalRate(root: any): any {
  const counters = first(root.metrics || {}, ['counters'], {});
  const cached = Number(first(counters, ['debrid.check.cached'], 0)) || 0;
  const hashes = Number(first(counters, ['debrid.check.hashes'], 0)) || 0;
  const served = Number(first(counters, ['davail.servedHashes'], 0)) || 0;
  return {
    key: 'Taxa ⚡',
    state: hashes > 0 ? 'online' : 'unknown',
    value: pctOf(cached, hashes),
    title: 'Cache confirmado em checagem real: ' + cached + ' de ' + hashes + ' hashes' +
      (hashes > 0 ? ' (' + pctOf(cached, hashes) + ')' : ' — sem checagem ainda') +
      '. Hit local do davail (' + served + ') fica fora da taxa por contrato.',
  };
}

// 2. Conta de debrid — ok/warn governam o semáforo; números vão no valor e no
// title (warnAt/premiumUntil/oldestAt são detalhe de hover, não KPI).
function signalAccount(root: any): any {
  const debrid = isObject(root.debrid) ? root.debrid : {};
  const account = isObject(first(debrid, ['account', 'debridStatus'], {})) ? first(debrid, ['account', 'debridStatus'], {}) : {};
  const parts: string[] = [];
  let state = 'unknown';
  if (account.ok === true) state = account.warn ? 'warn' : 'online';
  else if (account.ok === false) state = 'error';
  if (account.magnets != null) parts.push(account.magnets + ' magnets');
  if (account.ready != null) parts.push(account.ready + ' prontos');
  if (account.active != null) parts.push(account.active + ' ativos');
  if (account.error) parts.push(account.error + ' com erro');
  return {
    key: 'Conta debrid',
    state,
    value: parts.join(' · ') || '—',
    title: (account.label || account.service || 'Conta') +
      (account.warn ? ' — aviso operacional (teto em ' + valueText(account.warnAt) + ' ' + valueText(account.warnAtUnit) + ')' : '') +
      (account.premiumUntil ? ' · premium até ' + formatDate(account.premiumUntil) : '') +
      (account.oldestAt ? ' · magnet mais velho de ' + formatDate(account.oldestAt) : ''),
  };
}

// 3. Indexers — online/total sobre a lista; breaker aberto e flagSlow são detalhe
// do title. Lista vazia é "não medido", não "tudo online".
function signalIndexers(root: any): any {
  const list = Array.isArray(root.indexers) ? root.indexers : [];
  let online = 0;
  let measured = 0;
  let tripped = 0;
  let slow = 0;
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    const st = isObject(item.status) ? item.status : null;
    const b = isObject(item.breaker) ? item.breaker : {};
    // Não medido não é online: sem `online` booleano nem `status`, a linha não
    // conta como prova — o semáforo fica neutro em vez de verde.
    if (item.online === true || item.online === false || st !== null) {
      measured += 1;
      const isOffline = item.online === false || (st !== null && st.state === 'offline');
      if (!isOffline) online += 1;
    }
    if (b.state === 'aberto' || (!b.state && b.tripped)) tripped += 1;
    if (item.flagSlow) slow += 1;
  }
  return {
    key: 'Indexers',
    // Verde exige TODOS medidos e online: não medido derruba para atenção (não
    // para online), pois a ausência de prova não é prova de saúde.
    state: !list.length || !measured ? 'unknown' : (online < list.length || tripped > 0 ? 'warn' : 'online'),
    value: list.length ? online + '/' + list.length : '—',
    title: list.length
      ? 'Saúde medida dos indexadores. Não medidos: ' + (list.length - measured) +
        ' · Breaker aberto: ' + tripped + ' · lentos (flagSlow): ' + slow + '.'
      : 'Nenhum indexador reportado ainda.',
  };
}

// 4. Cache — hitRate + ocupação; o tamanho do L2 (disco) é detalhe do title.
function signalCache(root: any): any {
  const cache = isObject(root.cache) ? root.cache : {};
  const l2 = isObject(cache.l2) ? cache.l2 : {};
  const rate = Number(cache.hitRate);
  const hasRate = cache.hitRate !== null && cache.hitRate !== undefined && isFinite(rate);
  return {
    key: 'Cache',
    // hitRate ausente/ilegível é "não medido": verde sem medição mentiria.
    state: hasRate ? 'online' : 'unknown',
    value: hasRate ? Math.round(rate * 100) + '%' : '—',
    title: 'Hit-rate do cache (L1+L2). Entradas: ' + valueText(cache.entries) + ' de ' +
      valueText(cache.maxEntries) + ' · L2 no disco: ' + formatBytes(l2.fileSizeBytes || 0) + '.',
  };
}

// 5. Chupim (autofetch) — pausado é amarelo de propósito: é estado que o operador
// precisa enxergar sem abrir a aba. Orçamento e lotes no title.
function signalChupim(root: any): any {
  const af = isObject(root.autofetch) ? root.autofetch : {};
  const queues = isObject(af.queues) ? af.queues : {};
  const budget = isObject(af.budget) ? af.budget : {};
  return {
    key: 'Chupim',
    state: !isObject(root.autofetch) ? 'unknown' : (af.paused ? 'warn' : 'online'),
    value: isObject(root.autofetch) ? valueText(queues.count) + ' fila(s)' : '—',
    title: 'Autofetch em fundo. Itens em fila: ' + valueText(queues.items) +
      ' · lotes recheck: ' + valueText(af.recheckLots) + ' (settle: ' + valueText(af.settleLots) + ')' +
      ' · orçamento da hora: ' + valueText(budget.used) + '/' + valueText(budget.limit) +
      (af.paused ? ' · PAUSADO' : ''),
  };
}

// 6. Primeira resposta (I0) — bloco searchFirst inteiro no title; o valor visível
// é o que foi realmente entregue na abertura (brVisible).
function signalSearchFirst(root: any): any {
  const sf = isObject(root.searchFirst) ? root.searchFirst : {};
  return {
    key: '1ª resposta (I0)',
    state: Number(sf.responses) > 0 ? 'online' : 'unknown',
    value: Number(sf.brVisible) > 0 || Number(sf.brFound) > 0
      ? valueText(sf.brVisible) + '/' + valueText(sf.brFound) + ' BR'
      : '—',
    title: 'Observabilidade da primeira resposta fria. Respostas medidas: ' + valueText(sf.responses) +
      ' · BR encontradas: ' + valueText(sf.brFound) + ' · em cache: ' + valueText(sf.brCached) +
      ' · ocultadas pelo cachedOnly: ' + valueText(sf.brHidden) + ' · entregues: ' + valueText(sf.brVisible) +
      ' · ganho tardio: ' + valueText(sf.brLate) + '.',
  };
}

export function renderHealthStrip(root: any): void {
  const strip = $('healthStrip');
  const source = isObject(root) ? root : {};
  const builders = [signalRate, signalAccount, signalIndexers, signalCache, signalChupim, signalSearchFirst];
  if (!strip) return;
  strip.textContent = '';
  for (let i = 0; i < builders.length; i += 1) {
    const s = builders[i](source);
    const cell = element('div', 'health-cell state-' + s.state);
    cell.setAttribute('role', 'listitem');
    cell.title = s.title;
    cell.appendChild(element('span', 'health-key', s.key));
    const value = element('span', 'health-value');
    value.appendChild(element('span', 'health-dot'));
    value.appendChild(document.createTextNode(s.value));
    cell.appendChild(value);
    strip.appendChild(cell);
  }
}

// Faixa "precisa de atenção": MESMA fonte do banner (collectStatusIssues) — dois
// lugares, um critério. Some sozinha quando a resposta volta saudável.
export function renderAttentionStrip(issues: any): void {
  const strip = $('attentionStrip');
  const list = Array.isArray(issues) ? issues : [];
  if (!strip) return;
  strip.textContent = '';
  if (!list.length) { strip.className = 'attention-strip'; return; }
  let worstError = false;
  for (let i = 0; i < list.length; i += 1) if (list[i].state === 'error') worstError = true;
  strip.className = 'attention-strip visible' + (worstError ? ' error' : '');
  for (let i = 0; i < list.length; i += 1) {
    strip.appendChild(element('p', 'attention-line ' + list[i].state, list[i].text));
  }
}

// Estado vazio honesto: sem token NENHUMA requisição é feita — o estado nomeia a
// causa, a saída e traz o campo de token ali dentro.
export function updateEmptyState(): void {
  const box = $('healthEmptyState');
  if (!box) return;
  box.hidden = Boolean(DashState.token);
}

export function saveEmptyToken(): void {
  const input = $('emptyToken');
  const field = $('token');
  DashState.token = String((input && input.value) || '').replace(/\s+/g, '');
  if (input) input.value = DashState.token;
  // Sincroniza o campo do topo: o token salvo aqui é o mesmo que o operador vê e
  // edita depois — divergir deixaria os dois campos mostrando valores diferentes.
  if (field) field.value = DashState.token;
  // Mesma semântica do "Guardar neste dispositivo": só persiste com a opção
  // marcada; desmarcada remove qualquer token guardado.
  if ($('rememberToken') && $('rememberToken').checked) writeStored(TOKEN_KEY, DashState.token);
  else removeStored(TOKEN_KEY);
  updateEmptyState();
  if (DashState.token) hooks.call('loadStatus');
}

export function bindHealthPanel(): void {
  const save = $('emptySaveToken');
  const input = $('emptyToken');
  if (save) save.addEventListener('click', saveEmptyToken);
  if (input) input.addEventListener('keydown', (event: any) => { if (event.key === 'Enter') saveEmptyToken(); });
  updateEmptyState();
}
