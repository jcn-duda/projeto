/* Adom Power-Movie — aba Chupim / Autofetch (Fase 1 painel).
 * Escopo global (sem IIFE). Depois de core/panels/status; boot liga os botões.
 * ES5 puro (Fire TV / smart TV). */
"use strict";

var afKeys = [
  "autoFetchBr", "autoFetchAnyDubbed", "autoFetchTopSeeds", "autoFetchSeedsPtFirst",
  "autoFetchMinSeeders", "autoFetchMax", "autoFetchTopSeedsMax", "autoFetchEnqueueMaxHour",
  "autoFetchQueue", "autoFetchQueueDepth", "autoFetchPauseAt", "autoFetchPauseRefreshMs",
  "autoFetchTtl", "autoFetchRecheckMs", "autoFetchRecheckMax", "autoFetchStallStreak",
  "autoFetchSettleMs", "autoFetchDeadTtl", "autoFetchSeasonFill"
];
var booleanAfKeys = [
  "autoFetchBr", "autoFetchAnyDubbed", "autoFetchTopSeeds", "autoFetchSeedsPtFirst",
  "autoFetchQueue", "autoFetchSeasonFill"
];
var isAfPaused = false;

function setAfFeedback(text, kind) {
  var el = $("afFeedback");
  if (!el) return;
  el.textContent = text || "";
  el.className = "feedback" + (kind ? " " + kind : "");
}

function renderAutofetchPanel(af, uptimeS) {
  if (!af) return;
  var cfg = af.config || {};
  var eff = cfg.effective || {};
  var env = cfg.envDefaults || {};
  var overridden = cfg.overriddenKeys || [];
  var origem = af._origem && typeof af._origem === "object" ? af._origem : null;
  var i, k, input, envSpan, badge;
  // Uptime baixo + _origem.amostra: marca leve no title (sem redesenhar UI).
  var amostraCedo = origem && Number(uptimeS) >= 0 && Number(uptimeS) < 300;

  isAfPaused = Boolean(cfg.paused);

  var stEl = $("afMetricState");
  if (stEl) {
    if (isAfPaused) {
      stEl.textContent = "PAUSADO";
      stEl.style.color = "var(--red)";
    } else {
      stEl.textContent = "ATIVO";
      stEl.style.color = "var(--green)";
    }
  }

  var qEl = $("afMetricQueues");
  if (qEl && af.queues) {
    qEl.textContent = (af.queues.count || 0) + " fila(s) / " + (af.queues.items || 0) + " item(ns)";
  }

  var rEl = $("afMetricRechecks");
  if (rEl) {
    rEl.textContent = (af.recheckLots || 0) + " (" + (af.settleLots || 0) + " settle)";
  }

  // deadBlacklistCount: sem _origem = fail-open (número antigo). naomedido → "—"
  // (0 pós-boot mentiria vazio); amostra → número + title.
  var dEl = $("afMetricDead");
  if (dEl) {
    var deadOrigem = origem ? origem.deadBlacklistCount : null;
    if (deadOrigem === "naomedido") {
      dEl.textContent = "—";
      dEl.title = "Blacklist de mortos ainda não medida neste processo";
    } else {
      dEl.textContent = String(af.deadBlacklistCount || 0);
      if (deadOrigem === "amostra") {
        dEl.title = amostraCedo
          ? "Amostra deste processo (uptime baixo; pode subcontar o L2)"
          : "Amostra deste processo (≠ reindex L2)";
      } else {
        dEl.title = "";
      }
    }
  }

  var bEl = $("afMetricBudget");
  if (bEl && af.budget) {
    var accs = af.budget.accounts || [];
    var extra = "";
    for (var j = 0; j < accs.length; j += 1) {
      extra += (j ? " · " : " ") + accs[j].id + " " + Number(accs[j].used || 0) + "/" + Number(accs[j].limit || 0);
    }
    bEl.textContent = (af.budget.used || 0) + " / " + (af.budget.limit || 0) + extra;
  }

  // Por que o Chupim desistiu: o último registro do trace e a contagem por
  // motivo. Sem isso, um portão que fecha (marker, gate, budget) era um
  // `return` mudo — invisível no painel.
  var guEl = $("afMetricGiveUp");
  if (guEl && af.lastSkips && af.lastSkips.length) {
    var gu = af.lastSkips[0];
    var guTxt = gu.reason;
    if (gu.label) guTxt += " · " + gu.label;
    if (gu.at) guTxt += " · " + formatDate(gu.at);
    guEl.textContent = guTxt;
  }

  var rsEl = $("afMetricReasons");
  if (rsEl) {
    var parts = [];
    var sk = af.skips || {};
    var skKeys = ["account-gate", "budget", "dead", "marker", "already-cached", "in-flight", "search-slot-busy", "paused", "unknown-cache", "stop-has-br", "no-candidate", "no-candidates", "disabled"];
    for (i = 0; i < skKeys.length; i += 1) {
      var n = Number(sk[skKeys[i]] || 0);
      if (n > 0) parts.push(skKeys[i] + " " + n);
    }
    rsEl.textContent = parts.length ? parts.join(" · ") : "—";
  }

  var gateEl = $("afMetricGate");
  if (gateEl && af.accountGate) {
    var gate = af.accountGate;
    if (!gate.pauseAt || gate.pauseAt <= 0) {
      gateEl.textContent = "desligado";
      gateEl.style.color = "";
    } else if (gate.blocked) {
      gateEl.textContent = "BLOQUEADO (pauseAt " + gate.pauseAt + ")";
      gateEl.style.color = "var(--red)";
    } else if (gate.inFlight) {
      gateEl.textContent = "medindo… (pauseAt " + gate.pauseAt + ")";
      gateEl.style.color = "";
    } else {
      gateEl.textContent = "aberto (pauseAt " + gate.pauseAt + ")";
      gateEl.style.color = "";
    }
  }

  var pauseBtn = $("afPauseToggleBtn");
  if (pauseBtn) {
    pauseBtn.textContent = isAfPaused ? "Retomar Chupim" : "Pausar Chupim";
    pauseBtn.className = isAfPaused ? "danger" : "primary";
  }

  var banner = $("afPauseBanner");
  if (banner) {
    if (isAfPaused) {
      banner.className = "pause-banner visible";
      var txt = "Chupim está PAUSADO";
      if (cfg.pausedSince) txt += " desde " + formatDate(cfg.pausedSince);
      txt += ". Nenhum download será enviado ao debrid.";
      $("afPauseBannerText").textContent = txt;
    } else {
      banner.className = "pause-banner";
    }
  }

  for (i = 0; i < afKeys.length; i += 1) {
    k = afKeys[i];
    input = $("af_" + k);
    envSpan = $("env_" + k);
    badge = $("badge_" + k);
    if (input) {
      if (booleanAfKeys.indexOf(k) !== -1) {
        input.checked = Boolean(eff[k]);
      } else {
        input.value = eff[k] !== undefined && eff[k] !== null ? eff[k] : "";
      }
    }
    if (envSpan) {
      envSpan.textContent = env[k] !== undefined && env[k] !== null ? String(env[k]) : "—";
    }
    if (badge) {
      badge.style.display = overridden.indexOf(k) !== -1 ? "inline-block" : "none";
    }
  }
}

function saveAutofetchConfig() {
  var patch = {};
  var i, k, input;
  for (i = 0; i < afKeys.length; i += 1) {
    k = afKeys[i];
    input = $("af_" + k);
    if (input) {
      if (booleanAfKeys.indexOf(k) !== -1) {
        patch[k] = Boolean(input.checked);
      } else {
        var val = Number(input.value);
        if (isFinite(val)) patch[k] = val;
      }
    }
  }
  $("afSaveBtn").disabled = true;
  setAfFeedback("Salvando configurações…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "autofetch-config-set", patch: patch })
  })
    .then(function (data) {
      if (data && data.ok) {
        setAfFeedback("Configurações do Chupim salvas com sucesso!", "ok");
        loadStatus();
      } else {
        var errStr = data && data.errors ? data.errors.join(", ") : "erro desconhecido";
        setAfFeedback("Erro ao salvar: " + errStr, "error");
      }
    })
    .catch(function (err) {
      setAfFeedback("Falha na requisição: " + valueText(err && err.message ? err.message : err), "error");
    })
    .then(function () { $("afSaveBtn").disabled = false; });
}

function resetAutofetchConfig() {
  if (!window.confirm("Restaurar todos os parâmetros do Chupim aos padrões do .env?")) return;
  $("afResetBtn").disabled = true;
  setAfFeedback("Restaurando padrões…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "autofetch-config-reset", confirm: true })
  })
    .then(function (data) {
      if (data && data.ok) {
        setAfFeedback("Padrões do .env restaurados com sucesso!", "ok");
        loadStatus();
      } else {
        setAfFeedback("Erro ao restaurar padrões.", "error");
      }
    })
    .catch(function (err) {
      setAfFeedback("Falha na requisição: " + valueText(err && err.message ? err.message : err), "error");
    })
    .then(function () { $("afResetBtn").disabled = false; });
}

function toggleAutofetchPause(forcedState) {
  var nextState = typeof forcedState === "boolean" ? forcedState : !isAfPaused;
  var msg = nextState
    ? "Deseja pausar o Chupim? Novos downloads não serão enviados ao debrid."
    : "Deseja retomar o Chupim?";
  if (!window.confirm(msg)) return;
  setAfFeedback("Atualizando estado de pausa…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "autofetch-pause", paused: nextState })
  })
    .then(function () {
      setAfFeedback(nextState ? "Chupim pausado com sucesso." : "Chupim retomado com sucesso.", "ok");
      loadStatus();
    })
    .catch(function (err) {
      setAfFeedback("Erro ao alterar pausa: " + valueText(err && err.message ? err.message : err), "error");
    });
}

function drainAutofetchQueues() {
  if (!window.confirm("Deseja realmente esvaziar todas as filas do Chupim?")) return;
  $("afDrainBtn").disabled = true;
  setAfFeedback("Drenando filas…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "autofetch-drain", confirm: true })
  })
    .then(function (data) {
      var q = data && data.queues ? data.queues : 0;
      var it = data && data.items ? data.items : 0;
      setAfFeedback("Filas drenadas: " + q + " fila(s), " + it + " item(ns) removidos.", "ok");
      loadStatus();
    })
    .catch(function (err) {
      setAfFeedback("Erro ao drenar filas: " + valueText(err && err.message ? err.message : err), "error");
    })
    .then(function () { $("afDrainBtn").disabled = false; });
}

function applyAutofetchPreset(preset) {
  if (preset === "conservador") {
    $("af_autoFetchMax").value = 1;
    $("af_autoFetchTopSeedsMax").value = 1;
    $("af_autoFetchQueueDepth").value = 2;
    $("af_autoFetchEnqueueMaxHour").value = 15;
    $("af_autoFetchMinSeeders").value = 2;
    $("af_autoFetchStallStreak").value = 2;
    setAfFeedback("Preset Conservador carregado no formulário. Clique em 'Salvar Alterações' para aplicar.", "warn");
  } else if (preset === "agressivo") {
    $("af_autoFetchMax").value = 3;
    $("af_autoFetchTopSeedsMax").value = 2;
    $("af_autoFetchQueueDepth").value = 6;
    $("af_autoFetchEnqueueMaxHour").value = 40;
    $("af_autoFetchMinSeeders").value = 0;
    $("af_autoFetchStallStreak").value = 3;
    setAfFeedback("Preset Agressivo carregado no formulário. Clique em 'Salvar Alterações' para aplicar.", "warn");
  } else if (preset === "swarm") {
    $("af_autoFetchTopSeeds").checked = true;
    $("af_autoFetchSeedsPtFirst").checked = true;
    $("af_autoFetchTopSeedsMax").value = 3;
    $("af_autoFetchAnyDubbed").checked = true;
    setAfFeedback("Preset Foco em Swarm carregado no formulário. Clique em 'Salvar Alterações' para aplicar.", "warn");
  }
}
