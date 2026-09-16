/* Adom Power-Movie — /dashboard: Stream Trace (C3, ESM nativo).
 * Aba de diagnóstico do funil de busca (P5). Contratos:
 * - Consulta offline: GET /stream-trace.json (basePrefix + token no header) —
 *   NUNCA ?token=. O corpo nunca traz hash/magnet/chave/URL de config; o render
 *   só usa textContent (nunca monta HTML por string).
 * - Live: só aparece quando o backend diz live.allowed === true E o serviço
 *   efetivo está na allowlist fechada torbox/premiumize. Nos demais o botão NUNCA
 *   é renderizado, mesmo que o backend minta — e a recusa vira feedback legível.
 * - Sem polling: nenhuma consulta automática; só no clique.
 * Nada toca o DOM no import. */

import { $, isObject, requestJson, valueText } from './core.js';
import { clear, element, empty, metric } from './render.js';
import { DashState } from './state.js';

const LIVE_SERVICES: Record<string, boolean> = { torbox: true, premiumize: true };

function setTraceFeedback(text: string, kind?: string): void {
  const el = $('traceFeedback');
  if (!el) return;
  el.textContent = text;
  el.className = 'feedback' + (kind ? ' ' + kind : '');
}

export function traceLiveAllowed(data: any): boolean {
  if (!isObject(data) || !isObject(data.live)) return false;
  if (data.live.allowed !== true) return false;
  const service = String(data.live.service || '');
  return LIVE_SERVICES[service] === true;
}

function traceReasonLabel(reason: any): string {
  const map: Record<string, string> = {
    'title-filter': 'filtro de título',
    'multiwork-retained': 'pack multi-obra retido',
    'episode-mismatch': 'episódio não casa',
    'no-hash': 'sem hash',
    dedupe: 'duplicado',
    'min-seeders': 'abaixo do piso de seeds',
    'quality-filter': 'qualidade fora do filtro',
    'cam-excluded': 'CAM excluída',
    'size-limit': 'acima do limite de tamanho',
    'pool-cut': 'corte do pool',
    bad: 'magnet quebrado (bad)',
    dead: 'torrent morto',
    lie: 'áudio mentiu (lie)',
    'idx-miss': 'não serve este episódio (idx)',
    'cached-only': 'fora do cache (cachedOnly)',
    'rd-miss': 'miss confirmado no RD',
    'quality-quota': 'cota da qualidade',
    'indexer-limit': 'teto do indexer',
    'max-results': 'corte de maxResults',
    'br-guarantee-replaced': 'vaga BR garantida trocou',
    notice: 'aviso de lista vazia',
  };
  return map[reason] || reason;
}

function traceStageLabel(stage: any): string {
  const map: Record<string, string> = { raw: 'bruto', afterSort: 'pós-ordenação', notice: 'aviso', final: 'entregue' };
  return map[stage] || stage;
}

function renderTraceCache(cache: any, type: string, id: string): void {
  const el = $('traceCacheMetrics');
  if (!el) return;
  clear(el);
  metric(el, 'obra', type + ' ' + id);
  metric(el, 'parcial', valueText(cache.partial === true ? 'sim' : 'não'));
  metric(el, 'debrid conhecido', valueText(cache.debridKnown === true ? 'sim' : 'não'));
  metric(el, 'stale (na graça)', valueText(cache.stale === true ? 'sim' : 'não'));
  metric(el, 'TTL restante', String(cache.remainingS || 0) + 's');
}

function renderTraceStages(stages: any): void {
  const el = $('traceStages');
  if (!el || !isObject(stages)) return;
  clear(el);
  const keys = Object.keys(stages).sort();
  for (let i = 0; i < keys.length; i += 1) {
    metric(el, traceStageLabel(keys[i]), String(stages[keys[i]]));
  }
}

function renderTraceReasons(items: any): void {
  const el = $('traceReasons');
  if (!el) return;
  clear(el);
  if (!items || !items.length) return;
  const total: Record<string, number> = {};
  for (let i = 0; i < items.length; i += 1) {
    const r = items[i].reason || 'desconhecido';
    total[r] = (total[r] || 0) + 1;
  }
  const out = element('div', 'catalog-pills', '');
  const keys = Object.keys(total).sort();
  for (let j = 0; j < keys.length; j += 1) {
    out.appendChild(element('span', 'catalog-pill', traceReasonLabel(keys[j]) + ': ' + total[keys[j]]));
  }
  el.appendChild(out);
}

function traceCell(text: any, cls?: string): any {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = String(text == null ? '—' : text);
  return td;
}

function renderTraceItems(items: any): void {
  const el = $('traceOutput');
  if (!el) return;
  clear(el);
  if (!items || !items.length) return;
  const table = document.createElement('table');
  table.className = 'catalog-table';
  const head = document.createElement('tr');
  head.appendChild(traceCell('id', 'num'));
  head.appendChild(traceCell('release', 'label'));
  head.appendChild(traceCell('BR', 'num'));
  head.appendChild(traceCell('dub', 'num'));
  head.appendChild(traceCell('qual', 'num'));
  head.appendChild(traceCell('motivo', 'label'));
  table.appendChild(head);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const row = document.createElement('tr');
    row.appendChild(traceCell(item.id, 'num'));
    row.appendChild(traceCell(item.label, 'label'));
    row.appendChild(traceCell(item.br === true ? 'sim' : '—', 'num'));
    row.appendChild(traceCell(item.dubbed === true ? 'sim' : '—', 'num'));
    row.appendChild(traceCell(item.quality || '—', 'num'));
    row.appendChild(traceCell(traceReasonLabel(item.reason), 'label'));
    table.appendChild(row);
  }
  el.appendChild(table);
  if (items.length >= 300) {
    el.appendChild(element('p', 'guidance', 'Lista truncada no teto de 300 itens do trace.'));
  }
}

function traceLiveErrorText(reason: any, message: any): string {
  if (reason === 'ad-hard-blocked') return 'AllDebrid não permite checagem ao vivo (a consulta é upload e escreve na conta).';
  if (reason === 'rd-live-refused') return 'Live no Real-Debrid é recusado por decisão de projeto (oráculo/ledger gravam estado).';
  if (reason === 'no-cachecheck') return 'Serviço não suporta consulta de cache.';
  if (reason === 'no-account') return 'Instalação sem conta de debrid: nada a consultar ao vivo.';
  return message || reason || 'consulta ao vivo recusada';
}

function renderTraceLive(live: any): void {
  const el = $('traceOutput');
  if (!el) return;
  if (!isObject(live)) return;
  if (!live.allowed) {
    empty(el, traceLiveErrorText(live.reason, null));
    return;
  }
  if (!Array.isArray(live.results) || !live.results.length) {
    empty(el, 'Nenhum stream da lista para consultar ao vivo (lista vazia ou sem hashes).');
    return;
  }
  clear(el);
  const out = element('div', '', '');
  out.appendChild(element('p', 'status-line', 'Checagem ao vivo no ' + String(live.service || 'debrid') + ':'));
  for (let i = 0; i < live.results.length; i += 1) {
    const r = live.results[i];
    out.appendChild(element('p', 'status-line', r.id + ' · ' + (r.name || '—') + ' → ' + String(r.verdict)));
  }
  el.appendChild(out);
}

export function runTraceQuery(button?: any): void {
  const typeEl = $('traceType');
  const idEl = $('traceId');
  const type = typeEl ? typeEl.value : '';
  const id = idEl ? String(idEl.value || '').trim() : '';
  if (type !== 'movie' && type !== 'series') {
    setTraceFeedback('Escolha filme ou série.', 'warn');
    return;
  }
  if (!/^tt\d+(:\d+(:\d+)?)?$/.test(id)) {
    setTraceFeedback('ID inválido: use tt… opcional com :s:e (ex.: tt111:1:2).', 'warn');
    return;
  }
  if (!DashState.token) {
    setTraceFeedback('Token de diagnóstico ausente — cole-o acima.', 'error');
    const token = $('token');
    if (token) token.focus();
    return;
  }
  if (button) button.disabled = true;
  clear($('traceOutput'));
  clear($('traceReasons'));
  setTraceFeedback('Consultando…', 'warn');
  requestJson('/stream-trace.json?type=' + encodeURIComponent(type) + '&id=' + encodeURIComponent(id), { method: 'GET', cache: 'no-store' })
    .then((data: any) => {
      setTraceFeedback('', '');
      if (!data || data.found !== true) {
        empty($('traceOutput'), 'Obra não está no cache desta instalação.');
        return;
      }
      renderTraceCache(data.cache || {}, type, id);
      const trace = data.trace;
      if (!trace) {
        empty($('traceOutput'), 'Sem trace gravado nesta entrada (gravada antes da fase P5 ou STREAM_TRACE desligado).');
        if (isObject(data.recompute)) renderTraceRecompute(data.recompute);
        toggleTraceLive(data);
        return;
      }
      renderTraceStages(trace.stages);
      renderTraceItems(trace.items);
      renderTraceReasons(trace.items);
      renderTraceChupim(trace.chupim);
      if (isObject(data.recompute)) renderTraceRecompute(data.recompute);
      toggleTraceLive(data);
    })
    .catch((error: any) => {
      setTraceFeedback(traceErrorLegivel(error), 'error');
      clear($('traceCacheMetrics'));
    })
    .then(() => { if (button) button.disabled = false; });
}

function renderTraceRecompute(recompute: any): void {
  const el = $('traceOutput');
  if (!el || !isObject(recompute)) return;
  if (recompute.note) {
    el.appendChild(element('p', 'guidance', 'Recompute offline: ' + String(recompute.note) + '.'));
  }
  if (!Array.isArray(recompute.items) || !recompute.items.length) return;
  const table = document.createElement('table');
  table.className = 'catalog-table';
  const head = document.createElement('tr');
  head.appendChild(traceCell('id', 'num'));
  head.appendChild(traceCell('release', 'label'));
  head.appendChild(traceCell('BR', 'num'));
  head.appendChild(traceCell('estado atual (now)', 'label'));
  table.appendChild(head);
  for (let i = 0; i < recompute.items.length; i += 1) {
    const item = recompute.items[i];
    const row = document.createElement('tr');
    row.appendChild(traceCell(item.id, 'num'));
    row.appendChild(traceCell(item.label, 'label'));
    row.appendChild(traceCell(item.br === true ? 'sim' : '—', 'num'));
    row.appendChild(traceCell((item.now && item.now.state) || '—', 'label'));
    table.appendChild(row);
  }
  el.appendChild(table);
  el.appendChild(element('p', 'guidance', 'Recompute é foto do estado ATUAL (leituras locais quiet), não a causa do sumiço histórico.'));
}

export function toggleTraceLive(data: any): void {
  const btn = $('traceLiveBtn');
  if (!btn) return;
  const permitido = traceLiveAllowed(data);
  btn.style.display = permitido ? 'inline-block' : 'none';
  if (permitido) btn.setAttribute('title', 'Checagem ao vivo (GET de leitura no ' + String(data.live.service) + ')');
}

export function runTraceLive(button?: any): void {
  const typeEl = $('traceType');
  const idEl = $('traceId');
  const type = typeEl ? typeEl.value : '';
  const id = idEl ? String(idEl.value || '').trim() : '';
  if (button) button.disabled = true;
  clear($('traceOutput'));
  setTraceFeedback('Consultando ao vivo…', 'warn');
  requestJson('/stream-trace.json?type=' + encodeURIComponent(type) + '&id=' + encodeURIComponent(id) + '&mode=live', { method: 'GET', cache: 'no-store' })
    .then((data: any) => {
      setTraceFeedback('', '');
      renderTraceLive(data && data.live);
    })
    .catch((error: any) => {
      setTraceFeedback(traceErrorLegivel(error), 'error');
    })
    .then(() => { if (button) button.disabled = false; });
}

function traceErrorLegivel(error: any): string {
  const status = error && error.status;
  const reason = error && error.data && error.data.live && error.data.live.reason;
  if (reason) return traceLiveErrorText(reason, error.message);
  if (status === 400) return 'Consulta recusada: ' + (error.message || 'parâmetros inválidos.');
  if (status === 401) return 'Token rejeitado: cole novamente o token de diagnóstico correto.';
  if (status === 404) return 'Obra não está no cache desta instalação — faça uma busca no Stremio e consulte de novo.';
  if (status === 429) return 'Outro diagnóstico está em andamento; tente de novo em instantes.';
  if (status === 503) return 'Diagnóstico desligado: defina JACKETT_TEST_TOKEN no .env do operador.';
  return error && error.message ? error.message : 'falha na consulta';
}

/** Resumo do Chupim da build (Fase 7): uma linha compacta, fail-open. */
function renderTraceChupim(chupim: unknown): void {
  const el = $('traceOutput');
  if (!el) return;
  const texto = String(chupim || '').trim();
  if (!texto) return;
  el.appendChild(element('p', 'guidance', 'Chupim: ' + texto + '.'));
}
