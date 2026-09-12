/* Adom Power-Movie — /dashboard: sondas pontuais (C3, ESM nativo).
 * Testes de indexer (/test-indexer.json) e resolver BR (/test-resolver.json) —
 * leitura isolada que não toca breaker nem polling. O polling da Geral continua
 * em status*.ts. Nada toca o DOM no import. */

import { $, first, requestJson, valueText } from './core.js';
import { formatDuration } from './render.js';
import { DashState } from './state.js';
import { hooks } from './hooks.js';

export function testResultText(data: any): string {
  if (data && data.ok) return 'OK · ' + valueText(data.results) + ' resultado(s) · ' + valueText(data.withMagnet) + ' com magnet · ' + formatDuration(data.ms);
  return 'Falhou · ' + valueText((data && (data.error || data.message)) || 'nenhum resultado');
}

export function runIndexerTest(id: string, button?: any): void {
  const output = $('testOutput');
  const safeId = String(id || '').replace(/^\s+|\s+$/g, '');
  const qInput = $('testIndexerQuery');
  const q = qInput ? String(qInput.value || '').replace(/^\s+|\s+$/g, '') : '';
  const typeInput = $('testIndexerType');
  const type = typeInput ? String(typeInput.value || 'movie').replace(/^\s+|\s+$/g, '') : 'movie';
  if (!safeId) { output.className = 'test-output error'; output.textContent = 'Informe o ID do indexador.'; return; }
  if (!DashState.token) { output.className = 'test-output error'; output.textContent = 'Informe o token antes de testar um indexador.'; $('token').focus(); return; }
  if (button) button.disabled = true;
  output.className = 'test-output';
  output.textContent = 'Testando ' + safeId + '…';
  let url = '/test-indexer.json?id=' + encodeURIComponent(safeId);
  if (q) url += '&q=' + encodeURIComponent(q);
  if (type) url += '&type=' + encodeURIComponent(type);
  requestJson(url, { method: 'GET' })
    .then((data: any) => {
      output.className = 'test-output ' + (data && data.ok ? (data.overBudget ? 'warn' : 'ok') : 'error');
      output.textContent = safeId + ' · ' + testResultText(data);
    })
    .catch((error: any) => { output.className = 'test-output error'; output.textContent = safeId + ' · ' + valueText(error && error.message ? error.message : error); })
    .then(() => { if (button) button.disabled = false; });
}

// Texto do teste de resolver BR: ok + N releases + latência + host ativo. O
// contrato real do backend é `results` (contagem de class="release" no HTML do
// /search) — NÃO `releases`; ler o campo errado mostrava "—" sempre.
export function resolverTestResultText(data: any): string {
  const releases = data ? data.results : null;
  const count = Array.isArray(releases) ? releases.length : Number(releases);
  if (data && data.ok) {
    return 'OK · ' + (isFinite(count) ? String(count) : valueText(releases)) + ' release(s) · ' +
      formatDuration(data.ms) + ' · host ' + valueText(first(data, ['host', 'activeSite', 'site'], ''));
  }
  return 'Falhou · ' + valueText((data && (data.error || data.message)) || 'nenhum resultado');
}

// Espelho de runIndexerTest para os resolvers BR: mesmo gate de token e mesmo
// feedback no #testOutput. Depois de um teste que mediu, pede o refresh pelo
// hook loadStatus — o card sai de "não medido" sem esperar o próximo polling.
// Em erro não há medição nova no servidor, então não reconsulta.
export function runResolverTest(id: string, button?: any): void {
  const output = $('testOutput');
  const safeId = String(id || '').replace(/^\s+|\s+$/g, '');
  const qInput = $('testIndexerQuery');
  const q = qInput ? String(qInput.value || '').replace(/^\s+|\s+$/g, '') : '';
  if (!safeId) { output.className = 'test-output error'; output.textContent = 'Informe o ID do resolver.'; return; }
  if (!DashState.token) { output.className = 'test-output error'; output.textContent = 'Informe o token antes de testar um resolver.'; $('token').focus(); return; }
  if (button) button.disabled = true;
  output.className = 'test-output';
  output.textContent = 'Testando ' + safeId + '…';
  let url = '/test-resolver.json?id=' + encodeURIComponent(safeId);
  if (q) url += '&q=' + encodeURIComponent(q);
  requestJson(url, { method: 'GET' })
    .then((data: any) => {
      output.className = 'test-output ' + (data && data.ok ? 'ok' : 'error');
      output.textContent = safeId + ' · ' + resolverTestResultText(data);
      if (data && data.ok) hooks.call('loadStatus');
    })
    .catch((error: any) => { output.className = 'test-output error'; output.textContent = safeId + ' · ' + valueText(error && error.message ? error.message : error); })
    .then(() => { if (button) button.disabled = false; });
}
