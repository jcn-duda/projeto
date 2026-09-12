/* Adom Power-Movie — /dashboard: gerenciamento do MagnetDB (C3, ESM nativo).
 * Painel de observabilidade do renderStatus (renderMagnetDb, container próprio
 * #magnetMetrics), inspeção de chaves em memória (L1), contagens agregadas e
 * descarte de bads. Manipulação segura de DOM apenas com textContent e
 * createElement. Nada toca o DOM no import. */

import { $, isObject, own, requestJson, valueText } from './core.js';
import { element, formatDuration, metric, metricGroupTitle, metricMaybeOrigem } from './render.js';
import { DashState } from './state.js';
import { hooks } from './hooks.js';

// TTL do mag em segundos → rótulo curto. "—" em ausente/negativo: o status usa
// null quando não há média a declarar.
export function formatTtlSeconds(value: any): string {
  const seconds = Number(value);
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return Math.round(seconds) + ' s';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min';
  return Math.floor(seconds / 3600) + ' h';
}

// Painel de observabilidade do banco (chamado por renderStatus): pinta o
// container PRÓPRIO (#magnetMetrics), não o #cacheMetrics — a seção do banco tem
// bloco dedicado no HTML e não disputa o grid do cache.
export function renderMagnetDb(data: any, counters: any, uptimeS: any): void {
  const source = isObject(data) ? data : {};
  const metrics = $('magnetMetrics');
  const dbCounters = isObject(source.counters) ? source.counters : {};
  const allCounters = isObject(counters) ? counters : {};
  const ttl = isObject(source.ttlRemainingSeconds) ? source.ttlRemainingSeconds : {};
  const adapters = isObject(source.byAdapter) ? source.byAdapter : {};
  const hashes = Number(allCounters['debrid.check.hashes'] || 0);
  const cached = Number(allCounters['debrid.check.cached'] || 0);
  if (!metrics) return;
  // Os agregados são restaurados do mag_meta; os contadores de eventos abaixo
  // continuam sendo a única parte que zera no restart.
  if (!source.enabled && !own(source, 'enabled')) return;
  metrics.textContent = '';
  metricMaybeOrigem(metrics, 'magnet DB', source.enabled ? 'ativo' : 'desligado', source, 'enabled', uptimeS);
  // Grupo A — ocupação REAL do namespace mag (L1/L2): sobrevive ao restart e
  // inclui o que este processo nunca observou. Nunca fundir com a amostra.
  metricGroupTitle(metrics, 'Registros persistentes no banco (sobrevivem ao restart)');
  metricMaybeOrigem(metrics, 'L1 mag (ocupação)', valueText(source.l1Entries) + ' / ' + valueText(source.l1Max), source, 'l1Entries', uptimeS);
  metricMaybeOrigem(metrics, 'evicções cota mag', source.evictedQuota, source, 'evictedQuota', uptimeS);
  metrics.appendChild(element('p', 'guidance',
    'Ocupação real do namespace mag no cache (L1/L2), incluindo registros gravados antes deste processo; pode conter expirados ou órfãos ainda não removidos. A chave é por serviço + conta + estado: o mesmo hash pode figurar mais de uma vez. Não é contagem de magnets válidos hoje.'));
  // Grupo B — agregados duráveis por estado e adapter.
  metricGroupTitle(metrics, 'Agregados persistentes por estado e serviço');
  const sampleTotal = Number(source.sizeAlive || 0) + Number(source.sizeBad || 0) + Number(source.sizeLie || 0);
  metricMaybeOrigem(metrics, 'registros classificados (≠ L1)', sampleTotal, source, 'sizeAlive', uptimeS);
  metricMaybeOrigem(metrics, 'alive (tocável)', source.sizeAlive, source, 'sizeAlive', uptimeS);
  // bad = play sem vídeo (magnetdb); dead = terminal no recheck (autofetch) — fronteiras distintas.
  metricMaybeOrigem(metrics, 'bad (play sem vídeo)', source.sizeBad, source, 'sizeBad', uptimeS);
  metricMaybeOrigem(metrics, 'lie (áudio mentiu)', source.sizeLie, source, 'sizeLie', uptimeS);
  metricMaybeOrigem(metrics, 'TTL alive configurado', formatTtlSeconds(source.aliveTtlSeconds), source, 'aliveTtlSeconds', uptimeS);
  metricMaybeOrigem(metrics, 'TTL bad configurado', formatTtlSeconds(source.badTtlSeconds), source, 'badTtlSeconds', uptimeS);
  metricMaybeOrigem(metrics, 'TTL lie configurado', formatTtlSeconds(source.lieTtlSeconds), source, 'lieTtlSeconds', uptimeS);
  // Base da soma de TTL restante: `l1-rebuild` = restante real de cada chave,
  // preciso só no instante do rebuild; `aggregate-estimate` = estimativa
  // incremental/restaurada (default e estado normal após qualquer mutação).
  const ttlBasis = source.ttlRemainingBasis === 'l1-rebuild' ? 'l1-rebuild' : 'aggregate-estimate';
  const ttlSuffix = ttlBasis === 'l1-rebuild' ? ' · base: recontada do L1' : '';
  metricMaybeOrigem(metrics, 'TTL alive restante (média)', formatTtlSeconds(ttl.alive) + ttlSuffix, source, 'ttlRemainingSeconds', uptimeS);
  metricMaybeOrigem(metrics, 'TTL bad restante (média)', formatTtlSeconds(ttl.bad) + ttlSuffix, source, 'ttlRemainingSeconds', uptimeS);
  metricMaybeOrigem(metrics, 'TTL lie restante (média)', formatTtlSeconds(ttl.lie) + ttlSuffix, source, 'ttlRemainingSeconds', uptimeS);
  const adapterIds = Object.keys(adapters).sort();
  for (let i = 0; i < adapterIds.length; i += 1) {
    const adapter = isObject(adapters[adapterIds[i]]) ? adapters[adapterIds[i]] : {};
    const adapterTtl = isObject(adapter.ttlRemainingSeconds) ? adapter.ttlRemainingSeconds : {};
    metricMaybeOrigem(metrics, 'serviço ' + adapterIds[i],
      'alive ' + valueText(adapter.sizeAlive) + ', bad ' + valueText(adapter.sizeBad) + ', lie ' + valueText(adapter.sizeLie) +
      ' · TTL ≈ ' + formatTtlSeconds(adapterTtl.alive) + '/' + formatTtlSeconds(adapterTtl.bad) + '/' + formatTtlSeconds(adapterTtl.lie),
      source, 'byAdapter', uptimeS);
  }
  metrics.appendChild(element('p', 'guidance',
    'Os agregados sobrevivem ao restart pelo mag_meta. A média de TTL restante é ' + (ttlBasis === 'l1-rebuild'
      ? 'recontada do L1 (restante real de cada chave) e vale só até a próxima gravação/esquecimento'
      : 'estimativa incremental ou restaurada (escrita e remoção somam/subtraem o TTL nominal, não o restante exato)') + '. ' +
    'A ocupação do L1 ainda pode diferir de alive+bad+lie por incluir registros expirados ou órfãos ainda não removidos.'));
  // Grupo C — contadores do processo (metrics): gravações, reparo e descartes na
  // listagem. Estes, sim, zeram no restart.
  metricGroupTitle(metrics, 'Gravações e descartes desde o restart (contadores do processo)');
  // aliveSet conta toda markAlive, inclusive a renovação econômica do davail.
  metric(metrics, 'gravações alive (inclui renovações)', dbCounters.aliveSet);
  metric(metrics, 'gravações bad', dbCounters.badSet);
  metric(metrics, 'gravações lie', dbCounters.lieSet);
  metric(metrics, 'bad limpos (reparo blocked)', dbCounters.badClearedBlocked);
  metric(metrics, 'descartados bad (magnetdb)', dbCounters.droppedBad);
  metric(metrics, 'descartados dead (autofetch ≠ bad)', dbCounters.droppedDead);
  metric(metrics, 'descartados lie (magnetdb)', dbCounters.droppedLie);
  metricGroupTitle(metrics, 'Checagem de cache do debrid (medida neste processo)');
  metric(metrics, 'taxa ⚡ (cache medido)', hashes ? Math.round((cached / hashes) * 100) + '% (' + cached + '/' + hashes + ')' : '—');
}

function setMagnetFeedback(text: string, kind?: string): void {
  const node = $('magnetFeedback');
  if (!node) return;
  node.className = 'feedback' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
}

// Resumo manual (magnet-summary) pinta o container PRÓPRIO #magnetSummaryMetrics:
// dividir o #magnetMetrics com o renderMagnetDb fazia o poll seguinte apagar o
// resumo que o operador acabara de pedir.
export function renderMagnetSummaryMetrics(data: any): void {
  const container = $('magnetSummaryMetrics');
  if (!container) return;
  container.textContent = '';
  if (!data || !data.ok) {
    container.appendChild(element('div', 'empty', 'Sem dados de resumo do MagnetDB.'));
    return;
  }
  const totals = isObject(data.totals) ? data.totals : {};
  const byAdapter = isObject(data.byAdapter) ? data.byAdapter : {};
  container.appendChild(element('p', 'metric-group', 'Totais consolidados do MagnetDB'));
  metric(container, 'total classificado', data.entries != null ? data.entries : (Number(totals.alive || 0) + Number(totals.bad || 0) + Number(totals.lie || 0)));
  metric(container, 'alive (tocáveis)', totals.alive != null ? totals.alive : 0);
  metric(container, 'bad (sem vídeo)', totals.bad != null ? totals.bad : 0);
  metric(container, 'lie (áudio mentiu)', totals.lie != null ? totals.lie : 0);
  const adapters = Object.keys(byAdapter).sort();
  if (adapters.length) {
    container.appendChild(element('p', 'metric-group', 'Distribuição por serviço de debrid'));
    for (let i = 0; i < adapters.length; i += 1) {
      const adapterId = adapters[i];
      const adapter = isObject(byAdapter[adapterId]) ? byAdapter[adapterId] : {};
      metric(container, 'serviço ' + adapterId, 'alive ' + valueText(adapter.alive) + ', bad ' + valueText(adapter.bad) + ', lie ' + valueText(adapter.lie));
    }
  }
}

function runMagnetSummary(button?: any): void {
  if (!DashState.token) {
    setMagnetFeedback('Informe o token de diagnóstico antes de consultar o MagnetDB.', 'error');
    $('token').focus();
    return;
  }
  if (button) button.disabled = true;
  setMagnetFeedback('Consultando resumo consolidado do MagnetDB…', '');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'magnet-summary' }),
  })
    .then((data: any) => {
      renderMagnetSummaryMetrics(data);
      setMagnetFeedback('Resumo do MagnetDB atualizado.', 'ok');
    })
    .catch((error: any) => {
      setMagnetFeedback('Falha ao obter resumo: ' + valueText(error && error.message ? error.message : error), 'error');
    })
    .then(() => { if (button) button.disabled = false; });
}

export function renderMagnetInspectResults(data: any): void {
  const output = $('magnetOutput');
  if (!output) return;
  output.textContent = '';
  if (!data || !data.ok) {
    output.style.display = 'none';
    return;
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    output.style.display = 'block';
    output.className = 'test-output';
    output.appendChild(element('p', '', 'Nenhuma chave encontrada com os filtros selecionados.'));
    return;
  }
  output.style.display = 'block';
  output.className = 'test-output';
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const line = element('div', 'status-line');
    const sideSpan = element('strong', 'side-' + item.side, String(item.side).toUpperCase());
    const infoSpan = element('span', '', ' · ' + item.adapterId + ' · ' + item.hash + ' · TTL ' + formatDuration((item.ttlRemainingSeconds || 0) * 1000));
    line.appendChild(sideSpan);
    line.appendChild(infoSpan);
    output.appendChild(line);
  }
  if (data.truncated) {
    output.appendChild(element('p', 'guidance', 'Resultados truncados em ' + data.returned + ' de ' + data.matched + ' encontrados.'));
  }
}

function runMagnetInspect(button?: any): void {
  const hashInput = $('magnetInspectHash');
  const sideInput = $('magnetInspectSide');
  const adapterInput = $('magnetInspectAdapter');
  const hash = hashInput ? String(hashInput.value || '').trim() : '';
  const side = sideInput ? String(sideInput.value || '').trim() : '';
  const adapter = adapterInput ? String(adapterInput.value || '').trim() : '';
  const payload: any = { action: 'magnet-inspect', max: 50 };
  if (!DashState.token) {
    setMagnetFeedback('Informe o token antes de inspecionar o MagnetDB.', 'error');
    $('token').focus();
    return;
  }
  if (hash) {
    if (!/^[a-f0-9]{40}$/i.test(hash)) {
      setMagnetFeedback('Hash inválido: informe 40 caracteres hexadecimais.', 'error');
      return;
    }
    payload.hash = hash.toLowerCase();
  }
  if (side) payload.side = side;
  if (adapter) payload.adapterId = adapter;
  if (button) button.disabled = true;
  setMagnetFeedback('Inspecionando chaves do MagnetDB em memória (L1)…', '');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((data: any) => {
      renderMagnetInspectResults(data);
      setMagnetFeedback('Inspeção concluída: ' + valueText(data.returned) + ' de ' + valueText(data.matched) + ' chaves correspondentes.', 'ok');
    })
    .catch((error: any) => {
      setMagnetFeedback('Falha na inspeção: ' + valueText(error && error.message ? error.message : error), 'error');
    })
    .then(() => { if (button) button.disabled = false; });
}

function runMagnetClearBad(button?: any): void {
  const hashInput = $('magnetInspectHash');
  const adapterInput = $('magnetInspectAdapter');
  const hash = hashInput ? String(hashInput.value || '').trim() : '';
  const adapter = adapterInput ? String(adapterInput.value || '').trim() : '';
  const payload: any = { action: 'magnet-clear-bad', confirm: true, side: 'bad', max: 50 };
  let desc = "Confirma a remoção de chaves 'bad' do MagnetDB?";
  if (adapter) desc += ' (serviço: ' + adapter + ')';
  if (hash) desc += ' (hash: ' + hash + ')';
  desc += '\nEsta ação é irreversível.';
  if (!window.confirm(desc)) return;
  if (!DashState.token) {
    setMagnetFeedback('Informe o token antes de limpar chaves.', 'error');
    $('token').focus();
    return;
  }
  if (hash) {
    if (!/^[a-f0-9]{40}$/i.test(hash)) {
      setMagnetFeedback('Hash inválido: informe 40 caracteres hexadecimais.', 'error');
      return;
    }
    payload.hash = hash.toLowerCase();
  }
  if (adapter) payload.adapterId = adapter;
  if (button) button.disabled = true;
  setMagnetFeedback("Executando limpeza de chaves 'bad' no MagnetDB…", 'warn');
  requestJson('/dashboard-action.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((data: any) => {
      const cleared = Number((data && data.cleared) || 0);
      const remaining = Number((data && data.remaining) || 0);
      setMagnetFeedback('Limpeza concluída: ' + cleared + ' chave(s) removida(s), ' + remaining + ' restante(s).', 'ok');
      runMagnetSummary();
      hooks.call('loadStatus');
    })
    .catch((error: any) => {
      setMagnetFeedback('Falha ao limpar chaves: ' + valueText(error && error.message ? error.message : error), 'error');
    })
    .then(() => { if (button) button.disabled = false; });
}

export function bindMagnetPanel(): void {
  const summaryBtn = $('magnetSummaryBtn');
  const inspectBtn = $('magnetInspectBtn');
  const clearBadBtn = $('magnetClearBadBtn');
  const hashInput = $('magnetInspectHash');
  if (summaryBtn) summaryBtn.addEventListener('click', () => { runMagnetSummary(summaryBtn); });
  if (inspectBtn) inspectBtn.addEventListener('click', () => { runMagnetInspect(inspectBtn); });
  if (clearBadBtn) clearBadBtn.addEventListener('click', () => { runMagnetClearBad(clearBadBtn); });
  if (hashInput) {
    hashInput.addEventListener('keydown', (event: any) => {
      if (event.key === 'Enter') runMagnetInspect(inspectBtn);
    });
  }
}
