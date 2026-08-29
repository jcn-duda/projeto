/* Adom Power-Movie - pagina /dashboard: nucleo compartilhado (Fase 3, PLANO_MELHORIAS 5.9).
 * Estado comum, helpers de formato/DOM, HTTP autenticado e armazenamento local,
 * extraidos do script inline do dashboard.html. Escopo global compartilhado
 * (por isso sem IIFE) e carregado ANTES de panels/status e do script inline -
 * nada roda no load, so declaracoes; as chamadas acontecem em tempo de evento.
 * O que os testes regexam (renderMagnetDb, paineis do Chupim/Colhedor, secao
 * Conta / Catalogo) continua INLINE no HTML. ES5 puro: WebView de Fire TV e
 * smart TV. Sem build, sem bundler. */
"use strict";

  var TOKEN_KEY = "adom.dashboard.test-token";
  var RATE_KEY = "adom.dashboard.refresh-rate";
  var knownServices = [
    { id: "premiumize", label: "Premiumize" },
    { id: "alldebrid", label: "AllDebrid" },
    { id: "torbox", label: "TorBox" },
    { id: "realdebrid", label: "Real-Debrid" },
    { id: "debridlink", label: "Debrid-Link" }
  ];
  var currentToken = "";
  var refreshTimer = null;
  var requestInFlight = false;
  var consecutiveFailures = 0;
  var lastOkAt = 0;
  var lastUpdatedTimer = null;

  function $(id) { return document.getElementById(id); }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function copyObject(source) {
    var out = {};
    Object.keys(isObject(source) ? source : {}).forEach(function (key) { out[key] = source[key]; });
    return out;
  }

  function own(object, key) {
    return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
  }

  function first(object, names, fallback) {
    var i;
    if (!object) return fallback;
    for (i = 0; i < names.length; i += 1) {
      if (object[names[i]] !== undefined && object[names[i]] !== null) return object[names[i]];
    }
    return fallback;
  }

  function valueText(value) {
    if (value === undefined || value === null || value === "") return "—";
    if (typeof value === "boolean") return value ? "sim" : "não";
    if (typeof value === "number") {
      if (!isFinite(value)) return "—";
      return String(value);
    }
    if (typeof value === "object") return "ver detalhes";
    return String(value);
  }

  function titleText(value) {
    return String(value || "sem nome").replace(/[-_]+/g, " ");
  }

  function formatBytes(value) {
    var number = Number(value);
    var units = ["B", "KB", "MB", "GB", "TB"];
    var unit = 0;
    if (!isFinite(number) || number < 0) return valueText(value);
    while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit += 1; }
    return number.toFixed(unit === 0 ? 0 : number < 10 ? 1 : 0) + " " + units[unit];
  }

  function formatDuration(value) {
    var number = Number(value);
    if (!isFinite(number)) return valueText(value);
    if (number < 1000) return Math.round(number) + " ms";
    number /= 1000;
    if (number < 60) return number.toFixed(1) + " s";
    return Math.floor(number / 60) + " min " + Math.round(number % 60) + " s";
  }

  function formatDate(value) {
    var date;
    if (!value) return "—";
    date = new Date(value);
    return isNaN(date.getTime()) ? valueText(value) : date.toLocaleString("pt-BR");
  }

  function prettyKey(key) {
    return titleText(key).replace(/\b(ms|id|br|db|rss|l1|l2)\b/gi, function (part) { return part.toUpperCase(); });
  }

  function displayValue(key, value) {
    var lower = String(key).toLowerCase();
    if (lower.indexOf("bytes") !== -1 || lower.indexOf("memory") !== -1 || lower === "rss" || lower === "heapused") return formatBytes(value);
    if (lower.indexOf("uptime") !== -1 || lower.indexOf("duration") !== -1 || lower.indexOf("latency") !== -1 || /ms$/.test(lower)) return formatDuration(value);
    if (lower.indexOf("at") !== -1 && (typeof value === "string" || typeof value === "number")) return formatDate(value);
    return valueText(value);
  }

  function stateName(value) {
    var text = String(value === undefined || value === null ? "unknown" : value).toLowerCase();
    if (value === true || text === "ok" || text === "online" || text === "ready" || text === "healthy" || text === "up" || text === "available") return "online";
    if (text.indexOf("slow") !== -1 || text.indexOf("degrad") !== -1 || text === "warn" || text === "warning" || text === "partial") return "warn";
    if (value === false || text === "offline" || text === "error" || text === "dead" || text === "down" || text === "failed" || text === "unusable") return "error";
    return "unknown";
  }

  function stateLabel(value) {
    var state = stateName(value);
    if (state === "online") return "online";
    if (state === "warn") return "atenção";
    if (state === "error") return "offline";
    return "não medido";
  }

  function element(name, className, text) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function empty(container, text) {
    container.textContent = "";
    container.appendChild(element("div", "empty", text));
  }

  /**
   * Esvazia SEM deixar placeholder. `empty()` insere a caixa "vazio" e quem
   * renderiza logo em seguida ANEXA — o placeholder ficava visível colado no
   * conteúdo real ("sem relatório" ao lado dos números). Quem vai desenhar
   * algo usa `clear()`; `empty()` fica só para o caso realmente vazio.
   */
  function clear(container) {
    container.textContent = "";
  }

  function setFeedback(text, kind) {
    var node = $("feedback");
    node.className = "feedback" + (kind ? " " + kind : "");
    node.textContent = text || "";
  }

  function setConnection(state, text) {
    var node = $("connection");
    node.className = "connection" + (state && state !== "unknown" ? " " + (state === "error" ? "error" : state === "warn" ? "warn" : "online") : "");
    $("connectionText").textContent = text;
  }

  function authHeaders(extra) {
    var headers = {};
    var key;
    for (key in (extra || {})) {
      if (Object.prototype.hasOwnProperty.call(extra || {}, key)) headers[key] = extra[key];
    }
    if (currentToken) headers["X-Indexer-Test-Token"] = currentToken;
    return headers;
  }

  // Segmento de config em que a página foi aberta ("" na raiz, "/abc123" numa
  // install URL). Sem isto o painel sempre perguntaria pela conta do .env,
  // mesmo aberto a partir da instalação do usuário.
  function basePrefix() {
    var match = String(window.location.pathname || "").match(/^\/(.+)\/dashboard\/?$/);
    return match ? "/" + match[1] : "";
  }

  function requestJson(url, options) {
    var request = options || {};
    request.headers = authHeaders(request.headers);
    return fetch(basePrefix() + url, request).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          var error = new Error((data && (data.error || data.message)) || "HTTP " + response.status);
          error.status = response.status;
          throw error;
        }
        return data;
      });
    });
  }

  function readStored(key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  }

  function writeStored(key, value) {
    try { window.localStorage.setItem(key, value); } catch (error) { /* storage bloqueado não impede o dashboard */ }
  }

  function seriesKey(name) { return "adom.dashboard.series." + name; }

  function pushSeries(name, value) {
    var values;
    var parsed;
    if (!isFinite(Number(value))) return [];
    try { parsed = JSON.parse(readStored(seriesKey(name)) || "[]"); } catch (error) { parsed = []; }
    values = Array.isArray(parsed) ? parsed : [];
    values.push(Number(value));
    values = values.slice(-120);
    writeStored(seriesKey(name), JSON.stringify(values));
    return values;
  }

  function drawSparkline(id, values, color) {
    var canvas = $(id);
    var context;
    var max;
    var min;
    var i;
    if (!canvas || !canvas.getContext || values.length < 2) return;
    context = canvas.getContext("2d");
    if (!context) return;
    max = Math.max.apply(Math, values);
    min = Math.min.apply(Math, values);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 2;
    for (i = 0; i < values.length; i += 1) {
      var x = (i / (values.length - 1)) * canvas.width;
      var y = max === min ? canvas.height / 2 : canvas.height - ((values[i] - min) / (max - min)) * (canvas.height - 4) - 2;
      if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.stroke();
  }

  function removeStored(key) {
    try { window.localStorage.removeItem(key); } catch (error) { /* storage bloqueado não impede o dashboard */ }
  }

  function metric(container, key, value) {
    var item = element("div", "metric");
    var label = element("span", "key", prettyKey(key));
    var content = element("span", "value" + (String(valueText(value)).length > 20 ? " small" : ""), displayValue(key, value));
    item.appendChild(label);
    item.appendChild(content);
    container.appendChild(item);
  }

  function renderMetrics(container, object, excluded) {
    var keys;
    var i;
    if (!isObject(object)) { empty(container, "Nenhuma métrica disponível."); return; }
    keys = Object.keys(object);
    for (i = 0; i < keys.length; i += 1) {
      if (excluded && excluded[keys[i]]) continue;
      if (object[keys[i]] === null || typeof object[keys[i]] === "object") continue;
      metric(container, keys[i], object[keys[i]]);
    }
    if (!container.children.length) empty(container, "Nenhuma métrica disponível.");
  }

  function asList(value, preferredKey) {
    var result = [];
    var keys;
    var i;
    var item;
    if (Array.isArray(value)) return value;
    if (!isObject(value)) return result;
    if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
    if (Array.isArray(value.items)) return value.items;
    keys = Object.keys(value);
    for (i = 0; i < keys.length; i += 1) {
      item = value[keys[i]];
      if (isObject(item)) {
        if (!own(item, "id") && !own(item, "name") && !own(item, "label")) item.id = keys[i];
        result.push(item);
      } else {
        result.push({ id: keys[i], value: item });
      }
    }
    return result;
  }

  function card(container, item, options) {
    var box = element("details", "card");
    var head = element("summary", "card-head");
    var title = first(item, ["label", "name", "title", "id"], options && options.fallback || "sem nome");
    var state = first(item, ["state", "status", "health", "online", "ready"], "unknown");
    if (isObject(state)) state = first(state, ["state", "status", "health"], "unknown");
    var stateBox = element("span", "state status-" + stateName(state));
    var dot = element("span", "dot");
    var stateText = element("span", "", stateLabel(state));
    var keys;
    var excluded = { id: true, label: true, name: true, title: true, state: true, status: true, health: true, online: true, ready: true, error: true, message: true };
    var rows = element("div", "status-list");
    var i;
    var key;
    var value;
    var button;
    box.setAttribute("data-status", stateName(state));
    head.appendChild(element("h3", "", titleText(title)));
    stateBox.appendChild(dot);
    stateBox.appendChild(stateText);
    head.appendChild(stateBox);
    box.appendChild(head);
    if (first(item, ["description", "detail", "message", "error"], null)) box.appendChild(element("p", "card-subtitle", valueText(first(item, ["description", "detail", "message", "error"], ""))));
    if (item.reason && item.fix) {
      box.appendChild(element("p", "guidance" + (item.reason === "rate" ? "" : " error"), "Como corrigir: " + valueText(item.fix)));
    }
    keys = Object.keys(item);
    for (i = 0; i < keys.length; i += 1) {
      key = keys[i]; value = item[key];
      if (excluded[key] || value === null || typeof value === "object") continue;
      rows.appendChild(element("div", "status-line"));
      rows.lastChild.appendChild(element("span", "", prettyKey(key)));
      rows.lastChild.appendChild(element("strong", "", displayValue(key, value)));
    }
    if (rows.children.length) box.appendChild(rows);
    if (options && options.testable) {
      button = element("button", "mini-action", "Testar este indexador");
      button.type = "button";
      button.setAttribute("data-indexer-id", String(first(item, ["id", "key", "name"], "")));
      button.addEventListener("click", function () { runIndexerTest(button.getAttribute("data-indexer-id"), button); });
      box.appendChild(button);
    }
    container.appendChild(box);
  }
