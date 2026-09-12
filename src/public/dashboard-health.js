/* Adom Power-Movie — /dashboard: faixa de sinais vitais (Fase 2 do redesign).
 * Faixa sticky com SEIS sinais (taxa ⚡, conta de debrid, indexers, cache,
 * Chupim, primeira resposta I0) + faixa de atenção que REUTILIZA
 * collectStatusIssues() (dashboard-status.js) em vez de colecionar um segundo
 * critério de problema. Também abriga o estado vazio honesto sem token: sem
 * token nenhuma requisição é feita, então nada aqui pode prometer
 * "carregando". Medição de render só com flag (dashdebug=1 na URL ou
 * localStorage) — produção não recebe console. Fase 1 do saneamento: o
 * status consome este módulo pelos hooks registrados no fim do arquivo e o
 * pedido de consulta sai por DashHooks.call("loadStatus") — nenhum dos dois
 * lados cita o símbolo global do outro. Escopo global (sem IIFE). Depois de
 * status/nav, antes do boot. ES5 puro (Fire TV / smart TV). */
"use strict";

  var DASH_DEBUG_KEY = "adom.dashboard.debug";

  function dashDebugEnabled() {
    try {
      if (String(window.location.search || "").indexOf("dashdebug=1") !== -1) return true;
      return readStored(DASH_DEBUG_KEY) === "1";
    } catch (error) { return false; }
  }

  function pctOf(part, total) {
    var n = Number(total);
    if (!isFinite(n) || n <= 0) return "—";
    return Math.round((Number(part || 0) / n) * 100) + "%";
  }

  // 1. Taxa ⚡ — debrid.check.cached / debrid.check.hashes. O hit local do
  // davail (davail.servedHashes) NÃO entra: por contrato ele não é medição de
  // rede, e somá-lo inflaria a taxa acima do que o serviço confirmou.
  function signalRate(root) {
    var counters = first(root.metrics || {}, ["counters"], {});
    var cached = Number(first(counters, ["debrid.check.cached"], 0)) || 0;
    var hashes = Number(first(counters, ["debrid.check.hashes"], 0)) || 0;
    var served = Number(first(counters, ["davail.servedHashes"], 0)) || 0;
    return {
      key: "Taxa ⚡",
      state: hashes > 0 ? "online" : "unknown",
      value: pctOf(cached, hashes),
      title: "Cache confirmado em checagem real: " + cached + " de " + hashes + " hashes" +
        (hashes > 0 ? " (" + pctOf(cached, hashes) + ")" : " — sem checagem ainda") +
        ". Hit local do davail (" + served + ") fica fora da taxa por contrato."
    };
  }

  // 2. Conta de debrid — ok/warn governam o semáforo; números vão no valor e
  // no title (warnAt/premiumUntil/oldestAt são detalhe de hover, não KPI).
  function signalAccount(root) {
    var debrid = isObject(root.debrid) ? root.debrid : {};
    var account = isObject(first(debrid, ["account", "debridStatus"], {})) ? first(debrid, ["account", "debridStatus"], {}) : {};
    var parts = [];
    var state = "unknown";
    if (account.ok === true) state = account.warn ? "warn" : "online";
    else if (account.ok === false) state = "error";
    if (account.magnets != null) parts.push(account.magnets + " magnets");
    if (account.ready != null) parts.push(account.ready + " prontos");
    if (account.active != null) parts.push(account.active + " ativos");
    if (account.error) parts.push(account.error + " com erro");
    return {
      key: "Conta debrid",
      state: state,
      value: parts.join(" · ") || "—",
      title: (account.label || account.service || "Conta") +
        (account.warn ? " — aviso operacional (teto em " + valueText(account.warnAt) + " " + valueText(account.warnAtUnit) + ")" : "") +
        (account.premiumUntil ? " · premium até " + formatDate(account.premiumUntil) : "") +
        (account.oldestAt ? " · magnet mais velho de " + formatDate(account.oldestAt) : "")
    };
  }

  // 3. Indexers — online/total sobre a lista; breaker aberto e flagSlow são
  // detalhe do title. Lista vazia é "não medido", não "tudo online".
  function signalIndexers(root) {
    var list = asList(root.indexers, "indexers");
    var online = 0;
    var measured = 0;
    var tripped = 0;
    var slow = 0;
    var i;
    var item;
    var st;
    var b;
    var isOffline;
    for (i = 0; i < list.length; i += 1) {
      item = list[i] || {};
      st = isObject(item.status) ? item.status : null;
      b = isObject(item.breaker) ? item.breaker : {};
      // Não medido não é online: sem `online` booleano nem `status`, a linha
      // não conta como prova — a semáforo fica neutro em vez de verde.
      if (item.online === true || item.online === false || st !== null) {
        measured += 1;
        isOffline = item.online === false || (st !== null && st.state === "offline");
        if (!isOffline) online += 1;
      }
      if (b.state === "aberto" || (!b.state && b.tripped)) tripped += 1;
      if (item.flagSlow) slow += 1;
    }
    return {
      key: "Indexers",
      // Verde exige TODOS medidos e online: não medido derruba para atenção
      // (não para online), pois a ausência de prova não é prova de saúde.
      state: !list.length || !measured ? "unknown" : (online < list.length || tripped > 0 ? "warn" : "online"),
      value: list.length ? online + "/" + list.length : "—",
      title: list.length
        ? "Saúde medida dos indexadores. Não medidos: " + (list.length - measured) +
          " · Breaker aberto: " + tripped + " · lentos (flagSlow): " + slow + "."
        : "Nenhum indexador reportado ainda."
    };
  }

  // 4. Cache — hitRate + ocupação; o tamanho do L2 (disco) é detalhe do title.
  function signalCache(root) {
    var cache = isObject(root.cache) ? root.cache : {};
    var l2 = isObject(cache.l2) ? cache.l2 : {};
    var rate = Number(cache.hitRate);
    var hasRate = cache.hitRate !== null && cache.hitRate !== undefined && isFinite(rate);
    return {
      key: "Cache",
      // hitRate ausente/ilegível é "não medido": verde sem medição mentiria.
      state: hasRate ? "online" : "unknown",
      value: hasRate ? Math.round(rate * 100) + "%" : "—",
      title: "Hit-rate do cache (L1+L2). Entradas: " + valueText(cache.entries) + " de " +
        valueText(cache.maxEntries) + " · L2 no disco: " + formatBytes(l2.fileSizeBytes || 0) + "."
    };
  }

  // 5. Chupim (autofetch) — pausado é amarelo de propósito: é estado que o
  // operador precisa enxergar sem abrir a aba. Orçamento e lotes no title.
  function signalChupim(root) {
    var af = isObject(root.autofetch) ? root.autofetch : {};
    var queues = isObject(af.queues) ? af.queues : {};
    var budget = isObject(af.budget) ? af.budget : {};
    return {
      key: "Chupim",
      state: !isObject(root.autofetch) ? "unknown" : (af.paused ? "warn" : "online"),
      value: isObject(root.autofetch) ? valueText(queues.count) + " fila(s)" : "—",
      title: "Autofetch em fundo. Itens em fila: " + valueText(queues.items) +
        " · lotes recheck: " + valueText(af.recheckLots) + " (settle: " + valueText(af.settleLots) + ")" +
        " · orçamento da hora: " + valueText(budget.used) + "/" + valueText(budget.limit) +
        (af.paused ? " · PAUSADO" : "")
    };
  }

  // 6. Primeira resposta (I0) — bloco searchFirst inteiro no title; o valor
  // visível é o que foi realmente entregue na abertura (brVisible).
  function signalSearchFirst(root) {
    var sf = isObject(root.searchFirst) ? root.searchFirst : {};
    return {
      key: "1ª resposta (I0)",
      state: Number(sf.responses) > 0 ? "online" : "unknown",
      value: Number(sf.brVisible) > 0 || Number(sf.brFound) > 0
        ? valueText(sf.brVisible) + "/" + valueText(sf.brFound) + " BR"
        : "—",
      title: "Observabilidade da primeira resposta fria. Respostas medidas: " + valueText(sf.responses) +
        " · BR encontradas: " + valueText(sf.brFound) + " · em cache: " + valueText(sf.brCached) +
        " · ocultadas pelo cachedOnly: " + valueText(sf.brHidden) + " · entregues: " + valueText(sf.brVisible) +
        " · ganho tardio: " + valueText(sf.brLate) + "."
    };
  }

  function renderHealthStrip(root) {
    var strip = $("healthStrip");
    var source = isObject(root) ? root : {};
    var builders = [signalRate, signalAccount, signalIndexers, signalCache, signalChupim, signalSearchFirst];
    var i;
    var s;
    var cell;
    var value;
    if (!strip) return;
    strip.textContent = "";
    for (i = 0; i < builders.length; i += 1) {
      s = builders[i](source);
      cell = element("div", "health-cell state-" + s.state);
      cell.setAttribute("role", "listitem");
      cell.title = s.title;
      cell.appendChild(element("span", "health-key", s.key));
      value = element("span", "health-value");
      value.appendChild(element("span", "health-dot"));
      value.appendChild(document.createTextNode(s.value));
      cell.appendChild(value);
      strip.appendChild(cell);
    }
  }

  // Faixa "precisa de atenção": MESMA fonte do banner (collectStatusIssues) —
  // dois lugares, um critério. Some sozinha quando a resposta volta saudável.
  function renderAttentionStrip(issues) {
    var strip = $("attentionStrip");
    var list = Array.isArray(issues) ? issues : [];
    var worstError = false;
    var i;
    if (!strip) return;
    strip.textContent = "";
    if (!list.length) { strip.className = "attention-strip"; return; }
    for (i = 0; i < list.length; i += 1) if (list[i].state === "error") worstError = true;
    strip.className = "attention-strip visible" + (worstError ? " error" : "");
    for (i = 0; i < list.length; i += 1) {
      strip.appendChild(element("p", "attention-line " + list[i].state, list[i].text));
    }
  }

  // Estado vazio honesto (Fase 2.2): sem token NENHUMA requisição é feita —
  // o estado nomeia a causa, a saída e traz o campo de token ali dentro.
  function updateEmptyState() {
    var box = $("healthEmptyState");
    if (!box) return;
    box.hidden = Boolean(DashState.token);
  }

  function saveEmptyToken() {
    var input = $("emptyToken");
    var field = $("token");
    DashState.token = String((input && input.value) || "").replace(/\s+/g, "");
    if (input) input.value = DashState.token;
    // Sincroniza o campo do topo: o token salvo aqui é o mesmo que o operador
    // vê e edita depois — divergir deixaria os dois campos mostrando valores
    // diferentes.
    if (field) field.value = DashState.token;
    // Mesma semântica do "Guardar neste dispositivo": só persiste com a opção
    // marcada; desmarcada remove qualquer token guardado.
    if ($("rememberToken") && $("rememberToken").checked) writeStored(TOKEN_KEY, DashState.token);
    else removeStored(TOKEN_KEY);
    updateEmptyState();
    if (DashState.token) DashHooks.call("loadStatus");
  }

  function bindHealthPanel() {
    var save = $("emptySaveToken");
    var input = $("emptyToken");
    if (save) save.addEventListener("click", saveEmptyToken);
    if (input) input.addEventListener("keydown", function (event) { if (event.key === "Enter") saveEmptyToken(); });
    updateEmptyState();
  }

  // Fase 1 do saneamento — registro declarativo no DashHooks (única execução
  // no load deste módulo; dado no registro, não wiring). O ciclo status↔health
  // fecha pelos hooks: o status consome os quatro primeiros e este módulo pede
  // a consulta pelo hook loadStatus (registrado pelo status), sem citar o
  // símbolo global do outro arquivo em nenhum dos sentidos.
  DashHooks.register("renderHealthStrip", renderHealthStrip);
  DashHooks.register("renderAttentionStrip", renderAttentionStrip);
  DashHooks.register("updateEmptyState", updateEmptyState);
  DashHooks.register("dashDebugEnabled", dashDebugEnabled);
