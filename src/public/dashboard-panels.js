/* Adom Power-Movie — /dashboard: painéis da Geral (Fase 3 §5.9 + Fase 1).
 * renderGeneral, renderDebrid/Sources/Cache/ReleaseIndex/Harvest. O painel do
 * MagnetDB vive em dashboard-magnets.js; as abas (switchTab/handleHash) em
 * dashboard-nav.js. Escopo global (sem IIFE). Depois de render, antes do boot.
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
    // Fase 3.6 do redesign: memória/serviços/contadores órfãos em painel
    // próprio; o módulo é separado para o panels não crescer (catraca de 400).
    // Fase 1 do saneamento: por hook (dashboard-general.js) — panels é folha
    // de desenho e não cita o símbolo global do módulo que o estende.
    DashHooks.call("renderGeneralDiagnostics", data);
  }

  // Título de grupo dentro do grid de métricas: separa procedência (persistente
  // × amostra) sem criar seção nova no HTML. O painel do Banco de Magnets
  // (dashboard-magnets.js) também o usa sobre o #magnetMetrics dele.
  function metricGroupTitle(container, text) {
    container.appendChild(element("p", "metric-group", text));
  }

  // O painel do MagnetDB (renderMagnetDb) e o formatTtlSeconds dele vivem em
  // dashboard-magnets.js — o agregado passou a pintar no container próprio
  // (#magnetMetrics) em vez de dividir o #cacheMetrics com o cache.

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

  // Fase 3.7 do redesign — resolver nunca medido é "nunca medido": o probe de
  // /test-resolver.json vive SÓ na memória da instância, então o card precisa
  // nomear a ausência de medição em vez de exibir "—" (que se confunde com
  // medição que falhou) ou um número velho. Respeita _origem (quando o payload
  // a traz para o campo) e o AMOSTRA_CEDO_S do core: processo recém-subido
  // ainda pode medir, e o rótulo diz isso.
  function resolverNeverMeasured(uptimeS) {
    return isAmostraCedo(uptimeS)
      ? "nunca medido (processo recém-iniciado)"
      : "nunca medido neste processo";
  }

  function resolverCardItem(item, uptimeS) {
    var out = copyObject(item);
    var measured = own(item, "status") || (item.lastMs !== undefined && item.lastMs !== null);
    // _origem explícito de "naomedido" vence o resto: é o servidor declarando
    // que o campo não foi medido neste processo.
    if (origemOf(item, "lastMs") === "naomedido") measured = false;
    out.status = measured ? first(item, ["status"], "unknown") : "naomedido";
    // O texto "nunca medido" vence qualquer resíduo do item quando o servidor
    // (ou a ausência de status) declara que não houve medição.
    out.lastMs = measured && item.lastMs !== undefined && item.lastMs !== null
      ? item.lastMs
      : (measured ? "—" : resolverNeverMeasured(uptimeS));
    out.lastError = measured && item.lastError !== undefined && item.lastError !== null
      ? item.lastError
      : (measured ? "—" : resolverNeverMeasured(uptimeS));
    return out;
  }

  function renderSources(data) {
    var source = isObject(data) ? data : {};
    var indexers = first(source, ["indexers", "indexerStatus", "jackett"], []);
    var resolvers = first(source, ["resolvers", "brResolvers", "resolverStatus", "br"], []);
    var uptimeS = first(isObject(source.general) ? source.general : {}, ["uptimeS"], null);
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
    // de teste próprios, decididos dentro de card(). O mapa marca "nunca
    // medido" para o que ainda não passou pelo /test-resolver.json.
    resolvers = asList(resolvers, "resolvers").map(function (item) { return resolverCardItem(item, uptimeS); });
    renderCollection($("resolverCards"), resolvers, "resolvers", { testable: true, kind: "resolver" });
  }

  // Fase 3.3 do redesign: cache por namespace. Os contadores cache.hit.<balde>
  // e cache.miss.<balde> existem desde a Fase 0 do cache, mas a tela só mostrava
  // o hit-rate global — o balde que está pagando rede de novo ficava invisível.
  // `cache.expired` é global (o contador não carrega balde).
  var CACHE_BUCKETS = ["raw", "streams", "meta", "tmdb", "idx", "mag", "dinv", "dlmag", "seed", "autofetch", "indexer-status"];

  function cacheBucketRate(hits, misses) {
    var total = hits + misses;
    return total > 0 ? Math.round((hits / total) * 100) + "%" : "—";
  }

  function renderCacheNamespaces(metrics, counters) {
    var source = isObject(counters) ? counters : {};
    var any = 0;
    var i;
    var name;
    var hits;
    var misses;
    var expired = Number(source["cache.expired"] || 0);
    for (i = 0; i < CACHE_BUCKETS.length; i += 1) {
      name = CACHE_BUCKETS[i];
      if ((Number(source["cache.hit." + name] || 0) + Number(source["cache.miss." + name] || 0)) > 0) any += 1;
    }
    if (!any && !expired) return;
    metricGroupTitle(metrics, "Cache por namespace");
    for (i = 0; i < CACHE_BUCKETS.length; i += 1) {
      name = CACHE_BUCKETS[i];
      hits = Number(source["cache.hit." + name] || 0);
      misses = Number(source["cache.miss." + name] || 0);
      if (!hits && !misses) continue;
      metric(metrics, name + " (hit/miss)", cacheBucketRate(hits, misses) + " · " + hits + "/" + misses);
    }
    metric(metrics, "expirados", expired);
  }

  function renderCache(data, counters) {
    var source = isObject(data) ? data : {};
    var metrics = $("cacheMetrics");
    var cards = $("cacheCards");
    var namespaces = first(source, ["namespaces", "byNamespace", "stats"], []);
    metrics.textContent = "";
    renderMetrics(metrics, source, { namespaces: true, byNamespace: true, stats: true, l2: true });
    if (isObject(source.l2)) {
      metricGroupTitle(metrics, "Persistência L2 (SQLite)");
      // Os quatro campos passam pelo mesmo rótulo, como no Colhedor: `duravel`
      // nos três medidos do disco, `amostra` na fila pendente, que é deste
      // processo e zera no restart. Rotular só o divergente deixaria os outros
      // três sem procedência declarada — o leitor não sabe se é convenção ou
      // esquecimento.
      // `uptimeS` fica undefined: renderCache recebe a seção `cache`, que não
      // carrega o uptime — ele só liga o realce de "amostra cedo demais", e o
      // rótulo de procedência não depende dele.
      metricMaybeOrigem(metrics, "L2 banco (tamanho)", formatBytes(source.l2.fileSizeBytes || 0), source.l2, "fileSizeBytes", undefined);
      metricMaybeOrigem(metrics, "L2 WAL (tamanho)", formatBytes(source.l2.walSizeBytes || 0), source.l2, "walSizeBytes", undefined);
      metricMaybeOrigem(metrics, "L2 freelist (páginas)", source.l2.freelistCount || 0, source.l2, "freelistCount", undefined);
      metricMaybeOrigem(metrics, "L2 fila pendente", source.l2.pendingWrites || 0, source.l2, "pendingWrites", undefined);
    }
    renderCacheNamespaces(metrics, counters);
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

  // Navegação por abas (switchTab/handleHash) vive em dashboard-nav.js —
  // tabela única de abas em vez da escada de if/else por aba.
