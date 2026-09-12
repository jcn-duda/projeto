/* Adom Power-Movie — /dashboard: gerenciamento do MagnetDB (Fase 3 & R3).
 * Painel de observabilidade do renderStatus (renderMagnetDb, Fase 0 redesign:
 * extraído de dashboard-panels.js e pintando no container próprio
 * #magnetMetrics em vez de dividir o #cacheMetrics), inspeção de chaves em
 * memória (L1), contagens agregadas e descarte de bads. Escopo global
 * compartilhado (sem IIFE). ES5 puro para TVs e WebViews legadas.
 * Manipulação segura de DOM apenas com textContent e createElement. */
"use strict";

  // TTL do mag em segundos → rótulo curto. "—" em ausente/negativo: o status
  // usa null quando não há média a declarar.
  function formatTtlSeconds(value) {
    var seconds = Number(value);
    if (!isFinite(seconds) || seconds < 0) return "—";
    if (seconds < 60) return Math.round(seconds) + " s";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min";
    return Math.floor(seconds / 3600) + " h";
  }

  // Painel de observabilidade do banco (chamado por renderStatus): pinta o
  // container PRÓPRIO (#magnetMetrics), não o #cacheMetrics — a seção do
  // banco tem bloco dedicado no HTML e não disputa o grid do cache.
  function renderMagnetDb(data, counters, uptimeS) {
    var source = isObject(data) ? data : {};
    var metrics = $("magnetMetrics");
    var dbCounters = isObject(source.counters) ? source.counters : {};
    var allCounters = isObject(counters) ? counters : {};
    var ttl = isObject(source.ttlRemainingSeconds) ? source.ttlRemainingSeconds : {};
    var adapters = isObject(source.byAdapter) ? source.byAdapter : {};
    var hashes = Number(allCounters["debrid.check.hashes"] || 0);
    var cached = Number(allCounters["debrid.check.cached"] || 0);
    var sampleTotal;
    var adapterIds;
    var i;
    if (!metrics) return;
    // Os agregados são restaurados do mag_meta; os contadores de eventos abaixo
    // continuam sendo a única parte que zera no restart.
    if (!source.enabled && !own(source, "enabled")) return;
    metrics.textContent = "";
    metricMaybeOrigem(metrics, "magnet DB", source.enabled ? "ativo" : "desligado", source, "enabled", uptimeS);
    // Grupo A — ocupação REAL do namespace mag (L1/L2): sobrevive ao restart e
    // inclui o que este processo nunca observou. Nunca fundir com a amostra.
    metricGroupTitle(metrics, "Registros persistentes no banco (sobrevivem ao restart)");
    metricMaybeOrigem(metrics, "L1 mag (ocupação)", valueText(source.l1Entries) + " / " + valueText(source.l1Max), source, "l1Entries", uptimeS);
    metricMaybeOrigem(metrics, "evicções cota mag", source.evictedQuota, source, "evictedQuota", uptimeS);
    metrics.appendChild(element("p", "guidance",
      "Ocupação real do namespace mag no cache (L1/L2), incluindo registros gravados antes deste processo; pode conter expirados ou órfãos ainda não removidos. A chave é por serviço + conta + estado: o mesmo hash pode figurar mais de uma vez. Não é contagem de magnets válidos hoje."));
    // Grupo B — agregados duráveis por estado e adapter.
    metricGroupTitle(metrics, "Agregados persistentes por estado e serviço");
    sampleTotal = Number(source.sizeAlive || 0) + Number(source.sizeBad || 0) + Number(source.sizeLie || 0);
    metricMaybeOrigem(metrics, "registros classificados (≠ L1)", sampleTotal, source, "sizeAlive", uptimeS);
    metricMaybeOrigem(metrics, "alive (tocável)", source.sizeAlive, source, "sizeAlive", uptimeS);
    // bad = play sem vídeo (magnetdb); dead = terminal no recheck (autofetch) — fronteiras distintas.
    metricMaybeOrigem(metrics, "bad (play sem vídeo)", source.sizeBad, source, "sizeBad", uptimeS);
    metricMaybeOrigem(metrics, "lie (áudio mentiu)", source.sizeLie, source, "sizeLie", uptimeS);
    metricMaybeOrigem(metrics, "TTL alive configurado", formatTtlSeconds(source.aliveTtlSeconds), source, "aliveTtlSeconds", uptimeS);
    metricMaybeOrigem(metrics, "TTL bad configurado", formatTtlSeconds(source.badTtlSeconds), source, "badTtlSeconds", uptimeS);
    metricMaybeOrigem(metrics, "TTL lie configurado", formatTtlSeconds(source.lieTtlSeconds), source, "lieTtlSeconds", uptimeS);
    // Base da soma de TTL restante: `l1-rebuild` = restante real de cada chave,
    // preciso só no instante do rebuild; `aggregate-estimate` = estimativa
    // incremental/restaurada (default e estado normal após qualquer mutação).
    var ttlBasis = source.ttlRemainingBasis === "l1-rebuild" ? "l1-rebuild" : "aggregate-estimate";
    var ttlSuffix = ttlBasis === "l1-rebuild" ? " · base: recontada do L1" : "";
    metricMaybeOrigem(metrics, "TTL alive restante (média)", formatTtlSeconds(ttl.alive) + ttlSuffix, source, "ttlRemainingSeconds", uptimeS);
    metricMaybeOrigem(metrics, "TTL bad restante (média)", formatTtlSeconds(ttl.bad) + ttlSuffix, source, "ttlRemainingSeconds", uptimeS);
    metricMaybeOrigem(metrics, "TTL lie restante (média)", formatTtlSeconds(ttl.lie) + ttlSuffix, source, "ttlRemainingSeconds", uptimeS);
    adapterIds = Object.keys(adapters).sort();
    for (i = 0; i < adapterIds.length; i += 1) {
      var adapter = isObject(adapters[adapterIds[i]]) ? adapters[adapterIds[i]] : {};
      var adapterTtl = isObject(adapter.ttlRemainingSeconds) ? adapter.ttlRemainingSeconds : {};
      metricMaybeOrigem(metrics, "serviço " + adapterIds[i],
        "alive " + valueText(adapter.sizeAlive) + ", bad " + valueText(adapter.sizeBad) + ", lie " + valueText(adapter.sizeLie) +
        " · TTL ≈ " + formatTtlSeconds(adapterTtl.alive) + "/" + formatTtlSeconds(adapterTtl.bad) + "/" + formatTtlSeconds(adapterTtl.lie),
        source, "byAdapter", uptimeS);
    }
    metrics.appendChild(element("p", "guidance",
      "Os agregados sobrevivem ao restart pelo mag_meta. A média de TTL restante é " + (ttlBasis === "l1-rebuild"
        ? "recontada do L1 (restante real de cada chave) e vale só até a próxima gravação/esquecimento"
        : "estimativa incremental ou restaurada (escrita e remoção somam/subtraem o TTL nominal, não o restante exato)") + ". " +
      "A ocupação do L1 ainda pode diferir de alive+bad+lie por incluir registros expirados ou órfãos ainda não removidos."));
    // Grupo C — contadores do processo (metrics): gravações, reparo e descartes
    // na listagem. Estes, sim, zeram no restart.
    metricGroupTitle(metrics, "Gravações e descartes desde o restart (contadores do processo)");
    // aliveSet conta toda markAlive, inclusive a renovação econômica do davail.
    metric(metrics, "gravações alive (inclui renovações)", dbCounters.aliveSet);
    metric(metrics, "gravações bad", dbCounters.badSet);
    metric(metrics, "gravações lie", dbCounters.lieSet);
    metric(metrics, "bad limpos (reparo blocked)", dbCounters.badClearedBlocked);
    metric(metrics, "descartados bad (magnetdb)", dbCounters.droppedBad);
    metric(metrics, "descartados dead (autofetch ≠ bad)", dbCounters.droppedDead);
    metric(metrics, "descartados lie (magnetdb)", dbCounters.droppedLie);
    metricGroupTitle(metrics, "Checagem de cache do debrid (medida neste processo)");
    metric(metrics, "taxa ⚡ (cache medido)", hashes ? Math.round((cached / hashes) * 100) + "% (" + cached + "/" + hashes + ")" : "—");
  }

function setMagnetFeedback(text, kind) {
  var node = $("magnetFeedback");
  if (!node) return;
  node.className = "feedback" + (kind ? " " + kind : "");
  node.textContent = text || "";
}

// Resumo manual (magnet-summary) pinta o container PRÓPRIO #magnetSummaryMetrics:
// dividir o #magnetMetrics com o renderMagnetDb fazia o poll seguinte apagar o
// resumo que o operador acabara de pedir.
function renderMagnetSummaryMetrics(data) {
  var container = $("magnetSummaryMetrics");
  var totals;
  var byAdapter;
  var adapters;
  var i;
  var adapterId;
  var adapter;
  if (!container) return;
  container.textContent = "";
  if (!data || !data.ok) {
    container.appendChild(element("div", "empty", "Sem dados de resumo do MagnetDB."));
    return;
  }
  totals = isObject(data.totals) ? data.totals : {};
  byAdapter = isObject(data.byAdapter) ? data.byAdapter : {};
  container.appendChild(element("p", "metric-group", "Totais consolidados do MagnetDB"));
  metric(container, "total classificado", data.entries != null ? data.entries : (Number(totals.alive || 0) + Number(totals.bad || 0) + Number(totals.lie || 0)));
  metric(container, "alive (tocáveis)", totals.alive != null ? totals.alive : 0);
  metric(container, "bad (sem vídeo)", totals.bad != null ? totals.bad : 0);
  metric(container, "lie (áudio mentiu)", totals.lie != null ? totals.lie : 0);
  adapters = Object.keys(byAdapter).sort();
  if (adapters.length) {
    container.appendChild(element("p", "metric-group", "Distribuição por serviço de debrid"));
    for (i = 0; i < adapters.length; i += 1) {
      adapterId = adapters[i];
      adapter = isObject(byAdapter[adapterId]) ? byAdapter[adapterId] : {};
      metric(container, "serviço " + adapterId, "alive " + valueText(adapter.alive) + ", bad " + valueText(adapter.bad) + ", lie " + valueText(adapter.lie));
    }
  }
}

function runMagnetSummary(button) {
  if (!currentToken) {
    setMagnetFeedback("Informe o token de diagnóstico antes de consultar o MagnetDB.", "error");
    $("token").focus();
    return;
  }
  if (button) button.disabled = true;
  setMagnetFeedback("Consultando resumo consolidado do MagnetDB…", "");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "magnet-summary" })
  })
    .then(function (data) {
      renderMagnetSummaryMetrics(data);
      setMagnetFeedback("Resumo do MagnetDB atualizado.", "ok");
    })
    .catch(function (error) {
      setMagnetFeedback("Falha ao obter resumo: " + valueText(error && error.message ? error.message : error), "error");
    })
    .then(function () {
      if (button) button.disabled = false;
    });
}

function renderMagnetInspectResults(data) {
  var output = $("magnetOutput");
  var items;
  var i;
  var item;
  var line;
  var sideSpan;
  var infoSpan;
  if (!output) return;
  output.textContent = "";
  if (!data || !data.ok) {
    output.style.display = "none";
    return;
  }
  items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    output.style.display = "block";
    output.className = "test-output";
    output.appendChild(element("p", "", "Nenhuma chave encontrada com os filtros selecionados."));
    return;
  }
  output.style.display = "block";
  output.className = "test-output";
  for (i = 0; i < items.length; i += 1) {
    item = items[i];
    line = element("div", "status-line");
    sideSpan = element("strong", "side-" + item.side, String(item.side).toUpperCase());
    infoSpan = element("span", "", " · " + item.adapterId + " · " + item.hash + " · TTL " + formatDuration((item.ttlRemainingSeconds || 0) * 1000));
    line.appendChild(sideSpan);
    line.appendChild(infoSpan);
    output.appendChild(line);
  }
  if (data.truncated) {
    output.appendChild(element("p", "guidance", "Resultados truncados em " + data.returned + " de " + data.matched + " encontrados."));
  }
}

function runMagnetInspect(button) {
  var hashInput = $("magnetInspectHash");
  var sideInput = $("magnetInspectSide");
  var adapterInput = $("magnetInspectAdapter");
  var hash = hashInput ? String(hashInput.value || "").trim() : "";
  var side = sideInput ? String(sideInput.value || "").trim() : "";
  var adapter = adapterInput ? String(adapterInput.value || "").trim() : "";
  var payload = { action: "magnet-inspect", max: 50 };
  if (!currentToken) {
    setMagnetFeedback("Informe o token antes de inspecionar o MagnetDB.", "error");
    $("token").focus();
    return;
  }
  if (hash) {
    if (!/^[a-f0-9]{40}$/i.test(hash)) {
      setMagnetFeedback("Hash inválido: informe 40 caracteres hexadecimais.", "error");
      return;
    }
    payload.hash = hash.toLowerCase();
  }
  if (side) payload.side = side;
  if (adapter) payload.adapterId = adapter;
  if (button) button.disabled = true;
  setMagnetFeedback("Inspecionando chaves do MagnetDB em memória (L1)…", "");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
    .then(function (data) {
      renderMagnetInspectResults(data);
      setMagnetFeedback("Inspeção concluída: " + valueText(data.returned) + " de " + valueText(data.matched) + " chaves correspondentes.", "ok");
    })
    .catch(function (error) {
      setMagnetFeedback("Falha na inspeção: " + valueText(error && error.message ? error.message : error), "error");
    })
    .then(function () {
      if (button) button.disabled = false;
    });
}

function runMagnetClearBad(button) {
  var hashInput = $("magnetInspectHash");
  var adapterInput = $("magnetInspectAdapter");
  var hash = hashInput ? String(hashInput.value || "").trim() : "";
  var adapter = adapterInput ? String(adapterInput.value || "").trim() : "";
  var payload = { action: "magnet-clear-bad", confirm: true, side: "bad", max: 50 };
  var desc = "Confirma a remoção de chaves 'bad' do MagnetDB?";
  if (adapter) desc += " (serviço: " + adapter + ")";
  if (hash) desc += " (hash: " + hash + ")";
  desc += "\nEsta ação é irreversível.";
  if (!window.confirm(desc)) return;
  if (!currentToken) {
    setMagnetFeedback("Informe o token antes de limpar chaves.", "error");
    $("token").focus();
    return;
  }
  if (hash) {
    if (!/^[a-f0-9]{40}$/i.test(hash)) {
      setMagnetFeedback("Hash inválido: informe 40 caracteres hexadecimais.", "error");
      return;
    }
    payload.hash = hash.toLowerCase();
  }
  if (adapter) payload.adapterId = adapter;
  if (button) button.disabled = true;
  setMagnetFeedback("Executando limpeza de chaves 'bad' no MagnetDB…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
    .then(function (data) {
      var cleared = Number(data && data.cleared || 0);
      var remaining = Number(data && data.remaining || 0);
      setMagnetFeedback("Limpeza concluída: " + cleared + " chave(s) removida(s), " + remaining + " restante(s).", "ok");
      runMagnetSummary();
      loadStatus();
    })
    .catch(function (error) {
      setMagnetFeedback("Falha ao limpar chaves: " + valueText(error && error.message ? error.message : error), "error");
    })
    .then(function () {
      if (button) button.disabled = false;
    });
}

function bindMagnetPanel() {
  var summaryBtn = $("magnetSummaryBtn");
  var inspectBtn = $("magnetInspectBtn");
  var clearBadBtn = $("magnetClearBadBtn");
  var hashInput = $("magnetInspectHash");
  if (summaryBtn) summaryBtn.addEventListener("click", function () { runMagnetSummary(summaryBtn); });
  if (inspectBtn) inspectBtn.addEventListener("click", function () { runMagnetInspect(inspectBtn); });
  if (clearBadBtn) clearBadBtn.addEventListener("click", function () { runMagnetClearBad(clearBadBtn); });
  if (hashInput) {
    hashInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") runMagnetInspect(inspectBtn);
    });
  }
}
