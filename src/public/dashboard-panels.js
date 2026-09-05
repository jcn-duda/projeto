/* Adom Power-Movie — /dashboard: painéis da Geral + abas (Fase 3 §5.9 + Fase 1).
 * renderGeneral, renderMagnetDb, renderDebrid/Sources/Cache/ReleaseIndex/Harvest,
 * switchTab/handleHash. Escopo global (sem IIFE). Depois de core, antes do boot.
 * ES5 puro (Fire TV / smart TV). */
"use strict";

  // Fail-open: sem _origem[field] cai no metric() antigo (status ainda sem 3º arg).
  function metricMaybeOrigem(container, key, value, map, field, uptimeS) {
    var kind = origemOf(map, field);
    if (kind) metricOrigem(container, key, value, kind, uptimeS);
    else metric(container, key, value);
  }

  function renderGeneral(data) {
    var source = first(data, ["general", "overview", "system"], data);
    var metrics = $("generalMetrics");
    var excluded = { general: true, overview: true, system: true, debrid: true, autofetch: true, indexers: true, indexerStatus: true, resolvers: true, brResolvers: true, cache: true, search: true, _origem: true };
    var uptimeS = isObject(source) ? source.uptimeS : undefined;
    var keys;
    var i;
    var key;
    var kind;
    metrics.textContent = "";
    // services.jackett: o banner da Geral já cobre — não redesenhar aqui.
    if (isObject(source) && isObject(source._origem) && uptimeS != null && uptimeS !== "") {
      keys = Object.keys(source);
      for (i = 0; i < keys.length; i += 1) {
        key = keys[i];
        if (excluded[key]) continue;
        if (source[key] === null || typeof source[key] === "object") continue;
        kind = origemOf(source, key);
        if (kind) metricOrigem(metrics, key, displayValue(key, source[key]), kind, uptimeS);
        else metric(metrics, key, source[key]);
      }
      if (!metrics.children.length) empty(metrics, "Nenhuma métrica disponível.");
    } else {
      renderMetrics(metrics, source, excluded);
    }
    // O total de deadline sozinho sugere que o indexer atrasou a resposta. As
    // causas e a latência de metadata deixam claro quando o orçamento já chegou
    // corroído antes de abrir qualquer provider.
    renderMetrics(metrics, isObject(source.search) ? source.search : {}, { _origem: true });
  }

  function formatTtlSeconds(value) {
    var seconds = Number(value);
    if (!isFinite(seconds) || seconds < 0) return "—";
    if (seconds < 60) return Math.round(seconds) + " s";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min";
    return Math.floor(seconds / 3600) + " h";
  }

  function renderMagnetDb(data, counters, uptimeS) {
    var source = isObject(data) ? data : {};
    var metrics = $("cacheMetrics");
    var dbCounters = isObject(source.counters) ? source.counters : {};
    var allCounters = isObject(counters) ? counters : {};
    var ttl = isObject(source.ttlRemainingSeconds) ? source.ttlRemainingSeconds : {};
    var adapters = isObject(source.byAdapter) ? source.byAdapter : {};
    var hashes = Number(allCounters["debrid.check.hashes"] || 0);
    var cached = Number(allCounters["debrid.check.cached"] || 0);
    var sampleTotal;
    var adapterIds;
    var i;
    // Amostra (Map tracked) ≠ L1 mag: restart zera amostra e o L1 permanece.
    if (!source.enabled && !own(source, "enabled")) return;
    metricMaybeOrigem(metrics, "magnet DB", source.enabled ? "ativo" : "desligado", source, "enabled", uptimeS);
    metricMaybeOrigem(metrics, "L1 mag (ocupação)", valueText(source.l1Entries) + " / " + valueText(source.l1Max), source, "l1Entries", uptimeS);
    sampleTotal = Number(source.sizeAlive || 0) + Number(source.sizeBad || 0) + Number(source.sizeLie || 0);
    metricMaybeOrigem(metrics, "amostra processo (≠ L1)", sampleTotal, source, "sizeAlive", uptimeS);
    metricMaybeOrigem(metrics, "amostra alive (tocável)", source.sizeAlive, source, "sizeAlive", uptimeS);
    // bad = play sem vídeo (magnetdb); dead = terminal no recheck (autofetch) — fronteiras distintas.
    metricMaybeOrigem(metrics, "amostra bad (play sem vídeo)", source.sizeBad, source, "sizeBad", uptimeS);
    metricMaybeOrigem(metrics, "amostra lie (áudio mentiu)", source.sizeLie, source, "sizeLie", uptimeS);
    metricMaybeOrigem(metrics, "evicções cota mag", source.evictedQuota, source, "evictedQuota", uptimeS);
    metricMaybeOrigem(metrics, "TTL alive", formatTtlSeconds(source.aliveTtlSeconds), source, "aliveTtlSeconds", uptimeS);
    metricMaybeOrigem(metrics, "TTL bad", formatTtlSeconds(source.badTtlSeconds), source, "badTtlSeconds", uptimeS);
    metricMaybeOrigem(metrics, "TTL lie", formatTtlSeconds(source.lieTtlSeconds), source, "lieTtlSeconds", uptimeS);
    metricMaybeOrigem(metrics, "TTL alive restante (amostra)", formatTtlSeconds(ttl.alive), source, "ttlRemainingSeconds", uptimeS);
    metricMaybeOrigem(metrics, "TTL bad restante (amostra)", formatTtlSeconds(ttl.bad), source, "ttlRemainingSeconds", uptimeS);
    metricMaybeOrigem(metrics, "TTL lie restante (amostra)", formatTtlSeconds(ttl.lie), source, "ttlRemainingSeconds", uptimeS);
    metric(metrics, "descartados bad (magnetdb)", dbCounters.droppedBad);
    metric(metrics, "descartados dead (autofetch ≠ bad)", dbCounters.droppedDead);
    metric(metrics, "descartados lie (magnetdb)", dbCounters.droppedLie);
    metric(metrics, "taxa ⚡", hashes ? Math.round((cached / hashes) * 100) + "% (" + cached + "/" + hashes + ")" : "—");
    adapterIds = Object.keys(adapters).sort();
    for (i = 0; i < adapterIds.length; i += 1) {
      var adapter = isObject(adapters[adapterIds[i]]) ? adapters[adapterIds[i]] : {};
      var adapterTtl = isObject(adapter.ttlRemainingSeconds) ? adapter.ttlRemainingSeconds : {};
      metricMaybeOrigem(metrics, "amostra " + adapterIds[i],
        "alive " + valueText(adapter.sizeAlive) + ", bad " + valueText(adapter.sizeBad) + ", lie " + valueText(adapter.sizeLie) +
        " · TTL ≈ " + formatTtlSeconds(adapterTtl.alive) + "/" + formatTtlSeconds(adapterTtl.bad) + "/" + formatTtlSeconds(adapterTtl.lie),
        source, "byAdapter", uptimeS);
    }
  }

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
        // Conta ok em accounts é saudável (ex.: a do operador numa instância
        // pública segura, onde a instalação anônima não tem debrid ativo) —
        // mesmo critério do espelho da conta ativa acima; sem isto o card da
        // conta saudável ficava em "não medido".
        else if (item.ok === true) item.status = item.warn ? "warn" : "online";
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

  // Rótulo do breaker no card: state tri-estado (aberto/fechado/naomedido);
  // sem state, mantém o binário legado tripped→aberto/fechado. Nunca inferir
  // "fechado" de ausência — naomedido vira "não medido" (stateLabel unknown).
  function breakerStateLabel(breaker) {
    var b = isObject(breaker) ? breaker : {};
    if (typeof b.state === "string") {
      if (b.state === "aberto") return "aberto";
      if (b.state === "fechado") return "fechado";
      if (b.state === "naomedido" || b.state === "unknown") return stateLabel("unknown");
      return stateLabel(b.state);
    }
    return b.tripped ? "aberto" : "fechado";
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
      out.breaker = breakerStateLabel(breaker);
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

  function renderHarvest(data, uptimeS) {
    var harvest = isObject(data) ? data : {};
    var metrics = $("harvestMetrics");
    var restExcluded;
    metrics.textContent = "";
    if (!first(harvest, ["enabled"], false)) {
      empty(metrics, "Colhedor desativado (HARVEST_ENABLED=false).");
      empty($("harvestCards"), "Colhedor desativado.");
      return;
    }
    // _origem: fila/orçamento = durável; enabled/paused/lastRun = amostra do processo.
    if (isObject(harvest._origem)) {
      metricOrigem(metrics, "queriesThisHour", harvest.queriesThisHour, origemOf(harvest, "queriesThisHour"), uptimeS);
      metricOrigem(metrics, "queueDepth", harvest.queueDepth, origemOf(harvest, "queueDepth"), uptimeS);
      metricOrigem(metrics, "enabled", harvest.enabled, origemOf(harvest, "enabled"), uptimeS);
      metricOrigem(metrics, "paused", harvest.paused, origemOf(harvest, "paused"), uptimeS);
      metricOrigem(metrics, "lastRunAt", harvest.lastRunAt != null ? formatDate(harvest.lastRunAt) : harvest.lastRunAt, origemOf(harvest, "lastRunAt"), uptimeS);
      restExcluded = {
        _origem: true,
        queriesThisHour: true,
        queueDepth: true,
        enabled: true,
        paused: true,
        lastRunAt: true,
        queuePreview: true,
        lastWorks: true,
        config: true
      };
      renderMetrics(metrics, harvest, restExcluded);
    } else {
      renderMetrics(metrics, harvest, {});
    }
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
    var tabTrace = $("tabTrace");
    var viewGeral = $("viewGeral");
    var viewAf = $("viewAutofetch");
    var viewColhedor = $("viewColhedor");
    var viewTrace = $("viewTrace");
    if (!tabGeral || !tabAf || !tabColhedor || !tabTrace || !viewGeral || !viewAf || !viewColhedor || !viewTrace) return;
    if (name === "colhedor") {
      tabColhedor.className = "tab-btn active";
      tabColhedor.setAttribute("aria-selected", "true");
      tabGeral.className = "tab-btn";
      tabGeral.setAttribute("aria-selected", "false");
      tabAf.className = "tab-btn";
      tabAf.setAttribute("aria-selected", "false");
      tabTrace.className = "tab-btn";
      tabTrace.setAttribute("aria-selected", "false");
      viewColhedor.className = "tab-view";
      viewGeral.className = "tab-view hidden";
      viewAf.className = "tab-view hidden";
      viewTrace.className = "tab-view hidden";
      if (window.location.hash !== "#colhedor") window.location.hash = "#colhedor";
    } else if (name === "autofetch") {
      tabAf.className = "tab-btn active";
      tabAf.setAttribute("aria-selected", "true");
      tabGeral.className = "tab-btn";
      tabGeral.setAttribute("aria-selected", "false");
      tabColhedor.className = "tab-btn";
      tabColhedor.setAttribute("aria-selected", "false");
      tabTrace.className = "tab-btn";
      tabTrace.setAttribute("aria-selected", "false");
      viewAf.className = "tab-view";
      viewGeral.className = "tab-view hidden";
      viewColhedor.className = "tab-view hidden";
      viewTrace.className = "tab-view hidden";
      if (window.location.hash !== "#autofetch") window.location.hash = "#autofetch";
    } else if (name === "trace") {
      tabTrace.className = "tab-btn active";
      tabTrace.setAttribute("aria-selected", "true");
      tabGeral.className = "tab-btn";
      tabGeral.setAttribute("aria-selected", "false");
      tabAf.className = "tab-btn";
      tabAf.setAttribute("aria-selected", "false");
      tabColhedor.className = "tab-btn";
      tabColhedor.setAttribute("aria-selected", "false");
      viewTrace.className = "tab-view";
      viewGeral.className = "tab-view hidden";
      viewAf.className = "tab-view hidden";
      viewColhedor.className = "tab-view hidden";
      if (window.location.hash !== "#trace") window.location.hash = "#trace";
    } else {
      tabGeral.className = "tab-btn active";
      tabGeral.setAttribute("aria-selected", "true");
      tabAf.className = "tab-btn";
      tabAf.setAttribute("aria-selected", "false");
      tabColhedor.className = "tab-btn";
      tabColhedor.setAttribute("aria-selected", "false");
      tabTrace.className = "tab-btn";
      tabTrace.setAttribute("aria-selected", "false");
      viewGeral.className = "tab-view";
      viewAf.className = "tab-view hidden";
      viewColhedor.className = "tab-view hidden";
      viewTrace.className = "tab-view hidden";
      if (window.location.hash === "#autofetch" || window.location.hash === "#colhedor" || window.location.hash === "#trace") window.location.hash = "#geral";
    }
  }

  function handleHash() {
    var hash = String(window.location.hash || "").replace(/^#/, "");
    if (hash === "colhedor") switchTab("colhedor");
    else if (hash === "autofetch") switchTab("autofetch");
    else if (hash === "trace") switchTab("trace");
    else switchTab("geral");
  }
