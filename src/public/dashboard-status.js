/* Adom Power-Movie - pagina /dashboard: consulta, polling e acoes (Fase 3, PLANO_MELHORIAS 5.9).
 * renderStatus, token, refresh automatico, acoes com confirmacao, teste de
 * indexador e disponibilidade de controles, extraidos do script inline do
 * dashboard.html. Escopo global compartilhado (sem IIFE); carregado depois de
 * core/panels e ANTES do script inline. Nada roda no load - as chamadas que
 * cruzam para o inline (renderMagnetDb, paineis, catalogo) acontecem em tempo
 * de evento. ES5 puro: WebView de Fire TV e smart TV. Sem build, sem bundler. */
"use strict";

  function renderStatus(data) {
    var root = isObject(data) ? data : {};
    var status = first(root, ["status", "state", "health"], "online");
    var generated = first(root, ["generatedAt", "checkedAt", "timestamp", "at"], null);
    renderGeneral(root);
    renderDebrid(
      first(root, ["debrid", "debridStatus"], {}),
      first(root, ["autofetch", "autoFetch", "autofetchStatus"], {})
    );
    renderSources(root);
    renderCache(first(root, ["cache", "cacheStatus"], {}));
    renderMagnetDb(first(root, ["magnetdb", "magnetDb"], {}), first(root.metrics || {}, ["counters"], {}));
    if (first(root.metrics || {}, ["counters"], {})["debrid.check.unknown"] || first(root.cache || {}, ["swrServed"], 0)) {
      $("cacheMetrics").appendChild(element("p", "guidance", "Há respostas revalidadas ou sem confirmação de cache. Verifique primeiro a conta de debrid (teto/chave) e depois o prazo da busca."));
    }
    renderReleaseIndex(first(root, ["releaseIndex", "index", "idx"], {}));
    renderHarvest(first(root, ["harvest", "harvester"], {}));
    renderAutofetchPanel(first(root, ["autofetch", "autoFetch", "autofetchStatus"], {}));
    renderHarvesterPanel(first(root, ["harvest", "harvester"], {}));
    drawSparkline("cacheSparkline", pushSeries("cache-hit-rate", first(root.cache || {}, ["hitRate"], 0)), "#39d98a");
    drawSparkline("harvestSparkline", pushSeries("harvest-queries", first(root.harvest || {}, ["queriesThisHour"], 0)), "#faa31a");
    if (!own(root, "status") && !own(root, "state") && !own(root, "health")) {
      var services = first(root.general || {}, ["services"], {});
      var accounts = first(root.debrid || {}, ["accounts"], {});
      var tripped = asList(root.indexers, "indexers").some(function (item) { return item.breaker && item.breaker.tripped; });
      status = services.addon === false || Object.keys(accounts).some(function (id) { return accounts[id].reason === "auth" || accounts[id].reason === "quota"; })
        ? "offline"
        : services.jackett === false || tripped ? "warn" : "online";
    }
    setConnection(stateName(status), stateLabel(status));
    lastOkAt = Date.now();
    updateLastUpdated();
    updateActionAvailability(root);
  }

  function saveToken() {
    var input = $("token");
    currentToken = String(input.value || "").replace(/\s+/g, "");
    input.value = currentToken;
    if ($("rememberToken").checked) writeStored(TOKEN_KEY, currentToken);
    else removeStored(TOKEN_KEY);
    loadStatus();
  }

  function loadStatus() {
    if (requestInFlight || document.hidden) return;
    if (!currentToken) {
      setConnection("warn", "token necessário");
      setFeedback("Informe o token de diagnóstico para consultar o estado.", "warn");
      return;
    }
    requestInFlight = true;
    $("refreshButton").className = "is-loading";
    setFeedback("Consultando o estado…", "");
    requestJson("/dashboard-status.json", { method: "GET", cache: "no-store" })
      .then(function (data) {
        renderStatus(data);
        consecutiveFailures = 0;
        setFeedback("Estado atualizado.", "ok");
      })
      .catch(function (error) {
        var status = Number(error && error.status);
        consecutiveFailures += 1;
        setConnection("error", "falha na consulta");
        if (status === 503) setFeedback("Diagnóstico desligado: defina JACKETT_TEST_TOKEN no .env do operador.", "warn");
        else if (status === 401) setFeedback("Token rejeitado: cole novamente o token de diagnóstico correto.", "error");
        else if (status === 429) setFeedback("Outro diagnóstico está em andamento; a consulta será tentada novamente.", "warn");
        else setFeedback("Instância inalcançável: confira se o addon está no ar e se esta URL está acessível.", "error");
      })
      .then(function () { requestInFlight = false; $("refreshButton").className = ""; scheduleRefresh(); });
  }

  function scheduleRefresh() {
    var value = $("refreshRate").value;
    var seconds;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    try { writeStored(RATE_KEY, value); } catch (error) { /* preferência é opcional */ }
    seconds = Number(value);
    if (isFinite(seconds) && seconds > 0 && !document.hidden) {
      seconds = Math.min(300, seconds * Math.pow(2, consecutiveFailures));
      refreshTimer = setTimeout(loadStatus, seconds * 1000);
    }
  }

  function updateLastUpdated() {
    var seconds;
    if (!lastOkAt) { $("lastUpdated").textContent = "sem medição"; return; }
    seconds = Math.max(0, Math.floor((Date.now() - lastOkAt) / 1000));
    $("lastUpdated").textContent = seconds < 2 ? "Atualizado agora" : "Atualizado há " + seconds + "s";
  }

  function updateActionAvailability(root) {
    var harvest = first(root, ["harvest", "harvester"], {});
    var debrid = first(root, ["debrid", "debridStatus"], {});
    $("harvesterPauseButton").textContent = harvest.paused ? "Retomar colhedor" : "Pausar colhedor";
    $("harvesterPauseButton").setAttribute("data-paused", harvest.paused ? "false" : "true");
    $("harvesterDrainButton").disabled = !harvest.queueDepth;
    $("testAllIndexersButton").disabled = !asList(root.indexers, "indexers").length;
    $("refreshInventoryButton").disabled = !debrid.active;
    updateCacheScopes(root);
  }

  function hasConfiguredInstallation() {
    var parts = String(window.location.pathname || "").replace(/^\/+|\/+$/g, "").split("/");
    return parts.length === 2 && parts[1] === "dashboard" && parts[0] !== "dashboard";
  }

  function updateCacheScopeAvailability() {
    var available = hasConfiguredInstallation();
    var checkbox = $("cacheInstallation");
    checkbox.disabled = !available || Boolean($("cacheNamespace").value);
    if (checkbox.disabled) checkbox.checked = false;
    $("cacheInstallationLabel").style.opacity = available ? "1" : "0.55";
  }

  function updateCacheScopes(root) {
    var select = $("cacheNamespace");
    var cache = first(root, ["cache"], {});
    var namespaces = first(cache, ["namespaces"], {});
    var current = select.value;
    var names = Object.keys(namespaces || {}).sort();
    select.innerHTML = '<option value="">Todo o cache</option>';
    names.forEach(function (name) {
      var option = document.createElement("option");
      option.value = name;
      option.textContent = "Somente " + name;
      if (name === current) option.selected = true;
      select.appendChild(option);
    });
    updateCacheScopeAvailability();
  }

  function actionLabel(action) {
    var labels = {
      "sweep-dead": "a varredura de magnets mortos",
      "clear-cache": "a limpeza do cache",
      "harvester-pause": "a alteração do estado do colhedor",
      "harvester-drain": "a drenagem imediata da fila",
      "test-all-indexers": "o teste sequencial de todos os indexadores",
      "refresh-inventory": "a reavaliação do inventário"
    };
    return labels[action] || "esta ação";
  }

  function runAction(button) {
    var action = button.getAttribute("data-action");
    if (!window.confirm("Confirmar " + actionLabel(action) + "?")) return;
    button.disabled = true;
    setFeedback("Executando " + action + "…", "warn");
    var payload = {
      action: action,
      paused: button.getAttribute("data-paused") === "true",
      confirm: true
    };
    if (action === "clear-cache") {
      var namespace = $("cacheNamespace").value;
      if (namespace) payload.scope = { namespace: namespace };
      else if ($("cacheInstallation").checked) payload.scope = { installation: true };
    }
    requestJson("/dashboard-action.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (data) {
        setFeedback(valueText(first(data, ["message", "result"], "Ação concluída.")), "ok");
        loadStatus();
      })
      .catch(function (error) { setFeedback("Ação não concluída: " + valueText(error && error.message ? error.message : error), "error"); })
      .then(function () { button.disabled = false; });
  }

  function testResultText(data) {
    if (data && data.ok) return "OK · " + valueText(data.results) + " resultado(s) · " + valueText(data.withMagnet) + " com magnet · " + formatDuration(data.ms);
    return "Falhou · " + valueText(data && (data.error || data.message) || "nenhum resultado");
  }

  function runIndexerTest(id, button) {
    var output = $("testOutput");
    var safeId = String(id || "").replace(/^\s+|\s+$/g, "");
    if (!safeId) { output.className = "test-output error"; output.textContent = "Informe o ID do indexador."; return; }
    if (!currentToken) { output.className = "test-output error"; output.textContent = "Informe o token antes de testar um indexador."; $("token").focus(); return; }
    if (button) button.disabled = true;
    output.className = "test-output";
    output.textContent = "Testando " + safeId + "…";
    requestJson("/test-indexer.json?id=" + encodeURIComponent(safeId), { method: "GET" })
      .then(function (data) {
        output.className = "test-output " + (data && data.ok ? (data.overBudget ? "warn" : "ok") : "error");
        output.textContent = safeId + " · " + testResultText(data);
      })
      .catch(function (error) { output.className = "test-output error"; output.textContent = safeId + " · " + valueText(error && error.message ? error.message : error); })
      .then(function () { if (button) button.disabled = false; });
  }
