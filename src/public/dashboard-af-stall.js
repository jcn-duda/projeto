/* Adom Power-Movie — /dashboard: diagnóstico de stall do Chupim (Fase 3.5 do
 * redesign). O /dashboard-status.json já entrega, a cada poll, os lotes de
 * recheck (autofetch.lots), os locks pendentes, os slots de busca ocupados, as
 * chaves de temporada e as buscas em voo — nenhum deles aparecia na tela, então
 * um Chupim travado (lote em voo eterno, slot entupido) era invisível.
 * Pinta o container próprio #afStallMetrics; skips/lastSkips também ganham
 * lista curta aqui (o último motivo já vai em #afMetricGiveUp). Escopo global
 * (sem IIFE), declaração pura — nada roda no load. ES5 puro (Fire TV). */
"use strict";

  function afSkipsTotal(skips) {
    var total = 0;
    var keys;
    var i;
    if (!isObject(skips)) return 0;
    keys = Object.keys(skips);
    for (i = 0; i < keys.length; i += 1) total += Number(skips[keys[i]] || 0);
    return total;
  }

  // Uma linha por lote: o que o recheck está segurando e há quanto tempo. O id
  // é o sha256(searchKey) truncado — nunca a chave de busca crua.
  function afLotsTable(lots) {
    var table = element("table", "timer-table");
    var head = element("thead");
    var headRow = element("tr");
    var body = element("tbody");
    var headers = ["lote", "hashes", "tentativas", "idade", "recusas", "estado"];
    var i;
    var row;
    var state;
    for (i = 0; i < headers.length; i += 1) headRow.appendChild(element("th", "", headers[i]));
    head.appendChild(headRow);
    table.appendChild(head);
    for (i = 0; i < lots.length; i += 1) {
      state = lots[i].isSettle ? "settle" : "recheck";
      if (lots[i].inFlight) state += " · em voo";
      row = element("tr");
      row.appendChild(element("td", "timer-name", valueText(lots[i].id)));
      row.appendChild(element("td", "num", valueText(lots[i].hashes)));
      row.appendChild(element("td", "num", valueText(lots[i].attempts)));
      row.appendChild(element("td", "num", formatDuration(lots[i].ageMs)));
      row.appendChild(element("td", "num", valueText(lots[i].refusals)));
      row.appendChild(element("td", "", state));
      body.appendChild(row);
    }
    table.appendChild(body);
    return table;
  }

  function afSkipLine(entry) {
    var text = valueText(entry.reason);
    if (entry.pool) text += " · pool " + valueText(entry.pool);
    if (entry.adapter) text += " · " + valueText(entry.adapter);
    if (entry.label) text += " · " + valueText(entry.label);
    if (entry.at) text += " · " + formatDate(entry.at);
    return text;
  }

  // Snapshot completo do estado de stall. `af` é o bloco autofetch inteiro:
  // pendingLocks/searchSlots/seasonSearchKeys/searchesInFlight vêm do snapshot
  // do runner + autofetchStatus (providers/index.ts).
  function renderAutofetchStall(af, uptimeS) {
    var box = $("afStallMetrics");
    var slots;
    var lots;
    var last;
    var i;
    if (!box) return;
    box.textContent = "";
    if (!isObject(af)) { empty(box, "Sem dados de stall do Chupim."); return; }
    slots = isObject(af.searchSlots) ? af.searchSlots : {};
    lots = asList(af.lots, "lots");
    last = asList(af.lastSkips, "lastSkips");

    metricGroupTitle(box, "Stall: locks, slots e buscas");
    metric(box, "pendingLocks", Number(af.pendingLocks || 0));
    metric(box, "searchSlots (buscas)", Number(slots.searches || 0));
    metric(box, "searchSlots (ocupados)", Number(slots.occupied || 0));
    metric(box, "seasonSearchKeys", Number(af.seasonSearchKeys || 0));
    metric(box, "searchesInFlight", Number(af.searchesInFlight || 0));
    metric(box, "lotes recheck", lots.length);
    metric(box, "desistências registradas", afSkipsTotal(af.skips));

    if (lots.length) {
      metricGroupTitle(box, "Lotes em recheck/settle");
      box.appendChild(afLotsTable(lots));
    }

    metricGroupTitle(box, "Últimas desistências");
    if (!last.length) {
      box.appendChild(element("p", "guidance", "Nenhuma desistência registrada desde o boot."));
      return;
    }
    // Teto curto: o painel já mostra a contagem por motivo e o último registro;
    // aqui basta o rastro recente para correlacionar com um lote parado.
    for (i = 0; i < last.length && i < 5; i += 1) {
      box.appendChild(element("p", "guidance", afSkipLine(last[i])));
    }
  }
