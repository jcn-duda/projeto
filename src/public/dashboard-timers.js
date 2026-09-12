/* Adom Power-Movie — /dashboard: latências e percentis (Fase 3.1 do redesign).
 * Tabela a partir de metrics.timers (count/avgMs/p50Ms/p95Ms/maxMs): uma linha
 * por indexer.<id> e pelos timers search.* relevantes. É o quadro "quem está
 * puxando o prazo", que o back-end já entrega em cada poll e a tela descartava.
 * Escopo global (sem IIFE), declaração pura: nada roda no load. Antes do boot.
 * ES5 puro (Fire TV / smart TV). */
"use strict";

  var TIMER_HEADERS = ["timer", "n", "média", "p50", "p95", "máx"];

  // Filtro de relevância: índice por indexador e a família search.* do caminho
  // da resposta. O resto (debrid.*, cache.*, autofetch.*) tem painel próprio.
  function timerSelected(name) {
    return name.indexOf("indexer.") === 0 || name.indexOf("search.") === 0;
  }

  function timerRow(name, timing) {
    var t = isObject(timing) ? timing : {};
    return {
      name: name,
      count: t.count,
      avg: t.avgMs,
      p50: t.p50Ms,
      p95: t.p95Ms,
      max: t.maxMs
    };
  }

  function timerMs(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return formatDuration(n);
  }

  function timerCount(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return String(n);
  }

  // indexer.* primeiro (onde mora a latência de rede), search.* depois — cada
  // bloco em ordem alfabética para a leitura não depender da ordem de escrita.
  function timerRows(timers) {
    var indexers = [];
    var search = [];
    var keys;
    var i;
    var name;
    if (!isObject(timers)) return indexers;
    keys = Object.keys(timers).sort();
    for (i = 0; i < keys.length; i += 1) {
      name = keys[i];
      if (!timerSelected(name)) continue;
      if (name.indexOf("indexer.") === 0) indexers.push(timerRow(name, timers[name]));
      else search.push(timerRow(name, timers[name]));
    }
    return indexers.concat(search);
  }

  function timerTable(rows) {
    var table = element("table", "timer-table");
    var head = element("thead");
    var headRow = element("tr");
    var body = element("tbody");
    var i;
    var row;
    for (i = 0; i < TIMER_HEADERS.length; i += 1) headRow.appendChild(element("th", "", TIMER_HEADERS[i]));
    head.appendChild(headRow);
    table.appendChild(head);
    for (i = 0; i < rows.length; i += 1) {
      row = element("tr");
      row.appendChild(element("td", "timer-name", rows[i].name));
      row.appendChild(element("td", "num", timerCount(rows[i].count)));
      row.appendChild(element("td", "num", timerMs(rows[i].avg)));
      row.appendChild(element("td", "num", timerMs(rows[i].p50)));
      row.appendChild(element("td", "num", timerMs(rows[i].p95)));
      row.appendChild(element("td", "num", timerMs(rows[i].max)));
      body.appendChild(row);
    }
    table.appendChild(body);
    return table;
  }

  // Painel do bloco `metrics.timers`. Container próprio (#timerMetrics) sob a
  // seção Geral; recebe o root inteiro porque o payload de timers mora em
  // metrics, não numa seção `general`.
  function renderTimersPanel(root) {
    var box = $("timerMetrics");
    var metrics = isObject(root) && isObject(root.metrics) ? root.metrics : {};
    var rows;
    if (!box) return;
    rows = timerRows(metrics.timers);
    box.textContent = "";
    if (!rows.length) {
      empty(box, "Sem medições de latência ainda.");
      return;
    }
    box.appendChild(element("p", "metric-group", "Latência por indexador e busca"));
    box.appendChild(timerTable(rows));
  }

  // Fase 1 do saneamento — registro declarativo no DashHooks (única execução
  // no load deste módulo): o renderGeralPanels (dashboard-status.js) consome o
  // painel por DashHooks.call, sem citar o símbolo global deste arquivo.
  DashHooks.register("renderTimersPanel", renderTimersPanel);
