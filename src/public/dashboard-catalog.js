/* Adom Power-Movie — seção Conta / Catálogo (Fase 1 painel).
 * Escopo global (sem IIFE). Depois de harvest; boot liga os botões.
 * ES5 puro (Fire TV / smart TV). */
"use strict";

// --- Conta / Catálogo ------------------------------------------------
var CATALOG_BUCKETS = ["dub", "dual", "pt", "lixo"];

function setCatalogFeedback(text, kind) {
  var node = $("catalog_feedback");
  node.className = "feedback" + (kind ? " " + kind : "");
  node.textContent = text || "";
}

function catalogMax() {
  var raw = $("catalog_max").value;
  var number = Number(raw);
  if (!raw || !isFinite(number) || number <= 0) return undefined;
  return Math.floor(number);
}

function bucketLabel(bucket) {
  if (bucket === "dub") return "Dublado";
  if (bucket === "dual") return "Dual";
  if (bucket === "pt") return "Português";
  if (bucket === "lixo") return "Lixo / indefinido";
  return titleText(bucket);
}

function bucketError(data) {
  var motivo = valueText(data && (data.reason || data.error || data.message) || "indisponível");
  // O hint do backend traz o conserto (ex.: chave do operador desativada no
  // .env). valueText/createTextNode escapam — nada de innerHTML aqui.
  if (data && data.hint) motivo += " — " + valueText(data.hint);
  return motivo;
}

function buildBucketTable(report) {
  var table = document.createElement("table");
  var head = document.createElement("thead");
  var body = document.createElement("tbody");
  var hr = document.createElement("tr");
  var i;
  var headCells = ["Balde", "Magnets", "Bytes"];
  for (i = 0; i < headCells.length; i += 1) {
    var th = document.createElement("th");
    th.textContent = headCells[i];
    if (i > 0) th.className = "num";
    hr.appendChild(th);
  }
  head.appendChild(hr);
  table.className = "catalog-table";
  table.appendChild(head);
  var buckets = report.byBucket || {};
  for (i = 0; i < CATALOG_BUCKETS.length; i += 1) {
    var bucket = CATALOG_BUCKETS[i];
    var meta = buckets[bucket] || { count: 0, bytes: 0 };
    var tr = document.createElement("tr");
    var tdName = document.createElement("td");
    tdName.className = "label";
    tdName.textContent = bucketLabel(bucket);
    var tdCount = document.createElement("td");
    tdCount.className = "num";
    tdCount.textContent = String(meta.count);
    var tdBytes = document.createElement("td");
    tdBytes.className = "num";
    tdBytes.textContent = formatBytes(meta.bytes);
    tr.appendChild(tdName); tr.appendChild(tdCount); tr.appendChild(tdBytes);
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

/** "Rótulo <b>valor</b>" do resumo. Sem innerHTML: o valor vem da rede. */
function catalogStat(label, value) {
  var wrap = document.createElement("span");
  wrap.appendChild(document.createTextNode(label + " "));
  var forte = document.createElement("b");
  forte.textContent = valueText(value);
  wrap.appendChild(forte);
  return wrap;
}

function cachedPills(report) {
  var keys = ["hit", "miss", "blocked", "unknown"];
  // `byCached` some quando a resposta não é um relatório (audit-backfill,
  // dedup-apply e cleanup-apply devolvem contadores próprios). Sem o default
  // o acesso `undefined["hit"]` estourava DENTRO do .then() e o .catch() do
  // catalogAction reportava "Ação não concluída" para uma ação que rodou.
  var cached = report.byCached || {};
  var wrap = document.createElement("div");
  var i;
  for (i = 0; i < keys.length; i += 1) {
    wrap.appendChild(element("span", "catalog-pill", "⚡ " + keys[i] + ": " + valueText(cached[keys[i]])));
  }
  return wrap;
}

function renderCatalogReport(data) {
  var out = $("catalog_report");
  clear(out);
  if (!data || !data.ok) { empty(out, bucketError(data)); return; }
  var report = data.report || {};
  var resumo = element("div", "catalog-summary", "");
  resumo.appendChild(catalogStat("Magnets", report.magnets));
  resumo.appendChild(catalogStat("Prontos", report.ready));
  resumo.appendChild(catalogStat("Obras conhecidas", report.works && report.works.known));
  resumo.appendChild(catalogStat("Desconhecidas", report.works && report.works.unknown));
  out.appendChild(resumo);
  out.appendChild(cachedPills(report));
  out.appendChild(buildBucketTable(report));
  out.appendChild(element("p", "catalog-totals", "Totais: " + valueText(report.totals && report.totals.count) + " magnets · " + formatBytes(report.totals && report.totals.bytes)));
}

function countKills(plan) {
  var total = 0;
  var i;
  for (i = 0; i < plan.t1.length; i += 1) total += plan.t1[i].kill.length;
  for (i = 0; i < plan.t2.length; i += 1) total += plan.t2[i].kill.length;
  return total;
}

function dedupKills(plan) {
  var out = [];
  var i, j;
  for (i = 0; i < plan.t1.length; i += 1) {
    for (j = 0; j < plan.t1[i].kill.length; j += 1) out.push(plan.t1[i].kill[j]);
  }
  for (i = 0; i < plan.t2.length; i += 1) {
    for (j = 0; j < plan.t2[i].kill.length; j += 1) out.push(plan.t2[i].kill[j]);
  }
  return out;
}

function renderCatalogDedup(data) {
  var out = $("catalog_dedup_preview");
  clear(out);
  if (!data || !data.ok) { empty(out, bucketError(data)); return; }
  if (data.plan) {
    out.appendChild(element("div", "catalog-summary", "Grupos T1 (mesmo hash): " + valueText(data.plan.t1.length) + " · Grupos T2 (mesmo arquivo): " + valueText(data.plan.t2.length) + " · Alvos: " + valueText(countKills(data.plan))));
    renderCatalogRows(dedupKills(data.plan));
  } else if (data.targets) {
    out.appendChild(element("div", "catalog-summary", "Alvos da limpeza: " + valueText(data.targets.length)));
    var skipped = data.skipped || {};
    out.appendChild(element("p", "catalog-skips", "Pulados — protegidos: " + valueText(skipped.protected) + " · ativos: " + valueText(skipped.active) + " · jovens: " + valueText(skipped.young) + " · não condenados: " + valueText(skipped.notCondemned) + " · preexistentes: " + valueText(skipped.known)));
    renderCatalogRows(data.targets);
  } else {
    out.appendChild(element("div", "", "Ação concluída."));
  }
}

function renderCatalogRows(rows) {
  var out = $("catalog_targets");
  clear(out);
  if (!rows.length) { empty(out, "Sem alvos."); return; }
  var top = rows.slice(0, 10);
  var i;
  for (i = 0; i < top.length; i += 1) {
    var target = top[i] || {};
    var row = document.createElement("div");
    row.className = "catalog-target-row";
    row.appendChild(element("span", "hash", String(target.hash || "?").slice(0, 8)));
    row.appendChild(element("span", "size", formatBytes(target.size)));
    row.appendChild(element("span", "catalog-tag " + (target.reason === "manual" ? "none" : "foreign"), target.ready ? "pronto" : "—"));
    var nome = element("span", "name", titleText(target.filename || ""));
    if (target.known) nome.appendChild(element("span", "catalog-flag", "(preexistente)"));
    nome.title = String(target.filename || "");
    row.appendChild(nome);
    out.appendChild(row);
  }
}

/**
 * Lista para escolha manual: uma linha por magnet, com checkbox. O
 * `data-id` carrega o service_id, que é o que a ação manual-delete envia —
 * o filename é só rótulo e nunca identifica a linha.
 */
function renderCatalogManual(data) {
  var out = $("catalog_manual");
  clear(out);
  // Já sem checkboxes no DOM: zera o resumo antes de qualquer saída curta.
  refreshCatalogSelection();
  if (!data || !data.ok) { empty(out, bucketError(data)); return; }
  var rows = data.rows || [];
  if (!rows.length) { empty(out, "Nenhuma linha neste balde."); return; }
  var i;
  for (i = 0; i < rows.length; i += 1) {
    var r = rows[i] || {};
    var line = document.createElement("label");
    line.className = "catalog-target-row";
    var box = document.createElement("input");
    box.type = "checkbox";
    box.className = "catalog-pick";
    box.setAttribute("data-id", String(r.serviceId));
    box.setAttribute("data-size", String(r.size || 0));
    // Download em curso o servidor pula de qualquer jeito; desabilitar aqui
    // evita o operador achar que selecionou algo que vai sair.
    if (r.active) { box.disabled = true; }
    line.appendChild(box);
    line.appendChild(element("span", "size", formatBytes(r.size)));
    line.appendChild(catalogTag(r));
    var nome = element("span", "name", titleText(r.filename || ""));
    if (r.active) nome.appendChild(element("span", "catalog-flag", "(baixando)"));
    if (r.protected) nome.appendChild(element("span", "catalog-flag", "(protegido)"));
    nome.title = String(r.filename || "");
    line.appendChild(nome);
    out.appendChild(line);
  }
  // Lista nova zera o resumo: os checkboxes antigos saíram do DOM.
  refreshCatalogSelection();
}

/**
 * Badge do veredito. Vermelho só quando há prova de estrangeiro, verde só
 * quando há prova PT — a mesma assimetria do foreignVerdict no servidor.
 * "sem prova" é cinza de propósito: é ignorância, não permissão.
 */
function catalogTag(r) {
  if (r.foreignProof) return element("span", "catalog-tag foreign", "estrangeiro");
  if (r.ptProof) return element("span", "catalog-tag pt", "PT");
  return element("span", "catalog-tag none", valueText(r.bucket));
}

function catalogBoxes() {
  return document.querySelectorAll("#catalog_manual .catalog-pick");
}

function catalogPicked() {
  var nodes = catalogBoxes();
  var ids = [];
  var i;
  for (i = 0; i < nodes.length; i += 1) {
    if (nodes[i].checked) ids.push(nodes[i].getAttribute("data-id"));
  }
  return ids;
}

/**
 * Resumo da seleção. Mostra o TAMANHO junto porque a ação seguinte é
 * irreversível: "12 selecionados" não diz se são 2 GB ou 2 TB.
 */
function refreshCatalogSelection() {
  var nodes = catalogBoxes();
  var alvo = $("catalog_selection");
  var marcados = 0;
  var bytes = 0;
  var elegiveis = 0;
  var i;
  for (i = 0; i < nodes.length; i += 1) {
    if (nodes[i].disabled) continue;
    elegiveis += 1;
    if (nodes[i].checked) {
      marcados += 1;
      bytes += Number(nodes[i].getAttribute("data-size")) || 0;
    }
  }
  if (alvo) {
    alvo.textContent = marcados
      ? marcados + " de " + elegiveis + " selecionados · " + formatBytes(bytes)
      : "nada selecionado";
  }
  var botao = $("catalogSelectAllBtn");
  if (botao) botao.textContent = (elegiveis > 0 && marcados === elegiveis) ? "Limpar seleção" : "Selecionar todos";
}

/** Marca tudo que dá para apagar; se já está tudo marcado, limpa. */
function toggleCatalogSelectAll() {
  var nodes = catalogBoxes();
  var elegiveis = 0;
  var marcados = 0;
  var i;
  for (i = 0; i < nodes.length; i += 1) {
    if (nodes[i].disabled) continue;
    elegiveis += 1;
    if (nodes[i].checked) marcados += 1;
  }
  // Download em curso fica de fora: o checkbox está desabilitado e o servidor
  // o pularia de qualquer forma.
  var ligar = marcados < elegiveis;
  for (i = 0; i < nodes.length; i += 1) {
    if (!nodes[i].disabled) nodes[i].checked = ligar;
  }
  refreshCatalogSelection();
}

function catalogIncludeKnown() {
  var el = document.getElementById("catalog_include_known");
  return !!el && !!el.checked;
}

function catalogAction(action, extra, callback) {
  var payload = { action: action, confirm: true, includeKnown: catalogIncludeKnown() };
  if (extra && extra.max !== undefined) payload.max = extra.max;
  if (extra && extra.bucket !== undefined) payload.bucket = extra.bucket;
  if (extra && extra.serviceIds !== undefined) payload.serviceIds = extra.serviceIds;
  setCatalogFeedback("Executando " + action + "…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
    .then(function (data) {
      // `ok:false` é indisponibilidade (ex.: conta do operador desligada no
      // .env), devolvida como 200: feedback de ERRO com o motivo — o verde
      // "concluída" escondia a falha do operador.
      if (data && !data.ok) {
        setCatalogFeedback("Ação " + action + " indisponível: " + bucketError(data), "error");
      } else {
        setCatalogFeedback("Ação " + action + " concluída.", "ok");
      }
      // O render fica ISOLADO do resultado da ação: uma falha ao desenhar não
      // pode ser reportada como "ação não concluída" quando o servidor já
      // executou (a auditoria chega a gravar evidência antes de a tela quebrar).
      if (callback) {
        try {
          callback(data);
        } catch (renderError) {
          setCatalogFeedback("Ação " + action + " concluída, mas a tela falhou: " + valueText(renderError && renderError.message ? renderError.message : renderError), "warn");
        }
      }
      loadStatus();
    })
    .catch(function (error) { setCatalogFeedback("Ação não concluída: " + valueText(error && error.message ? error.message : error), "error"); });
}

/**
 * Resultado das ações que MUTAM (auditoria e os dois apply): elas devolvem
 * contadores próprios, nunca um relatório. Mostra o que a ação fez e recarrega
 * o relatório do servidor, que é quem sabe o estado novo do catálogo.
 */
function renderCatalogOutcome(data) {
  if (!data || !data.ok) { empty($("catalog_report"), bucketError(data)); return; }
  var partes = [];
  if (data.missing !== undefined) partes.push("ignorados: " + valueText(data.missing));
  if (data.active !== undefined) partes.push("baixando (pulados): " + valueText(data.active));
  if (data.requeued !== undefined) partes.push("reenfileirados: " + valueText(data.requeued));
  if (data.keptWithEvidence !== undefined) partes.push("com evidência viva: " + valueText(data.keptWithEvidence));
  if (data.scanned !== undefined) partes.push("auditados: " + valueText(data.scanned));
  if (data.evidenced !== undefined) partes.push("com evidência: " + valueText(data.evidenced));
  if (data.total !== undefined) partes.push("alvos: " + valueText(data.total));
  if (data.deleted !== undefined) partes.push("apagados: " + valueText(data.deleted));
  if (data.failed !== undefined) partes.push("falhas: " + valueText(data.failed));
  if (data.falhas !== undefined) partes.push("falhas: " + valueText(data.falhas));
  setCatalogFeedback(partes.length ? partes.join(" · ") : "Ação concluída.", "ok");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "catalog-report", confirm: true, includeKnown: catalogIncludeKnown() })
  })
    .then(function (relatorio) { renderCatalogReport(relatorio); })
    .catch(function () { /* o resumo acima já informou; relatório recarrega no próximo clique */ });
}

function runCatalogScan() { catalogAction("catalog-scan", {}, renderCatalogReport); }
function runCatalogReport() { catalogAction("catalog-report", {}, renderCatalogReport); }
function runCatalogAudit() { catalogAction("audit-backfill", { max: catalogMax() }, renderCatalogOutcome); }
function runCatalogRequeue() { catalogAction("audit-requeue", { max: catalogMax() }, renderCatalogOutcome); }
function runCatalogList() {
  var sel = document.getElementById("catalog_bucket");
  catalogAction("catalog-list", { bucket: sel ? sel.value : "", max: catalogMax() }, renderCatalogManual);
}
function runCatalogManualDelete() {
  var ids = catalogPicked();
  if (!ids.length) { setCatalogFeedback("Selecione ao menos um magnet.", "warn"); return; }
  if (!window.confirm("Apagar " + ids.length + " magnet(s) da conta? A ação é irreversível.")) return;
  catalogAction("manual-delete", { serviceIds: ids }, function (data) {
    renderCatalogOutcome(data);
    runCatalogList();
  });
}
function runCatalogDedupPreview() { catalogAction("dedup-preview", {}, renderCatalogDedup); }
function runCatalogDedupApply() {
  if (!window.confirm("Confirmar a deduplicação (apagar os duplicados do catálogo)?")) return;
  catalogAction("dedup-apply", { max: catalogMax() }, renderCatalogOutcome);
}
function runCatalogCleanupPreview() { catalogAction("cleanup-preview", {}, renderCatalogDedup); }
function runCatalogCleanupApply() {
  if (!window.confirm("Confirmar a limpeza BR (apagar o estrangeiro provado do catálogo)?")) return;
  catalogAction("cleanup-apply", { max: catalogMax() }, renderCatalogOutcome);
}
