/* Adom Power-Movie — /dashboard: sondas pontuais (Fase 0 redesign).
 * Extraído de dashboard-status.js: testes de indexer (/test-indexer.json) e
 * resolver BR (/test-resolver.json) — leitura isolada que não toca breaker nem
 * polling. O polling da Geral continua no status. Escopo global compartilhado
 * (sem IIFE). Depois de status, antes do boot (card() chama os handlers em
 * runtime). ES5 puro (Fire TV / smart TV). */
"use strict";

  function testResultText(data) {
    if (data && data.ok) return "OK · " + valueText(data.results) + " resultado(s) · " + valueText(data.withMagnet) + " com magnet · " + formatDuration(data.ms);
    return "Falhou · " + valueText(data && (data.error || data.message) || "nenhum resultado");
  }

  function runIndexerTest(id, button) {
    var output = $("testOutput");
    var safeId = String(id || "").replace(/^\s+|\s+$/g, "");
    var qInput = $("testIndexerQuery");
    var q = qInput ? String(qInput.value || "").replace(/^\s+|\s+$/g, "") : "";
    var typeInput = $("testIndexerType");
    var type = typeInput ? String(typeInput.value || "movie").replace(/^\s+|\s+$/g, "") : "movie";
    if (!safeId) { output.className = "test-output error"; output.textContent = "Informe o ID do indexador."; return; }
    if (!DashState.token) { output.className = "test-output error"; output.textContent = "Informe o token antes de testar um indexador."; $("token").focus(); return; }
    if (button) button.disabled = true;
    output.className = "test-output";
    output.textContent = "Testando " + safeId + "…";
    var url = "/test-indexer.json?id=" + encodeURIComponent(safeId);
    if (q) url += "&q=" + encodeURIComponent(q);
    if (type) url += "&type=" + encodeURIComponent(type);
    requestJson(url, { method: "GET" })
      .then(function (data) {
        output.className = "test-output " + (data && data.ok ? (data.overBudget ? "warn" : "ok") : "error");
        output.textContent = safeId + " · " + testResultText(data);
      })
      .catch(function (error) { output.className = "test-output error"; output.textContent = safeId + " · " + valueText(error && error.message ? error.message : error); })
      .then(function () { if (button) button.disabled = false; });
  }

  // Texto do teste de resolver BR: ok + N releases + latência + host ativo.
  // O contrato real do backend é `results` (contagem de class="release" no
  // HTML do /search) — NÃO `releases`; ler o campo errado mostrava "—" sempre.
  function resolverTestResultText(data) {
    var releases = data ? data.results : null;
    var count = Array.isArray(releases) ? releases.length : Number(releases);
    if (data && data.ok) {
      return "OK · " + (isFinite(count) ? String(count) : valueText(releases)) + " release(s) · " +
        formatDuration(data.ms) + " · host " + valueText(first(data, ["host", "activeSite", "site"], ""));
    }
    return "Falhou · " + valueText(data && (data.error || data.message) || "nenhum resultado");
  }

  // Espelho de runIndexerTest para os resolvers BR: mesmo gate de token e
  // mesmo feedback no #testOutput. Depois de um teste que mediu, pede o
  // refresh via hook loadStatus (dashboard-status.js, Fase 1 do saneamento) —
  // o card sai de "não medido" sem esperar o próximo polling. Em erro não há
  // medição nova no servidor, então não reconsulta.
  function runResolverTest(id, button) {
    var output = $("testOutput");
    var safeId = String(id || "").replace(/^\s+|\s+$/g, "");
    var qInput = $("testIndexerQuery");
    var q = qInput ? String(qInput.value || "").replace(/^\s+|\s+$/g, "") : "";
    if (!safeId) { output.className = "test-output error"; output.textContent = "Informe o ID do resolver."; return; }
    if (!DashState.token) { output.className = "test-output error"; output.textContent = "Informe o token antes de testar um resolver."; $("token").focus(); return; }
    if (button) button.disabled = true;
    output.className = "test-output";
    output.textContent = "Testando " + safeId + "…";
    var url = "/test-resolver.json?id=" + encodeURIComponent(safeId);
    if (q) url += "&q=" + encodeURIComponent(q);
    requestJson(url, { method: "GET" })
      .then(function (data) {
        output.className = "test-output " + (data && data.ok ? "ok" : "error");
        output.textContent = safeId + " · " + resolverTestResultText(data);
        if (data && data.ok) DashHooks.call("loadStatus");
      })
      .catch(function (error) { output.className = "test-output error"; output.textContent = safeId + " · " + valueText(error && error.message ? error.message : error); })
      .then(function () { if (button) button.disabled = false; });
  }

  // Fase 1 do saneamento — registro declarativo no DashHooks (única execução
  // no load deste módulo): o card() do dashboard-render.js dispara as sondas
  // por DashHooks.call, e o boot segue ligando o botão do formulário direto
  // (referência para-trás, garantida pela ordem de scripts).
  DashHooks.register("runIndexerTest", runIndexerTest);
  DashHooks.register("runResolverTest", runResolverTest);
