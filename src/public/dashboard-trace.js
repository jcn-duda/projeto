"use strict";

// Stream Trace — aba de diagnóstico do funil de busca (P5). ES5 puro: roda no
// WebView de Fire TV e smart TV, sem build. Nada executa no load (só
// declarações); o bind dos controles fica no inline `bind()` do dashboard.html
// (mesma divisão do dashboard-debrid-test.js).
//
// Contratos:
// - Consulta offline: GET /stream-trace.json (basePrefix + token no header) —
//   NUNCA ?token=. O corpo nunca traz hash/magnet/chave/URL de config; o
//   render só usa textContent (nunca monta HTML por string).
// - Live (Fatia B): só aparece quando o backend diz live.allowed === true E o
//   serviço efetivo está na allowlist fechada torbox/premiumize. Em
//   realdebrid/alldebrid/debridlink o botão NUNCA é renderizado, mesmo que o
//   backend minta — e a recusa do backend vira feedback legível.
// - Sem polling: nenhuma consulta automática; só no clique.
var LIVE_SERVICES = { torbox: true, premiumize: true };

function setTraceFeedback(text, kind) {
  var el = $("traceFeedback");
  if (!el) return;
  el.textContent = text;
  el.className = "feedback" + (kind ? " " + kind : "");
}

function traceLiveAllowed(data) {
  if (!isObject(data) || !isObject(data.live)) return false;
  if (data.live.allowed !== true) return false;
  var service = String(data.live.service || "");
  return LIVE_SERVICES[service] === true;
}

function traceReasonLabel(reason) {
  var map = {
    "title-filter": "filtro de título",
    "multiwork-retained": "pack multi-obra retido",
    "episode-mismatch": "episódio não casa",
    "no-hash": "sem hash",
    dedupe: "duplicado",
    "min-seeders": "abaixo do piso de seeds",
    "quality-filter": "qualidade fora do filtro",
    "cam-excluded": "CAM excluída",
    "size-limit": "acima do limite de tamanho",
    "pool-cut": "corte do pool",
    bad: "magnet quebrado (bad)",
    dead: "torrent morto",
    lie: "áudio mentiu (lie)",
    "idx-miss": "não serve este episódio (idx)",
    "cached-only": "fora do cache (cachedOnly)",
    "rd-miss": "miss confirmado no RD",
    "quality-quota": "cota da qualidade",
    "indexer-limit": "teto do indexer",
    "max-results": "corte de maxResults",
    "br-guarantee-replaced": "vaga BR garantida trocou",
    notice: "aviso de lista vazia"
  };
  return map[reason] || reason;
}

function traceStageLabel(stage) {
  var map = { raw: "bruto", afterSort: "pós-ordenação", notice: "aviso", final: "entregue" };
  return map[stage] || stage;
}

function renderTraceCache(cache, type, id) {
  var el = $("traceCacheMetrics");
  if (!el) return;
  clear(el);
  metric(el, "obra", type + " " + id);
  metric(el, "parcial", valueText(cache.partial === true ? "sim" : "não"));
  metric(el, "debrid conhecido", valueText(cache.debridKnown === true ? "sim" : "não"));
  metric(el, "stale (na graça)", valueText(cache.stale === true ? "sim" : "não"));
  metric(el, "TTL restante", String(cache.remainingS || 0) + "s");
}

function renderTraceStages(stages) {
  var el = $("traceStages");
  if (!el || !isObject(stages)) return;
  clear(el);
  var keys = Object.keys(stages).sort();
  for (var i = 0; i < keys.length; i++) {
    metric(el, traceStageLabel(keys[i]), String(stages[keys[i]]));
  }
}

function renderTraceReasons(items) {
  var el = $("traceReasons");
  if (!el) return;
  clear(el);
  if (!items || !items.length) return;
  var total = {};
  for (var i = 0; i < items.length; i++) {
    var r = items[i].reason || "desconhecido";
    total[r] = (total[r] || 0) + 1;
  }
  var out = element("div", "catalog-pills", "");
  var keys = Object.keys(total).sort();
  for (var j = 0; j < keys.length; j++) {
    var pill = element("span", "catalog-pill", traceReasonLabel(keys[j]) + ": " + total[keys[j]]);
    out.appendChild(pill);
  }
  el.appendChild(out);
}

function traceCell(text, cls) {
  var td = document.createElement("td");
  if (cls) td.className = cls;
  td.textContent = String(text == null ? "—" : text);
  return td;
}

function renderTraceItems(items) {
  var el = $("traceOutput");
  if (!el) return;
  clear(el);
  if (!items || !items.length) return;
  var table = document.createElement("table");
  table.className = "catalog-table";
  var head = document.createElement("tr");
  head.appendChild(traceCell("id", "num"));
  head.appendChild(traceCell("release", "label"));
  head.appendChild(traceCell("BR", "num"));
  head.appendChild(traceCell("dub", "num"));
  head.appendChild(traceCell("qual", "num"));
  head.appendChild(traceCell("motivo", "label"));
  table.appendChild(head);
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var row = document.createElement("tr");
    row.appendChild(traceCell(item.id, "num"));
    row.appendChild(traceCell(item.label, "label"));
    row.appendChild(traceCell(item.br === true ? "sim" : "—", "num"));
    row.appendChild(traceCell(item.dubbed === true ? "sim" : "—", "num"));
    row.appendChild(traceCell(item.quality || "—", "num"));
    row.appendChild(traceCell(traceReasonLabel(item.reason), "label"));
    table.appendChild(row);
  }
  el.appendChild(table);
  if (items.length >= 300) {
    var nota = element("p", "guidance", "Lista truncada no teto de 300 itens do trace.");
    el.appendChild(nota);
  }
}

function traceLiveErrorText(reason, message) {
  if (reason === "ad-hard-blocked") return "AllDebrid não permite checagem ao vivo (a consulta é upload e escreve na conta).";
  if (reason === "rd-live-refused") return "Live no Real-Debrid é recusado por decisão de projeto (oráculo/ledger gravam estado).";
  if (reason === "no-cachecheck") return "Serviço não suporta consulta de cache.";
  if (reason === "no-account") return "Instalação sem conta de debrid: nada a consultar ao vivo.";
  return message || reason || "consulta ao vivo recusada";
}

function renderTraceLive(live) {
  var el = $("traceOutput");
  if (!el) return;
  if (!isObject(live)) return;
  if (!live.allowed) {
    empty(el, traceLiveErrorText(live.reason, null));
    return;
  }
  if (!Array.isArray(live.results) || !live.results.length) {
    empty(el, "Nenhum stream da lista para consultar ao vivo (lista vazia ou sem hashes).");
    return;
  }
  clear(el);
  var out = element("div", "", "");
  var titulo = element("p", "status-line", "Checagem ao vivo no " + String(live.service || "debrid") + ":");
  out.appendChild(titulo);
  for (var i = 0; i < live.results.length; i++) {
    var r = live.results[i];
    var linha = element("p", "status-line", r.id + " · " + (r.name || "—") + " → " + String(r.verdict));
    out.appendChild(linha);
  }
  el.appendChild(out);
}

function runTraceQuery(button) {
  var typeEl = $("traceType");
  var idEl = $("traceId");
  var type = typeEl ? typeEl.value : "";
  var id = idEl ? String(idEl.value || "").trim() : "";
  if (type !== "movie" && type !== "series") {
    setTraceFeedback("Escolha filme ou série.", "warn");
    return;
  }
  if (!/^tt\d+(:\d+(:\d+)?)?$/.test(id)) {
    setTraceFeedback("ID inválido: use tt… opcional com :s:e (ex.: tt111:1:2).", "warn");
    return;
  }
  if (!currentToken) {
    setTraceFeedback("Token de diagnóstico ausente — cole-o acima.", "error");
    var token = $("token");
    if (token) token.focus();
    return;
  }
  var btn = button;
  if (btn) btn.disabled = true;
  clear($("traceOutput"));
  clear($("traceReasons"));
  setTraceFeedback("Consultando…", "warn");
  requestJson("/stream-trace.json?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(id), { method: "GET", cache: "no-store" })
    .then(function (data) {
      setTraceFeedback("", "");
      if (!data || data.found !== true) {
        empty($("traceOutput"), "Obra não está no cache desta instalação.");
        return;
      }
      renderTraceCache(data.cache || {}, type, id);
      var trace = data.trace;
      if (!trace) {
        empty($("traceOutput"), "Sem trace gravado nesta entrada (gravada antes da fase P5 ou STREAM_TRACE desligado).");
        if (isObject(data.recompute)) {
          renderTraceRecompute(data.recompute);
        }
        toggleTraceLive(data);
        return;
      }
      renderTraceStages(trace.stages);
      renderTraceItems(trace.items);
      renderTraceReasons(trace.items);
      if (isObject(data.recompute)) renderTraceRecompute(data.recompute);
      toggleTraceLive(data);
    })
    .catch(function (error) {
      setTraceFeedback(traceErrorLegivel(error), "error");
      clear($("traceCacheMetrics"));
    })
    .then(function () {
      if (btn) btn.disabled = false;
    });
}

function renderTraceRecompute(recompute) {
  var el = $("traceOutput");
  if (!el || !isObject(recompute)) return;
  if (recompute.note) {
    var nota = element("p", "guidance", "Recompute offline: " + String(recompute.note) + ".");
    el.appendChild(nota);
  }
  if (!Array.isArray(recompute.items) || !recompute.items.length) return;
  var table = document.createElement("table");
  table.className = "catalog-table";
  var head = document.createElement("tr");
  head.appendChild(traceCell("id", "num"));
  head.appendChild(traceCell("release", "label"));
  head.appendChild(traceCell("BR", "num"));
  head.appendChild(traceCell("estado atual (now)", "label"));
  table.appendChild(head);
  for (var i = 0; i < recompute.items.length; i++) {
    var item = recompute.items[i];
    var row = document.createElement("tr");
    row.appendChild(traceCell(item.id, "num"));
    row.appendChild(traceCell(item.label, "label"));
    row.appendChild(traceCell(item.br === true ? "sim" : "—", "num"));
    row.appendChild(traceCell((item.now && item.now.state) || "—", "label"));
    table.appendChild(row);
  }
  el.appendChild(table);
  var legenda = element("p", "guidance", "Recompute é foto do estado ATUAL (leituras locais quiet), não a causa do sumiço histórico.");
  el.appendChild(legenda);
}

function toggleTraceLive(data) {
  var btn = $("traceLiveBtn");
  if (!btn) return;
  var permitido = traceLiveAllowed(data);
  btn.style.display = permitido ? "inline-block" : "none";
  if (permitido) btn.setAttribute("title", "Checagem ao vivo (GET de leitura no " + String(data.live.service) + ")");
}

function runTraceLive(button) {
  var typeEl = $("traceType");
  var idEl = $("traceId");
  var type = typeEl ? typeEl.value : "";
  var id = idEl ? String(idEl.value || "").trim() : "";
  var btn = button;
  if (btn) btn.disabled = true;
  clear($("traceOutput"));
  setTraceFeedback("Consultando ao vivo…", "warn");
  requestJson("/stream-trace.json?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(id) + "&mode=live", { method: "GET", cache: "no-store" })
    .then(function (data) {
      setTraceFeedback("", "");
      renderTraceLive(data && data.live);
    })
    .catch(function (error) {
      setTraceFeedback(traceErrorLegivel(error), "error");
    })
    .then(function () {
      if (btn) btn.disabled = false;
    });
}

function traceErrorLegivel(error) {
  var status = error && error.status;
  var reason = error && error.data && error.data.live && error.data.live.reason;
  if (reason) return traceLiveErrorText(reason, error.message);
  if (status === 400) return "Consulta recusada: " + (error.message || "parâmetros inválidos.");
  if (status === 401) return "Token rejeitado: cole novamente o token de diagnóstico correto.";
  if (status === 404) return "Obra não está no cache desta instalação — faça uma busca no Stremio e consulte de novo.";
  if (status === 429) return "Outro diagnóstico está em andamento; tente de novo em instantes.";
  if (status === 503) return "Diagnóstico desligado: defina JACKETT_TEST_TOKEN no .env do operador.";
  return error && error.message ? error.message : "falha na consulta";
}
