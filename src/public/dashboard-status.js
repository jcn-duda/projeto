/* Adom Power-Movie - pagina /dashboard: consulta, polling e acoes (Fase 3, PLANO_MELHORIAS 5.9).
 * renderStatus, token, refresh automatico, acoes com confirmacao, teste de
 * indexador e disponibilidade de controles, extraidos do script inline do
 * dashboard.html. Escopo global compartilhado (sem IIFE); carregado depois de
 * core/panels e ANTES do script inline. Nada roda no load - as chamadas que
 * cruzam para o inline (renderMagnetDb, paineis, catalogo) acontecem em tempo
 * de evento. ES5 puro: WebView de Fire TV e smart TV. Sem build, sem bundler. */
"use strict";

  // --- Saúde consolidada do pill e do banner ---------------------------
  // O pill só acendia offline com auth/quota e warn com Jackett caído; um
  // ok:false de timeout, catálogo indisponível ou serviço debrid morto ficava
  // escondido num <details> fechado — o formato do incidente de 2026-08-30.
  // A evidência JÁ viaja na resposta do dashboard-status; aqui ela vira estado
  // visível no pill do cabeçalho e num banner persistente.
  var STATE_RANK = { unknown: 0, online: 1, warn: 2, error: 3 };

  function worstState(a, b) {
    return (STATE_RANK[a] || 0) >= (STATE_RANK[b] || 0) ? a : b;
  }

  function worstIssueState(issues) {
    var state = "online";
    var i;
    for (i = 0; i < issues.length; i += 1) state = worstState(state, issues[i].state);
    return state;
  }

  // auth/quota provam conta INUTILIZÁVEL (erro); rate/timeout/unknown são
  // transitórios ou sem prova — atenção, não derrubam o pill a vermelho.
  function severityFromReason(reason) {
    var text = String(reason || "");
    return text === "auth" || text === "quota" ? "error" : "warn";
  }

  function reasonText(reason) {
    var labels = {
      "auth": "chave de API recusada pelo serviço",
      "quota": "conta no teto de magnets",
      "rate": "rate limit do serviço",
      "timeout": "tempo esgotado consultando o serviço",
      "sem-debrid": "nenhum serviço de debrid configurado",
      "sem-conta-operador": "conta do operador sem chave no .env",
      "chave-operador-desativada": "uso da conta do operador desligado no .env",
      "sem-adapter-catalogo": "serviço de debrid não suporta o catálogo",
      "inventario-frio": "inventário da conta ainda não carregado",
      "erro": "falha ao consultar o serviço"
    };
    return labels[reason] || "motivo não classificado: " + valueText(reason);
  }

  // Texto claro com o motivo e o conserto: `fix` vem da conta de debrid,
  // `hint` do gate do catálogo. Dados de rede vão só por textContent/appendChild.
  function accountIssue(prefix, item) {
    var text = prefix + ": " + reasonText(item.reason);
    if (item.error) text += " (" + valueText(item.error) + ")";
    if (item.fix) text += " · Como corrigir: " + valueText(item.fix);
    else if (item.hint) text += " · Como corrigir: " + valueText(item.hint);
    return { state: severityFromReason(item.reason), text: text };
  }

  function collectStatusIssues(root) {
    var issues = [];
    var services = first(root.general || {}, ["services"], {});
    var debrid = isObject(root.debrid) ? root.debrid : {};
    var account = first(debrid, ["account", "debridStatus"], {});
    var accounts = first(debrid, ["accounts"], {});
    var catalog = root.catalog;
    var keys;
    var i;
    var item;
    var viuDebrid = false;
    if (isObject(account) && account.ok === false) {
      viuDebrid = true;
      issues.push(accountIssue((account.label || account.service || "Debrid") + " (conta ativa)", account));
    }
    keys = Object.keys(isObject(accounts) ? accounts : {});
    for (i = 0; i < keys.length; i += 1) {
      item = accounts[keys[i]];
      if (isObject(item) && item.ok === false) {
        // O backend ESPELHA a conta ativa em accounts[activeId] (mesma conta na
        // resposta nos dois lugares): sem este pulo, a falha da conta ativa
        // entrava DUAS vezes no banner e o pill anunciava "2 problema(s)" para
        // um único problema real.
        if (account.service && item.service === account.service) continue;
        viuDebrid = true;
        issues.push(accountIssue(item.label || item.service || keys[i], item));
      }
    }
    if (isObject(catalog) && catalog.ok === false) {
      issues.push({ state: "warn", text: "Catálogo da conta indisponível: " + reasonText(catalog.reason) + (catalog.hint ? " · Como corrigir: " + valueText(catalog.hint) : "") });
    }
    if (services.addon === false) issues.push({ state: "error", text: "O processo do addon reportou-se fora do ar (general.services.addon = false)." });
    if (services.jackett === false) issues.push({ state: "warn", text: "Jackett sem catálogo de indexadores; as buscas ficam sem fontes." });
    if (services.debrid === false && !viuDebrid) issues.push({ state: "warn", text: "Debrid reportado indisponível no geral, sem motivo detalhado; verifique chave e conta." });
    if (asList(root.indexers, "indexers").some(function (entry) { return entry.breaker && entry.breaker.tripped; })) {
      issues.push({ state: "warn", text: "Circuito aberto (breaker) em ao menos um indexador." });
    }
    return issues;
  }

  // Banner persistente: aparece com o pior estado da evidência e SOME SOZINHO
  // quando a resposta volta saudável — nunca fica preso de uma rodada anterior.
  function renderStatusBanner(issues) {
    var banner = $("statusBanner");
    var text = $("statusBannerText");
    var worst;
    var i;
    if (!banner || !text) return;
    worst = worstIssueState(issues);
    text.textContent = "";
    if (worst === "online") {
      banner.className = "status-banner";
      return;
    }
    banner.className = "status-banner visible " + worst;
    for (i = 0; i < issues.length; i += 1) {
      text.appendChild(element("p", "banner-line " + issues[i].state, issues[i].text));
    }
  }

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
    var issues = collectStatusIssues(root);
    if (own(root, "status") || own(root, "state") || own(root, "health")) {
      // Status explícito do servidor é combinado com a evidência local: um
      // "online" declarado não pode abafar ok:false que viajou na MESMA
      // resposta (era o buraco que escondia timeout/catálogo/serviço morto).
      status = worstState(stateName(status), worstIssueState(issues));
    } else {
      status = worstIssueState(issues);
    }
    renderStatusBanner(issues);
    setConnection(stateName(status), stateLabel(status) + (issues.length ? " · " + issues.length + " problema(s)" : ""));
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
