/* Adom Power-Movie — /dashboard: processo, serviços e contadores de diagnóstico
 * (Fase 3.6 do redesign). Pinta o container próprio #generalDiagnostics sob a
 * seção Geral com o que o /dashboard-status.json JÁ entrega a cada poll e a tela
 * descartava: memória do processo (general.memory), estado dos serviços
 * (general.services, com o Jackett tri-estado) e os contadores de diagnóstico
 * que não têm painel próprio (protectedBrSkipped, fromAliveAsCache,
 * magnetdb.counters.dropped e o Jackett desperdiçado do índice + fundo).
 * Sem rede, sem ações: só leitura do payload. Escopo global (sem IIFE),
 * declaração pura — nada roda no load. Antes do boot. ES5 puro (Fire TV). */
"use strict";

  // Tri-estado do Jackett: true/false/'naomedido' NÃO pode virar "não" nem
  // "sim" por coerção; cada estado tem rótulo próprio (mesma convenção do
  // estado vazio e do banner de saúde).
  function generalServiceStateFlag(value) {
    if (value === true) return "online";
    if (value === false) return "offline";
    if (value === "naomedido") return "não medido";
    return valueText(value);
  }

  // Contador de eventos (desde o restart) que não tem casa em outro painel.
  // Zero é informação: diferente de uma medição ausente, "nunca aconteceu"
  // vale para a janela do processo.
  function generalCounter(counters, key) {
    return Number(isObject(counters) ? counters[key] || 0 : 0);
  }

  function renderGeneralDiagnostics(root) {
    var box = $("generalDiagnostics");
    var general = isObject(root) && isObject(root.general) ? root.general : null;
    var memory;
    var services;
    var counters;
    var magnetdb;
    var dbCounters;
    var idx;
    if (!box) return;
    box.textContent = "";
    if (!general) { empty(box, "Sem dados de processo."); return; }
    memory = isObject(general.memory) ? general.memory : {};
    services = isObject(general.services) ? general.services : {};
    counters = isObject(root.metrics) && isObject(root.metrics.counters) ? root.metrics.counters : {};
    magnetdb = isObject(root.magnetdb) ? root.magnetdb : {};
    dbCounters = isObject(magnetdb.counters) ? magnetdb.counters : {};
    idx = first(root, ["releaseIndex", "index", "idx"], {});

    // 1. Memória do processo — bytes crus do process.memoryUsage().
    metricGroupTitle(box, "Memória do processo");
    metric(box, "RSS", formatBytes(memory.rss || 0));
    metric(box, "Heap usado", formatBytes(memory.heapUsed || 0));
    metric(box, "Heap total", formatBytes(memory.heapTotal || 0));

    // 2. Serviços — prova local de cada dependência. `resolvers` é a contagem
    // dos resolvers embutidos vivos (0 é estado válido, não "não medido").
    metricGroupTitle(box, "Serviços");
    metric(box, "addon", generalServiceStateFlag(services.addon));
    metric(box, "jackett", generalServiceStateFlag(services.jackett));
    metric(box, "debrid", generalServiceStateFlag(services.debrid));
    metric(box, "resolvers embutidos", services.resolvers);

    // 3. Contadores de diagnóstico sem painel próprio. Os dois primeiros são
    // do debrid e vivem em metrics.counters; dropped é o total do MagnetDB
    // (além dos lados bad/dead/lie já mostrados no painel do banco).
    metricGroupTitle(box, "Contadores de diagnóstico (desde o restart)");
    metric(box, "debrid.cleanup.protectedBrSkipped", generalCounter(counters, "debrid.cleanup.protectedBrSkipped"));
    metric(box, "debrid.instant.fromAliveAsCache", generalCounter(counters, "debrid.instant.fromAliveAsCache"));
    metric(box, "magnetdb.counters.dropped", Number(isObject(dbCounters) ? dbCounters.dropped || 0 : 0));

    // 4. Jackett desperdiçado — separado de propósito em resposta (caminho
    // crítico do usuário) e fundo (colhedor/enriquecimento), que são baldes
    // distintos e não devem ser somados como um só custo.
    metricGroupTitle(box, "Jackett desperdiçado");
    metric(box, "wastedQueries (resposta)", Number(idx.wastedQueries || 0));
    metric(box, "wastedMs (resposta)", formatDuration(Number(idx.wastedMs || 0)));
    metric(box, "wastedQueries.background", Number(idx.wastedQueriesBackground || 0));
    metric(box, "wastedMs.background", formatDuration(Number(idx.wastedMsBackground || 0)));
  }
