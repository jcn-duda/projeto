/* Adom Power-Movie - pagina /dashboard: teste pontual de conta de debrid
 * (Fase 1 do debrid configurável). Extraido de dashboard-panels.js ao se
 * aproximar do teto de 400 linhas da catraca. Consulta PONTUAL: POST
 * debrid-account-test com { service, key } atrás do token de diagnóstico.
 * A chave viaja no CORPO do POST (nunca na URL), não é salva em lugar
 * nenhum e o teste NÃO altera a conta do operador nem o .env — quem
 * configura a conta continua sendo a instalação, não esta tela. A forma da
 * resposta é a do testAccount no backend (account com magnets, capabilities
 * por adaptador); o render continua tolerante a campo ausente. Escopo global
 * compartilhado (sem IIFE); carregado DEPOIS de core/panels/status e ANTES
 * do script inline, que binda os controles. Nada roda no load. ES5 puro:
 * WebView de Fire TV e smart TV. Sem build, sem bundler. */
"use strict";

  // Rótulos das capabilities do testAccount; chave nova do backend cai no
  // prettyKey em vez de sumir.
  var DEBRID_CAPABILITY_LABELS = {
    cacheCheck: "consulta de cache",
    abortSafeCacheCheck: "checagem abortável",
    accountStatus: "consulta de ocupação",
    inventory: "inventário da conta",
    autofetch: "chupim (autofetch)",
    torrentStatus: "estado de torrent",
    catalogCleanup: "catálogo / limpeza"
  };

  function setDebridTestFeedback(text, kind) {
    var node = $("debridTestFeedback");
    if (!node) return;
    node.className = "feedback" + (kind ? " " + kind : "");
    node.textContent = text || "";
  }

  // O select nasce vazio no HTML e é preenchido da MESMA fonte dos cards de
  // debrid (knownServices, em dashboard-core.js): serviço novo entra nos dois
  // lugares juntos, sem lista duplicada para manter na tela.
  function fillDebridTestServices() {
    var select = $("debridTestService");
    var i;
    if (!select) return;
    select.textContent = "";
    for (i = 0; i < knownServices.length; i += 1) {
      var option = document.createElement("option");
      option.value = knownServices[i].id;
      option.textContent = knownServices[i].label;
      select.appendChild(option);
    }
  }

  function debridTestServiceLabel(id) {
    var text = String(isObject(id) ? first(id, ["id", "service"], "") : id || "").toLowerCase();
    var i;
    for (i = 0; i < knownServices.length; i += 1) {
      if (knownServices[i].id === text) return knownServices[i].label;
    }
    return text ? titleText(text) : "serviço";
  }

  // Rótulo do serviço na resposta: o `label` do backend vence; o mapa local é
  // o fallback (feedback antes do POST, resposta sem label).
  function debridTestResponseLabel(data, serviceId) {
    var label = isObject(data) ? data.label : null;
    return (typeof label === "string" && label) ? label : debridTestServiceLabel(serviceId);
  }

  function debridTestState(data) {
    if (!isObject(data)) return "unknown";
    if (data.ok === false) return "error";
    return stateName(first(data, ["status", "state", "health"], data.ok === true ? "online" : "unknown"));
  }

  // Motivo legível: reason traduzido pelo mapa do status.js (auth/quota/rate/
  // timeout...), com o erro cru e o fix do backend anexados.
  function debridTestMotivo(data) {
    var reason = isObject(data) ? data.reason : null;
    var detalhe = valueText(first(data, ["error", "message"], ""));
    var motivo = reason ? reasonText(reason) : "";
    if (!motivo) motivo = detalhe !== "—" ? detalhe : "motivo não informado";
    else if (detalhe !== "—") motivo += " (" + detalhe + ")";
    if (isObject(data) && data.fix) motivo += " — Como corrigir: " + valueText(data.fix);
    return motivo;
  }

  // Magnets: o testAccount devolve account.magnets (total) + ready/active;
  // formas alternativas (número solto, objeto com total/used/limit) seguem
  // cobertas para o painel sobreviver a ajuste no backend.
  function debridTestMagnetsText(data) {
    var account = isObject(data) && isObject(data.account) ? data.account : {};
    var raw = first(data, ["magnets", "magnetCount", "magnetTotal"], first(account, ["magnets", "magnetCount"], null));
    var partes = [];
    if (typeof raw === "number" && isFinite(raw)) partes.push("total " + String(raw));
    else if (typeof raw === "string" && raw) return raw;
    if (isObject(raw)) {
      if (raw.total !== undefined && raw.total !== null) partes.push("total " + valueText(raw.total));
      if (raw.used !== undefined && raw.used !== null) partes.push("usado " + valueText(raw.used));
      if (raw.limit !== undefined && raw.limit !== null) partes.push("limite " + valueText(raw.limit));
    }
    if (account.ready !== undefined && account.ready !== null) partes.push("prontos " + valueText(account.ready));
    if (account.active !== undefined && account.active !== null) partes.push("baixando " + valueText(account.active));
    return partes.join(" · ");
  }

  // Capabilities: objeto { cacheCheck: true, ... } ou lista de nomes. Booleano
  // vira sim/não; rótulo conhecido traduz, desconhecido cai no prettyKey —
  // o backend pode acrescentar capacidade sem quebrar a tela.
  function debridTestCapLines(data) {
    var caps = first(data, ["capabilities", "caps"], null);
    var lines = [];
    var keys;
    var i;
    if (Array.isArray(caps)) {
      for (i = 0; i < caps.length; i += 1) {
        lines.push({ label: DEBRID_CAPABILITY_LABELS[caps[i]] || prettyKey(String(caps[i])), value: "sim" });
      }
      return lines;
    }
    if (!isObject(caps)) return lines;
    keys = Object.keys(caps);
    for (i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var value = caps[key];
      if (value === null || typeof value === "object") continue;
      lines.push({ label: DEBRID_CAPABILITY_LABELS[key] || prettyKey(key), value: valueText(value) });
    }
    return lines;
  }

  function debridTestLine(label, value) {
    var line = element("div", "status-line");
    line.appendChild(element("span", "", label));
    line.appendChild(element("strong", "", value));
    return line;
  }

  // Card simples, SEM <details>: o resultado do teste precisa estar visível
  // de imediato, sem exigir um OK a mais no D-pad da TV para abrir.
  function renderDebridTestResult(data) {
    var out = $("debridTestOutput");
    var box;
    var head;
    var stateBox;
    var state;
    var rows;
    var caps;
    var magnets;
    var i;
    if (!out) return;
    clear(out);
    if (!isObject(data)) { empty(out, "Resposta do teste não chegou ao formato esperado."); return; }
    state = debridTestState(data);
    box = element("div", "card");
    box.setAttribute("data-status", state);
    head = element("div", "card-head");
    head.appendChild(element("h3", "", "Teste · " + debridTestResponseLabel(data, first(data, ["service", "serviceId"], ""))));
    stateBox = element("span", "state status-" + state);
    stateBox.appendChild(element("span", "dot"));
    stateBox.appendChild(element("span", "", stateLabel(state)));
    head.appendChild(stateBox);
    box.appendChild(head);
    rows = element("div", "status-list");
    rows.appendChild(debridTestLine("Serviço", debridTestResponseLabel(data, first(data, ["service", "serviceId"], ""))));
    rows.appendChild(debridTestLine("Saúde", stateLabel(state)));
    magnets = debridTestMagnetsText(data);
    if (magnets) rows.appendChild(debridTestLine("Magnets", magnets));
    caps = debridTestCapLines(data);
    for (i = 0; i < caps.length; i += 1) rows.appendChild(debridTestLine(caps[i].label, caps[i].value));
    box.appendChild(rows);
    if (data.ok === false) box.appendChild(element("p", "guidance error", debridTestMotivo(data)));
    out.appendChild(box);
  }

  function runDebridAccountTest(button) {
    var input = $("debridTestKey");
    var select = $("debridTestService");
    var service = select ? String(select.value || "") : "";
    var key = input ? String(input.value || "") : "";
    if (!service) { setDebridTestFeedback("Escolha o serviço da chave a testar.", "warn"); return; }
    if (!key) { setDebridTestFeedback("Cole a chave de API do serviço escolhido.", "warn"); return; }
    if (!currentToken) { setDebridTestFeedback("Informe o token de diagnóstico antes de testar uma chave.", "error"); if ($("token")) $("token").focus(); return; }
    if (button) button.disabled = true;
    setDebridTestFeedback("Testando chave no " + debridTestServiceLabel(service) + "…", "warn");
    requestJson("/dashboard-action.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "debrid-account-test", service: service, key: key })
    })
      .then(function (data) {
        // A chave sai do input em TODO desfecho com resposta do servidor: em
        // erro de auth ela provou ser inválida e em sucesso já cumpriu o
        // papel — reter credencial no DOM depois do teste não tem valor.
        if (input) input.value = "";
        renderDebridTestResult(data);
        setDebridTestFeedback(
          data && data.ok ? "Chave aceita pelo serviço." : "Teste sem sucesso: " + debridTestMotivo(data) + ".",
          data && data.ok ? "ok" : "error"
        );
      })
      .catch(function (error) {
        // Falhou ANTES de o servidor avaliar a chave (rede, token do painel,
        // rate limit): mesma regra uniforme — nenhum desfecho deixa a chave
        // no input; retestar é colar de novo.
        if (input) input.value = "";
        setDebridTestFeedback("Teste não concluído: " + valueText(error && error.message ? error.message : error), "error");
      })
      .then(function () { if (button) button.disabled = false; });
  }
