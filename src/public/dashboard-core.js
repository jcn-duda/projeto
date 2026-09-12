/* Adom Power-Movie — /dashboard: núcleo compartilhado (Fase 3 §5.9 + Fase 1).
 * Helpers puros e HTTP autenticado; o ESTADO mutável entre módulos (token,
 * timers, requestInFlight, lastStatusRoot…) vive em dashboard-state.js
 * (DashState, Fase 2 do saneamento). Escopo global (sem IIFE). Nada
 * roda no load. O que DESENHA (metric/card/formatos/sparkline) vive em
 * dashboard-render.js; sondas em dashboard-probes.js; abas em dashboard-nav.js;
 * painéis da Geral em dashboard-panels.js; Chupim / Colhedor / Catálogo /
 * MagnetDB → módulos próprios; wiring → dashboard-boot.js. ES5 puro
 * (Fire TV / smart TV). */
"use strict";

  var TOKEN_KEY = "adom.dashboard.test-token";
  var RATE_KEY = "adom.dashboard.refresh-rate";
  var knownServices = [
    { id: "premiumize", label: "Premiumize" }, { id: "alldebrid", label: "AllDebrid" },
    { id: "torbox", label: "TorBox" }, { id: "realdebrid", label: "Real-Debrid" },
    { id: "debridlink", label: "Debrid-Link" }
  ];

  function $(id) { return document.getElementById(id); }
  function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function copyObject(source) {
    var out = {};
    Object.keys(isObject(source) ? source : {}).forEach(function (key) { out[key] = source[key]; });
    return out;
  }
  function own(object, key) { return isObject(object) && Object.prototype.hasOwnProperty.call(object, key); }
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
    if (typeof value === "number") return isFinite(value) ? String(value) : "—";
    if (typeof value === "object") return "ver detalhes";
    return String(value);
  }

  // Fase 4 — procedência do painel (_origem). Limiar alinhado ao Chupim:
  // uptime baixo + amostra pode subcontar L2 após restart.
  var AMOSTRA_CEDO_S = 300;

  function isAmostraCedo(uptimeS) {
    var n = Number(uptimeS);
    return isFinite(n) && n >= 0 && n < AMOSTRA_CEDO_S;
  }

  function origemOf(map, key) {
    var o;
    if (!isObject(map) || !key) return null;
    o = map._origem;
    if (!isObject(o)) return null;
    if (o[key] === "duravel" || o[key] === "amostra" || o[key] === "naomedido") return o[key];
    return null;
  }

  function origemTitle(kind, uptimeS) {
    if (kind === "duravel") return "Persistente (L1/L2 ou fila durável)";
    if (kind === "amostra") {
      return isAmostraCedo(uptimeS)
        ? "Amostra deste processo (uptime baixo; pode subcontar o L2)"
        : "Amostra deste processo (≠ L1/L2)";
    }
    if (kind === "naomedido") return "Ainda não medido neste processo";
    return "";
  }

  function origemValue(value, kind) {
    // Fail-open: sem _origem o número antigo continua; só naomedido vira "—".
    if (kind === "naomedido") return "—";
    return valueText(value);
  }

  function setFeedback(text, kind) {
    var node = $("feedback");
    node.className = "feedback" + (kind ? " " + kind : "");
    node.textContent = text || "";
  }

  function setConnection(state, text) {
    var node = $("connection");
    var cls = "connection";
    if (state && state !== "unknown") {
      cls += " " + (state === "error" ? "error" : state === "warn" ? "warn" : state === "syncing" ? "syncing" : "online");
    }
    node.className = cls;
    $("connectionText").textContent = text;
  }

  function authHeaders(extra) {
    var headers = {};
    var key;
    for (key in (extra || {})) {
      if (Object.prototype.hasOwnProperty.call(extra || {}, key)) headers[key] = extra[key];
    }
    if (DashState.token) headers["X-Indexer-Test-Token"] = DashState.token;
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
    var timeoutId = null;
    var controller = null;
    request.headers = authHeaders(request.headers);
    if (typeof AbortController !== "undefined") {
      controller = new AbortController();
      request.signal = controller.signal;
      timeoutId = setTimeout(function () {
        try { controller.abort(); } catch (e) {}
      }, 10000);
    }
    return fetch(basePrefix() + url, request).then(function (response) {
      if (timeoutId) clearTimeout(timeoutId);
      return response.json().then(function (data) {
        if (!response.ok) {
          // `fix` das ações aponta o conserto (ex.: aba Conta do Colhedor sem
          // conta de operador); o campo já viaja na mensagem do erro (abaixo),
          // então o operador vê a instrução sem leitor adicional.
          var fix = data && data.fix;
          var message = ((data && (data.error || data.message)) || "HTTP " + response.status) + (fix ? " — " + fix : "");
          var error = new Error(message);
          error.status = response.status;
          throw error;
        }
        return data;
      });
    }, function (err) {
      if (timeoutId) clearTimeout(timeoutId);
      throw err;
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
    var values, parsed;
    if (!isFinite(Number(value))) return [];
    try { parsed = JSON.parse(readStored(seriesKey(name)) || "[]"); } catch (error) { parsed = []; }
    values = Array.isArray(parsed) ? parsed : [];
    values.push(Number(value));
    values = values.slice(-120);
    writeStored(seriesKey(name), JSON.stringify(values));
    return values;
  }

  function removeStored(key) {
    try { window.localStorage.removeItem(key); } catch (error) { /* storage bloqueado não impede o dashboard */ }
  }
