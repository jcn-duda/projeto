/* Adom Power-Movie - pagina /dashboard: paineis da aba Geral e navegacao de abas
 * (Fase 3, PLANO_MELHORIAS 5.9). renderDebrid/renderSources/renderCache/
 * renderReleaseIndex/renderHarvest e switchTab/handleHash, extraidos do script
 * inline do dashboard.html. Escopo global compartilhado (sem IIFE); carregado
 * DEPOIS de dashboard-core.js e ANTES do script inline. Nada roda no load -
 * as chamadas que cruzam para o inline (renderMagnetDb, paineis) acontecem
 * em tempo de evento. ES5 puro: WebView de Fire TV e smart TV. Sem build. */
"use strict";

  function serviceId(item) {
    var id = String(first(item, ["id", "service", "key", "name"], "")).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (id === "realdebrid") return "realdebrid";
    if (id === "debridlink") return "debridlink";
    return id;
  }

  function serviceData(source, id) {
    var list = asList(first(source, ["services", "adapters", "accounts"], []), "services");
    var i;
    for (i = 0; i < list.length; i += 1) if (serviceId(list[i]) === id) return list[i];
    return null;
  }

  function renderDebrid(data, autofetchData) {
    var source = isObject(data) ? data : {};
    var auto = isObject(autofetchData) ? autofetchData : first(source, ["autofetch", "autoFetch", "autofetchStatus"], {});
    var account = isObject(source.account) ? source.account : {};
    var active = serviceId({ id: source.active || account.service || "" });
    var accounts = isObject(source.accounts) ? source.accounts : {};
    var cards = $("debridCards");
    var metrics = $("debridMetrics");
    var services = [];
    var i;
    var item;
    var found;
    metrics.textContent = "";
    renderMetrics(metrics, isObject(auto) ? auto : {}, { services: true, perService: true });
    cards.textContent = "";
    for (i = 0; i < knownServices.length; i += 1) {
      item = serviceData(source, knownServices[i].id) || { id: knownServices[i].id, label: knownServices[i].label, status: "unknown" };
      if (active === knownServices[i].id) {
        item = copyObject(item);
        Object.keys(account).forEach(function (key) { item[key] = account[key]; });
        item.status = account.ok === true ? (account.warn ? "warn" : "online") : "error";
      }
      if (isObject(accounts[knownServices[i].id])) {
        item = copyObject(item);
        Object.keys(accounts[knownServices[i].id]).forEach(function (key) { item[key] = accounts[knownServices[i].id][key]; });
        if (item.ok === false) item.status = item.reason === "rate" ? "warn" : "error";
      }
      if (!item.label) item.label = knownServices[i].label;
      item.autofetch = first(item, ["autofetch", "autoFetch"], first(asList(auto, "services").filter(function (entry) { return serviceId(entry) === knownServices[i].id; }), ["status", "state"], null));
      services.push(item);
    }
    asList(first(source, ["services", "adapters", "accounts"], []), "services").forEach(function (extra) {
      found = false;
      for (i = 0; i < services.length; i += 1) if (serviceId(services[i]) === serviceId(extra)) found = true;
      if (!found) services.push(extra);
    });
    for (i = 0; i < services.length; i += 1) card(cards, services[i], { fallback: "serviço" });
  }

  function renderCollection(container, source, preferredKey, options) {
    var list = asList(source, preferredKey);
    var i;
    container.textContent = "";
    if (!list.length) { empty(container, "Nenhum item reportado."); return; }
    for (i = 0; i < list.length; i += 1) card(container, list[i], options || {});
  }

  function renderSources(data) {
    var source = isObject(data) ? data : {};
    var indexers = first(source, ["indexers", "indexerStatus", "jackett"], []);
    var resolvers = first(source, ["resolvers", "brResolvers", "resolverStatus", "br"], []);
    indexers = asList(indexers, "indexers").map(function (item) {
      var out = copyObject(item);
      var status = isObject(item.status) ? item.status : {};
      var breaker = isObject(item.breaker) ? item.breaker : {};
      out.status = status.state || "unknown";
      out.latencyMs = status.ms;
      out.checkedAt = status.checkedAt;
      out.failStreak = status.failStreak;
      out.breaker = breaker.tripped ? "aberto" : "fechado";
      out.cooldownRemainingMs = breaker.cooldownRemainingMs;
      return out;
    });
    renderCollection($("indexerCards"), indexers, "indexers", { testable: true });
    var offline = indexers.filter(function (item) { return item.breaker === "aberto"; }).map(function (item) { return item.id; });
    if (offline.length) {
      var hint = element("p", "guidance error", "Circuit breaker aberto: revise estes IDs em JACKETT_INDEXERS: " + offline.join(", "));
      $("indexerCards").appendChild(hint);
    }
    // Resolvers BR são testáveis (kind resolver): mesmo card, botão e endpoint
    // de teste próprios, decididos dentro de card().
    renderCollection($("resolverCards"), resolvers, "resolvers", { testable: true, kind: "resolver" });
  }

  function renderCache(data) {
    var source = isObject(data) ? data : {};
    var metrics = $("cacheMetrics");
    var cards = $("cacheCards");
    var namespaces = first(source, ["namespaces", "byNamespace", "stats"], []);
    metrics.textContent = "";
    renderMetrics(metrics, source, { namespaces: true, byNamespace: true, stats: true });
    renderCollection(cards, namespaces, "namespaces", {});
  }

  // Fase 5: índice de releases + colhedor. Tudo vem pronto do servidor
  // (releaseIndex/harvest no dashboard-status); aqui só renderiza.
  function renderReleaseIndex(data) {
    var idx = isObject(data) ? data : {};
    var metrics = $("idxMetrics");
    metrics.textContent = "";
    if (!first(idx, ["enabled"], false)) {
      empty(metrics, "Índice desativado (RELEASE_INDEX=false).");
      return;
    }
    renderMetrics(metrics, idx, {});
  }

  function renderHarvest(data) {
    var harvest = isObject(data) ? data : {};
    var metrics = $("harvestMetrics");
    metrics.textContent = "";
    if (!first(harvest, ["enabled"], false)) {
      empty(metrics, "Colhedor desativado (HARVEST_ENABLED=false).");
      empty($("harvestCards"), "Colhedor desativado.");
      return;
    }
    renderMetrics(metrics, harvest, {});
    var queue = asList(first(harvest, ["queuePreview"], []), "queuePreview");
    var last = asList(first(harvest, ["lastWorks"], []), "lastWorks");
    queue = queue.map(function (item) { item = copyObject(item); item.label = "Na fila · " + valueText(item.imdbId); return item; });
    last.forEach(function (item) { item = copyObject(item); item.label = "Colhida · " + valueText(item.imdbId); queue.push(item); });
    renderCollection($("harvestCards"), queue, "queuePreview", {});
  }

  function switchTab(name) {
    var tabGeral = $("tabGeral");
    var tabAf = $("tabAutofetch");
    var tabColhedor = $("tabColhedor");
    var viewGeral = $("viewGeral");
    var viewAf = $("viewAutofetch");
    var viewColhedor = $("viewColhedor");
    if (!tabGeral || !tabAf || !tabColhedor || !viewGeral || !viewAf || !viewColhedor) return;
    if (name === "colhedor") {
      tabColhedor.className = "tab-btn active";
      tabColhedor.setAttribute("aria-selected", "true");
      tabGeral.className = "tab-btn";
      tabGeral.setAttribute("aria-selected", "false");
      tabAf.className = "tab-btn";
      tabAf.setAttribute("aria-selected", "false");
      viewColhedor.className = "tab-view";
      viewGeral.className = "tab-view hidden";
      viewAf.className = "tab-view hidden";
      if (window.location.hash !== "#colhedor") window.location.hash = "#colhedor";
    } else if (name === "autofetch") {
      tabAf.className = "tab-btn active";
      tabAf.setAttribute("aria-selected", "true");
      tabGeral.className = "tab-btn";
      tabGeral.setAttribute("aria-selected", "false");
      tabColhedor.className = "tab-btn";
      tabColhedor.setAttribute("aria-selected", "false");
      viewAf.className = "tab-view";
      viewGeral.className = "tab-view hidden";
      viewColhedor.className = "tab-view hidden";
      if (window.location.hash !== "#autofetch") window.location.hash = "#autofetch";
    } else {
      tabGeral.className = "tab-btn active";
      tabGeral.setAttribute("aria-selected", "true");
      tabAf.className = "tab-btn";
      tabAf.setAttribute("aria-selected", "false");
      tabColhedor.className = "tab-btn";
      tabColhedor.setAttribute("aria-selected", "false");
      viewGeral.className = "tab-view";
      viewAf.className = "tab-view hidden";
      viewColhedor.className = "tab-view hidden";
      if (window.location.hash === "#autofetch" || window.location.hash === "#colhedor") window.location.hash = "#geral";
    }
  }

  function handleHash() {
    var hash = String(window.location.hash || "").replace(/^#/, "");
    if (hash === "colhedor") switchTab("colhedor");
    else if (hash === "autofetch") switchTab("autofetch");
    else switchTab("geral");
  }
