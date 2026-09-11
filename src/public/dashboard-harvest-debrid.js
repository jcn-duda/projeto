/* Adom Power-Movie — aba Colhedor / Harvester: Conta de debrid do Colhedor.
 * Escopo global (sem IIFE); carregado entre harvest e boot. ES5 puro.
 * Extraído de dashboard-harvest.js para respeitar o teto de 400 linhas. */
"use strict";

// O snapshot do backend NUNCA ecoa a chave crua; set com key vazio restaura
// o .env; sem RESOLVE_SECRET a gravação é recusada (resolve_secret_required).
// O teste da chave reutiliza o debrid-account-test existente. Capacidades
// derivadas do adaptador (deriveCapabilities): quota-warn onde há
// accountStatus; aquecimento RD é EXCLUSIVO do Real-Debrid — AllDebrid serve
// quota-warn mas NÃO aquece o cache RD. O mapa vem do backend
// (capabilitiesByService) para NÃO duplicar a tabela e evitar drift.
var HD_REASON_LABELS = { "resolve_secret_required": "RESOLVE_SECRET ausente no .env", "chave-operador-desativada": "conta de operador desativada no .env", "servico-desconhecido": "serviço desconhecido", "chave-invalida": "chave inválida" };
var HD_CAPS_BY_SERVICE = {};
var harvestDebridSelectSynced = false;

function fillHarvestDebridServices() {
  var select = $("harvestDebridService");
  var i;
  if (!select) return;
  select.textContent = "";
  for (i = 0; i < knownServices.length; i += 1) { var option = document.createElement("option"); option.value = knownServices[i].id; option.textContent = knownServices[i].label; select.appendChild(option); }
}

function harvestDebridCapabilityChip(ok, label) { return element("span", "catalog-tag " + (ok ? "pt" : "none"), label + ": " + (ok ? "sim" : "não")); }

// Prévia das capacidades do serviço ESCOLHIDO, antes de salvar. Deriva do
// mapa do backend; serviço sem registro (ou mapa ainda não carregado) cai no
// seguro "não" — nunca inventa capacidade.
function updateHarvestDebridCaps() {
  var box = $("harvestDebridCaps");
  if (!box) return;
  var caps = HD_CAPS_BY_SERVICE[String($("harvestDebridService").value || "")] || null;
  box.textContent = "";
  if (!caps) { box.appendChild(element("span", "catalog-tag none", "capacidades: aguardando status")); return; }
  box.appendChild(harvestDebridCapabilityChip(caps.quotaWarn === true, "quota-warn"));
  box.appendChild(harvestDebridCapabilityChip(caps.brWarm === true, "aquecimento RD"));
}

function harvestDebridStat(label, value) { var wrap = element("span", "", label + " "); wrap.appendChild(element("b", "", valueText(value))); return wrap; }
function harvestDebridSourceLabel(source) { return source === "panel" ? "painel (override)" : source === "env" ? ".env" : "nenhuma conta"; }
function setHarvestDebridFeedback(text, kind) { var el = $("harvestDebridFeedback"); if (!el) return; el.textContent = text || ""; el.className = "feedback" + (kind ? " " + kind : ""); }
function readHarvestDebridKey() { var input = $("harvestDebridKey"); return input ? String(input.value || "").replace(/^\s+|\s+$/g, "") : ""; }
// A chave sai do input em TODO desfecho: retê-la no DOM depois de testar ou
// salvar não tem valor (mesma regra do teste de conta da Geral).
function clearHarvestDebridKey() { var input = $("harvestDebridKey"); if (input) input.value = ""; }

// requestJson do core só propaga error.message; o 400 do set carrega
// reason/fix. Wrapper local preserva o corpo inteiro, sem tocar o core.
function harvestDebridRequest(action, body) {
  return fetch(basePrefix() + "/dashboard-action.json", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }).then(function (response) {
    return response.json().then(function (data) { return { ok: response.ok && !!data && data.ok !== false, status: response.status, data: data }; });
  });
}

function renderHarvestDebridAccount(account, resolved) {
  var box = $("harvestDebridStatus");
  if (!box) return;
  var a = isObject(account) ? account : {};
  var caps = isObject(a.capabilities) ? a.capabilities : {};
  // Alimenta o mapa de capacidades do backend (evita a tabela duplicada no
  // front); preserva entradas já conhecidas se o snapshot vier sem o mapa.
  var byService = isObject(a.capabilitiesByService) ? a.capabilitiesByService : null;
  var svc, capKey;
  if (byService) {
    for (capKey in byService) {
      if (Object.prototype.hasOwnProperty.call(byService, capKey)) HD_CAPS_BY_SERVICE[capKey] = byService[capKey];
    }
  }
  box.textContent = "";
  box.appendChild(harvestDebridStat("Origem", harvestDebridSourceLabel(a.source)));
  box.appendChild(harvestDebridStat("Serviço", a.service ? debridTestServiceLabel(a.service) : "—"));
  box.appendChild(harvestDebridStat("Chave", a.keySet ? "•••• " + valueText(a.last4) : "não definida"));
  if (a.fingerprint) box.appendChild(harvestDebridStat("Impressão digital", a.fingerprint));
  box.appendChild(harvestDebridStat("Gravada", a.source === "panel" && a.updatedAt ? formatDate(a.updatedAt) : "—"));
  box.appendChild(harvestDebridStat("quota-warn", caps.quotaWarn === true ? "sim" : "não"));
  box.appendChild(harvestDebridStat("aquecimento RD", caps.brWarm === true ? "sim" : "não"));
  box.appendChild(harvestDebridStat("Quota-warn usa", resolved ? debridTestServiceLabel(resolved) : a.source === "env" ? debridTestServiceLabel(a.envService || a.service) : "—"));
  // Selo órfão (RESOLVE_SECRET rotacionado/alterado): a conta do painel está
  // gravada mas a chave não abre, e as features de fundo estão desligadas de
  // propósito. Aviso explícito, não só "chave não definida".
  var warn = $("harvestDebridSealWarn");
  if (warn) {
    if (a.source === "panel" && a.sealBroken) {
      warn.className = "pause-banner visible";
      $("harvestDebridSealWarnText").textContent = "A conta do Colhedor está gravada, mas a chave não abre (RESOLVE_SECRET foi alterado). Quota-warn e aquecimento RD estão DESLIGADOS. Restaure o .env ou salve a chave novamente.";
    } else {
      warn.className = "pause-banner";
    }
  }
  // O select abre no serviço da conta atual UMA vez; depois é escolha do
  // operador — o polling não pode brigar com a seleção em andamento.
  var select = $("harvestDebridService");
  if (select && !harvestDebridSelectSynced && a.service) { select.value = a.service; harvestDebridSelectSynced = true; updateHarvestDebridCaps(); }
}

function harvestDebridGate() {
  if (!currentToken) { setHarvestDebridFeedback("Informe o token de diagnóstico antes de usar a conta do Colhedor.", "error"); if ($("token")) $("token").focus(); return false; }
  if (!$("harvestDebridService").value) { setHarvestDebridFeedback("Escolha o serviço da conta.", "warn"); return false; }
  return true;
}

function testHarvestDebridKey(button) {
  var service = String($("harvestDebridService").value || "");
  var key = readHarvestDebridKey();
  if (!key) { setHarvestDebridFeedback("Cole a chave de API para testar.", "warn"); return; }
  if (!harvestDebridGate()) return;
  if (button) button.disabled = true;
  setHarvestDebridFeedback("Testando chave no " + debridTestServiceLabel(service) + "…", "warn");
  harvestDebridRequest("debrid-account-test", { action: "debrid-account-test", service: service, key: key }).then(function (out) {
    clearHarvestDebridKey();
    var data = out.data || {};
    var output = $("harvestDebridOutput");
    if (output) { output.className = "test-output " + (data.ok ? "ok" : "error"); output.textContent = debridTestServiceLabel(service) + " · " + (data.ok ? "OK · chave aceita pelo serviço" : "Falhou · " + debridTestMotivo(data)); }
    setHarvestDebridFeedback(data.ok ? "Chave aceita pelo serviço." : "Teste sem sucesso: " + debridTestMotivo(data), data.ok ? "ok" : "error");
  }).catch(function (err) { clearHarvestDebridKey(); setHarvestDebridFeedback("Teste não concluído: " + valueText(err && err.message ? err.message : err), "error"); }).then(function () { if (button) button.disabled = false; });
}

function harvestDebridSet(key, button) {
  var service = String($("harvestDebridService").value || "");
  if (!harvestDebridGate()) return;
  if (button) button.disabled = true;
  setHarvestDebridFeedback(key ? "Salvando a conta do Colhedor…" : "Restaurando a conta do .env…", "warn");
  // key vazio é o caminho de RESTAURAR o .env no contrato do backend.
  harvestDebridRequest("harvester-debrid-set", { action: "harvester-debrid-set", service: service, key: key }).then(function (out) {
    clearHarvestDebridKey();
    var data = out.data || {};
    if (!out.ok) { setHarvestDebridFeedback("Conta não salva — " + (HD_REASON_LABELS[data.reason] || valueText(data.reason)) + ". Como corrigir: " + valueText(data.fix), "error"); return; }
    renderHarvestDebridAccount(data.config, null);
    setHarvestDebridFeedback(key ? "Conta de fundo do Colhedor salva: a chave foi cifrada e não volta à tela." : "Conta restaurada do .env; override do painel removido.", "ok");
    loadStatus();
  }).catch(function (err) { clearHarvestDebridKey(); setHarvestDebridFeedback("Ação não concluída: " + valueText(err && err.message ? err.message : err), "error"); }).then(function () { if (button) button.disabled = false; });
}

function saveHarvestDebrid(button) {
  var key = readHarvestDebridKey();
  if (!key) { setHarvestDebridFeedback("Cole a chave de API, ou use Restaurar .env para voltar à conta do .env.", "warn"); return; }
  harvestDebridSet(key, button);
}

function resetHarvestDebrid(button) {
  if (!window.confirm("Restaurar a conta de debrid do Colhedor ao .env? O override salvo no painel será removido.")) return;
  harvestDebridSet("", button);
}
