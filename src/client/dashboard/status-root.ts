/* Adom Power-Movie — /dashboard: status, polling e render da aba ativa (C3,
 * ESM). As sondas pontuais vivem em probes.ts; a evidência/banner em
 * status-issues.ts; as ações/escopo de cache em status-actions.ts.
 *
 * Desde a Fase 2.5 o ciclo renderiza só a faixa de saúde + a ABA ATIVA: o último
 * payload fica em DashState.lastStatusRoot e a troca de aba (nav.ts) desenha a
 * aba recém-ativada via hook rerenderActiveTab — não por referência direta.
 * Nada toca o DOM no import. */

import { $, RATE_KEY, TOKEN_KEY, first, isObject, own, pushSeries, removeStored, requestJson, setConnection, setFeedback, valueText, writeStored } from './core.js';
import { drawSparkline, element, stateLabel, stateName } from './render.js';
import { DashState } from './state.js';
import { hooks } from './hooks.js';
import { renderDebrid, renderGeneral, renderSources } from './panels.js';
import { renderCache } from './panels-l2.js';
import { renderHarvest, renderReleaseIndex } from './panels-index.js';
import { renderMagnetDb } from './magnets.js';
import { renderAutofetchPanel } from './autofetch.js';
import { renderHarvesterPanel } from './harvest.js';
import { collectStatusIssues, renderStatusBanner, worstIssueState, worstState } from './status-issues.js';
import { updateActionAvailability } from './status-actions.js';

// Painéis da aba Geral (Fase 2.5): o bloco que antes era o corpo inteiro do
// renderStatus virou um ramo — só a aba visível desenha a cada poll.
function renderGeralPanels(root: any): void {
  const counters = first(root.metrics || {}, ['counters'], {});
  const uptimeS = first(root.general || {}, ['uptimeS'], null);
  const harvest = first(root, ['harvest', 'harvester'], {});
  renderGeneral(root);
  hooks.call('renderTimersPanel', root);
  renderDebrid(first(root, ['debrid', 'debridStatus'], {}), first(root, ['autofetch', 'autoFetch', 'autofetchStatus'], {}));
  renderSources(root);
  renderCache(first(root, ['cache', 'cacheStatus'], {}), counters);
  renderMagnetDb(first(root, ['magnetdb', 'magnetDb'], {}), counters, uptimeS);
  if (counters['debrid.check.unknown'] || first(root.cache || {}, ['swrServed'], 0)) {
    $('cacheMetrics').appendChild(element('p', 'guidance', 'Há respostas revalidadas ou sem confirmação de cache. Verifique primeiro a conta de debrid (teto/chave) e depois o prazo da busca.'));
  }
  renderReleaseIndex(first(root, ['releaseIndex', 'index', 'idx'], {}));
  renderHarvest(harvest, uptimeS);
  hooks.call('renderF3Panel', root.f3, uptimeS, first(root.metrics || {}, ['gauges'], {}));
  // Fase 3.4 do redesign: o relatório de catálogo já vem em root.catalog a cada
  // poll — popula a seção sem disparar POST manual.
  hooks.call('renderCatalogPanel', root);
  drawSparkline('cacheSparkline', pushSeries('cache-hit-rate', first(root.cache || {}, ['hitRate'], 0)), '#39d98a');
  drawSparkline('harvestSparkline', pushSeries('harvest-queries', first(harvest, ['queriesThisHour'], 0)), '#faa31a');
}

// Só a aba ativa renderiza (Fase 2.5); Trace não tem painel de polling (consulta
// sob demanda). A aba vem do hook activeTabName (nav.ts): hook obrigatório — na
// página inteira quem registra é a nav; ausente é bug de composição e o call
// falha alto.
function renderActivePanels(root: any): void {
  const tab = hooks.call('activeTabName') || 'geral';
  const counters = first(root.metrics || {}, ['counters'], {});
  const uptimeS = first(root.general || {}, ['uptimeS'], null);
  if (tab === 'autofetch') {
    renderAutofetchPanel(first(root, ['autofetch', 'autoFetch', 'autofetchStatus'], {}), uptimeS);
  } else if (tab === 'colhedor') {
    renderHarvesterPanel(first(root, ['harvest', 'harvester'], {}), counters, uptimeS);
  } else if (tab === 'geral') {
    // Trace não tem painel de polling: não re-renderiza a Geral por engano.
    renderGeralPanels(root);
  }
}

export function renderStatus(data: any): void {
  const root = isObject(data) ? data : {};
  let status = first(root, ['status', 'state', 'health'], 'online');
  // Medição de render (Fase 2.5): só existe com flag de debug — produção não
  // recebe linha nenhuma de console. A flag vem por hook (health.ts).
  const renderStartedAt = hooks.call('dashDebugEnabled') ? Date.now() : 0;
  const issues = collectStatusIssues(root);
  DashState.lastStatusRoot = root;
  hooks.call('renderHealthStrip', root);
  hooks.call('renderAttentionStrip', issues);
  renderActivePanels(root);
  if (own(root, 'status') || own(root, 'state') || own(root, 'health')) {
    // "online" declarado não abafa ok:false da mesma resposta.
    status = worstState(stateName(status), worstIssueState(issues));
  } else {
    status = worstIssueState(issues);
  }
  renderStatusBanner(issues);
  setConnection(stateName(status), stateLabel(status) + (issues.length ? ' · ' + issues.length + ' problema(s)' : ''));
  DashState.lastOkAt = Date.now();
  updateLastUpdated();
  updateActionAvailability(root);
  // Com token válido o estado vazio honesto perdeu a razão de existir.
  hooks.call('updateEmptyState');
  if (renderStartedAt) {
    console.info("[dashboard] render '" + (hooks.call('activeTabName') || 'geral') + "': " + (Date.now() - renderStartedAt) + ' ms (somente faixa de saúde + aba ativa)');
  }
}

export function saveToken(): void {
  const input = $('token');
  DashState.token = String(input.value || '').replace(/\s+/g, '');
  input.value = DashState.token;
  if ($('rememberToken').checked) writeStored(TOKEN_KEY, DashState.token);
  else removeStored(TOKEN_KEY);
  // Limpar o token recria o estado vazio honesto: sem token nenhuma requisição
  // é feita, então o bloco precisa voltar a aparecer.
  hooks.call('updateEmptyState');
  loadStatus();
}

export function loadStatus(): void {
  if (DashState.requestInFlight || document.hidden) return;
  if (!DashState.token) {
    setConnection('warn', 'token necessário');
    setFeedback('Informe o token de diagnóstico para consultar o estado.', 'warn');
    return;
  }
  DashState.requestInFlight = true;
  $('refreshButton').className = 'is-loading';
  setConnection('syncing', 'consultando…');
  setFeedback('Consultando o estado…', '');
  requestJson('/dashboard-status.json', { method: 'GET', cache: 'no-store' })
    .then((data: any) => {
      const updated = $('lastUpdated');
      if (updated) updated.className = 'last-updated';
      DashState.consecutiveFailures = 0;
      // Render isolado de rede: a resposta CHEGOU. Sem este try/catch, uma
      // exceção de render/wiring caía no catch de baixo e pintava a tela de
      // "instância inalcançável" — diagnóstico errado.
      try {
        renderStatus(data);
        setFeedback('Estado atualizado.', 'ok');
      } catch (renderError: any) {
        setConnection('error', 'falha ao desenhar o painel');
        setFeedback('A resposta chegou, mas o painel falhou ao desenhar: ' + valueText(renderError && renderError.message ? renderError.message : renderError), 'error');
      }
    })
    .catch((error: any) => {
      const status = Number(error && error.status);
      const updated = $('lastUpdated');
      if (updated) updated.className = 'last-updated stale';
      DashState.consecutiveFailures += 1;
      setConnection('error', 'falha na consulta');
      if (status === 503) setFeedback('Diagnóstico desligado: defina JACKETT_TEST_TOKEN no .env do operador.', 'warn');
      else if (status === 401) setFeedback('Token rejeitado: cole novamente o token de diagnóstico correto.', 'error');
      else if (status === 429) setFeedback('Outro diagnóstico está em andamento; a consulta será tentada novamente.', 'warn');
      else setFeedback('Instância inalcançável: confira se o addon está no ar e se esta URL está acessível.', 'error');
    })
    .then(() => { DashState.requestInFlight = false; $('refreshButton').className = ''; scheduleRefresh(); });
}

export function scheduleRefresh(): void {
  const value = $('refreshRate').value;
  let seconds: number;
  if (DashState.refreshTimer) { clearTimeout(DashState.refreshTimer); DashState.refreshTimer = null; }
  try { writeStored(RATE_KEY, value); } catch (error) { /* preferência é opcional */ }
  seconds = Number(value);
  if (isFinite(seconds) && seconds > 0 && !document.hidden) {
    seconds = Math.min(300, seconds * Math.pow(2, DashState.consecutiveFailures));
    DashState.refreshTimer = setTimeout(loadStatus, seconds * 1000);
  }
}

export function updateLastUpdated(): void {
  if (!DashState.lastOkAt) { $('lastUpdated').textContent = 'sem medição'; return; }
  const seconds = Math.max(0, Math.floor((Date.now() - DashState.lastOkAt) / 1000));
  $('lastUpdated').textContent = seconds < 2 ? 'Atualizado agora' : 'Atualizado há ' + seconds + 's';
}

// Hook da troca de aba (Fase 1 do saneamento): fecha sobre
// DashState.lastStatusRoot — estado que mora em state.ts e que a nav não
// referencia por nome.
export function rerenderActiveTab(): void {
  if (DashState.lastStatusRoot) renderActivePanels(DashState.lastStatusRoot);
}
