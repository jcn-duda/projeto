/* Adom Power-Movie — /dashboard: cobertura BR (F3) na aba Geral.
 * renderF3Panel pinta os gauges f3.br.popular.* (metrics.gauges) e o f3.latest
 * completo — alvo, descoberta, miss/unknown, releases e os cortes movie/series.
 * O back-end já entrega tudo em cada poll (Fase 3.2 do redesign); a tela
 * descartava os gauges. Escopo global, ES5 puro. Sem rede, sem ações. */
"use strict";

  function formatF3Rate(value) {
    var n;
    if (value === undefined || value === null || value === "") return "—";
    n = Number(value);
    if (!isFinite(n)) return "—";
    return Math.round(n * 100) + "%";
  }

  var F3_GAUGE_PREFIX = "f3.br.popular.";

  function f3Gauge(gauges, name) {
    return isObject(gauges) ? gauges[F3_GAUGE_PREFIX + name] : undefined;
  }

  // Prefere o gauge corrente (nível vivo do sampler) e cai no último sample
  // quando a fase está desligada ou os gauges foram limpos com a coorte.
  function f3Number(gauges, latest, gaugeName, latestField) {
    var value = f3Gauge(gauges, gaugeName);
    if (value === undefined && latest) value = latest[latestField];
    if (value === undefined || value === null) return "—";
    return valueText(value);
  }

  // Cada tipo (movie/series) carrega os mesmos contadores num sub-objeto que o
  // renderMetrics genérico descarta por ser objeto; aqui vira linha legível.
  function f3TypeLine(box, label, counts) {
    var c = isObject(counts) ? counts : {};
    metric(box, label + " em cache / indexadas", valueText(c.cached) + "/" + valueText(c.indexed));
    metric(box, label + " com BR / miss / unknown", valueText(c.withBr) + "/" + valueText(c.knownMiss) + "/" + valueText(c.unknown));
  }

  function renderF3Panel(f3, uptimeS, gauges) {
    var box = $("f3Metrics");
    var latest;
    var counters;
    if (!box) return;
    box.textContent = "";
    if (!f3 || !isObject(f3)) {
      empty(box, "sem amostra");
      return;
    }
    if (!f3.enabled) {
      empty(box, "F3 desligado (F3_ENABLED / F3_BR_ENABLED).");
      return;
    }
    latest = isObject(f3.latest) ? f3.latest : null;
    counters = isObject(f3.counters) ? f3.counters : {};
    metric(box, "targetWorks", f3Number(gauges, latest, "target", "targetWorks"));
    metric(box, "indexedWorks", f3Number(gauges, latest, "indexed", "indexedWorks"));
    metric(box, "worksWithBr", f3Number(gauges, latest, "withBr", "worksWithBr"));
    metric(box, "worksCached", f3Number(gauges, latest, "cached", "worksCached"));
    metric(box, "worksKnownMiss", f3Number(gauges, latest, "knownMiss", "worksKnownMiss"));
    metric(box, "worksUnknown", f3Number(gauges, latest, "unknown", "worksUnknown"));
    metric(box, "releasesWithBr", f3Number(gauges, latest, "releasesWithBr", "releasesWithBr"));
    metric(box, "releasesCached", f3Number(gauges, latest, "releasesCached", "releasesCached"));
    metricOrigem(box, "popularCoverage", formatF3Rate(f3.popularCoverage), origemOf(f3, "popularCoverage"), uptimeS);
    metricOrigem(box, "discoveryRate", formatF3Rate(f3.discoveryRate), origemOf(f3, "discoveryRate"), uptimeS);
    metricOrigem(box, "brWarmRate", formatF3Rate(f3.brWarmRate), origemOf(f3, "brWarmRate"), uptimeS);
    f3TypeLine(box, "movie", latest ? latest.movie : null);
    f3TypeLine(box, "series", latest ? latest.series : null);
    metric(box, "samples", counters.sample != null ? counters.sample : f3.samples);
    if (f3.baselineAt) metric(box, "baselineAt", formatDate(f3.baselineAt));
    if (latest && latest.cohortAt) metric(box, "cohortAt", formatDate(latest.cohortAt));
    if (latest && latest.at) metric(box, "latest", formatDate(latest.at));
    else if (!latest) metric(box, "latest", "sem amostra");
  }

  // Fase 1 do saneamento — registro declarativo no DashHooks (única execução
  // no load deste módulo): o renderGeralPanels (dashboard-status.js) consome o
  // painel por DashHooks.call, sem citar o símbolo global deste arquivo.
  DashHooks.register("renderF3Panel", renderF3Panel);
