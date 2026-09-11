/* Adom Power-Movie — Cobertura BR (F3) na aba Geral.
 * renderF3Panel: só pinta métricas do payload f3 (brCoverage.status).
 * Escopo global, ES5 puro (Fire TV / smart TV). Sem rede, sem ações. */
"use strict";

function formatF3Rate(value) {
  var n;
  if (value === undefined || value === null || value === "") return "—";
  n = Number(value);
  if (!isFinite(n)) return "—";
  return Math.round(n * 100) + "%";
}

function renderF3Panel(f3, uptimeS) {
  var box = $("f3Metrics");
  var latest;
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
  metric(box, "targetWorks", latest ? latest.targetWorks : "—");
  metric(box, "worksWithBr", latest ? latest.worksWithBr : "—");
  metric(box, "worksCached", latest ? latest.worksCached : "—");
  metricOrigem(box, "popularCoverage", formatF3Rate(f3.popularCoverage), origemOf(f3, "popularCoverage"), uptimeS);
  metricOrigem(box, "discoveryRate", formatF3Rate(f3.discoveryRate), origemOf(f3, "discoveryRate"), uptimeS);
  metricOrigem(box, "brWarmRate", formatF3Rate(f3.brWarmRate), origemOf(f3, "brWarmRate"), uptimeS);
  if (f3.baselineAt) metric(box, "baselineAt", formatDate(f3.baselineAt));
  if (latest && latest.at) metric(box, "latest", formatDate(latest.at));
  else if (!latest) metric(box, "latest", "sem amostra");
  metric(box, "samples", f3.samples);
}
