/* Adom Power-Movie — /dashboard: gerenciamento do MagnetDB (Fase 3 & R3).
 * Inspeção de chaves em memória (L1), contagens agregadas e descarte de bads.
 * Escopo global compartilhado (sem IIFE). ES5 puro para TVs e WebViews legadas.
 * Manipulação segura de DOM apenas com textContent e createElement. */
"use strict";

function setMagnetFeedback(text, kind) {
  var node = $("magnetFeedback");
  if (!node) return;
  node.className = "feedback" + (kind ? " " + kind : "");
  node.textContent = text || "";
}

function renderMagnetSummaryMetrics(data) {
  var container = $("magnetMetrics");
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
