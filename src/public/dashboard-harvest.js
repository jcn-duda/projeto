/* Adom Power-Movie — aba Colhedor / Harvester (Fase 1 painel).
 * Escopo global (sem IIFE). Depois de autofetch; boot liga os botões.
 * ES5 puro (Fire TV / smart TV). */
"use strict";

var harvestKeys = [
  "harvestEnabled", "harvestMaxPerHour", "harvestIdleWindowMs", "harvestIntervalMs",
  "harvestIndexerDelayMs", "harvestQueueMax", "harvestDrainMaxWorks", "harvestEntryTtl",
  "harvestBrFirst", "harvestBrMaxWaitMs",
  "seedEnabled", "seedMaxPerCycle", "seedMinVotes", "seedIntervalH"
];
var booleanHarvestKeys = ["harvestEnabled", "harvestBrFirst", "seedEnabled"];
var isHarvestPaused = false;

function setHarvestFeedback(text, kind) {
  var el = $("harvestFeedback");
  if (!el) return;
  el.textContent = text || "";
  el.className = "feedback" + (kind ? " " + kind : "");
}

function renderHarvesterPanel(harvest, counters) {
  if (!harvest) return;
  var cfg = harvest.config || {};
  var eff = cfg.effective || {};
  var env = cfg.envDefaults || {};
  var overridden = cfg.overriddenKeys || [];
  var i, k, input, envSpan, badge;

  isHarvestPaused = Boolean(cfg.paused || harvest.paused);

  var stEl = $("harvestMetricState");
  if (stEl) {
    if (isHarvestPaused) {
      stEl.textContent = "PAUSADO";
      stEl.style.color = "var(--red)";
    } else {
      stEl.textContent = "ATIVO";
      stEl.style.color = "var(--green)";
    }
  }

  var qEl = $("harvestMetricQueue");
  if (qEl) {
    qEl.textContent = valueText(harvest.queueDepth) + " obra(s) / max " + valueText(harvest.queueMax);
  }

  var cEl = $("harvestMetricQueries");
  if (cEl) {
    cEl.textContent = valueText(harvest.queriesThisHour) + " / " + valueText(harvest.maxPerHour);
  }

  var hEl = $("harvestMetricHarvested");
  if (hEl) {
    hEl.textContent = valueText(harvest.harvested);
  }

  // Eficácia da colheita (Etapa 1): os contadores já viajam no
  // metrics.counters do dashboard-status; aqui só viram texto, ES5.
  var ctr = isObject(counters) ? counters : {};
  var dEl = $("harvestMetricDone");
  if (dEl) {
    dEl.textContent = valueText(ctr["harvest.done"]);
  }
  var eEl = $("harvestMetricEmpty");
  if (eEl) {
    eEl.textContent = valueText(ctr["harvest.empty"]);
  }

  var rEl = $("harvestMetricLastRun");
  if (rEl) {
    rEl.textContent = harvest.lastRunAt ? formatDate(harvest.lastRunAt) : "—";
  }

  var pauseBtn = $("harvestPauseToggleBtn");
  if (pauseBtn) {
    pauseBtn.textContent = isHarvestPaused ? "Retomar Colhedor" : "Pausar Colhedor";
    pauseBtn.className = isHarvestPaused ? "danger" : "primary";
  }

  var banner = $("harvestPauseBanner");
  if (banner) {
    if (isHarvestPaused) {
      banner.className = "pause-banner visible";
      var txt = "Colhedor está PAUSADO";
      if (cfg.pausedSince) txt += " desde " + formatDate(cfg.pausedSince);
      txt += ". Nenhuma obra em segundo plano será colhida.";
      $("harvestPauseBannerText").textContent = txt;
    } else {
      banner.className = "pause-banner";
    }
  }

  for (i = 0; i < harvestKeys.length; i += 1) {
    k = harvestKeys[i];
    input = $("harvest_" + k);
    envSpan = $("env_harvest_" + k);
    badge = $("badge_harvest_" + k);
    if (input) {
      if (booleanHarvestKeys.indexOf(k) !== -1) {
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

function saveHarvesterConfig() {
  var patch = {};
  var i, k, input;
  for (i = 0; i < harvestKeys.length; i += 1) {
    k = harvestKeys[i];
    input = $("harvest_" + k);
    if (input) {
      if (booleanHarvestKeys.indexOf(k) !== -1) {
        patch[k] = Boolean(input.checked);
      } else {
        var val = Number(input.value);
        if (isFinite(val)) patch[k] = val;
      }
    }
  }
  $("harvestSaveBtn").disabled = true;
  setHarvestFeedback("Salvando configurações…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "harvest-config-set", patch: patch })
  })
    .then(function (data) {
      if (data && data.ok) {
        setHarvestFeedback("Configurações do Colhedor salvas com sucesso!", "ok");
        loadStatus();
      } else {
        var errStr = data && data.errors ? data.errors.join(", ") : "erro desconhecido";
        setHarvestFeedback("Erro ao salvar: " + errStr, "error");
      }
    })
    .catch(function (err) {
      setHarvestFeedback("Falha na requisição: " + valueText(err && err.message ? err.message : err), "error");
    })
    .then(function () { $("harvestSaveBtn").disabled = false; });
}

function resetHarvesterConfig() {
  if (!window.confirm("Restaurar todos os parâmetros do Colhedor aos padrões do .env?")) return;
  $("harvestResetBtn").disabled = true;
  setHarvestFeedback("Restaurando padrões…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "harvest-config-reset", confirm: true })
  })
    .then(function (data) {
      if (data && data.ok) {
        setHarvestFeedback("Padrões do .env restaurados com sucesso!", "ok");
        loadStatus();
      } else {
        setHarvestFeedback("Erro ao restaurar padrões.", "error");
      }
    })
    .catch(function (err) {
      setHarvestFeedback("Falha na requisição: " + valueText(err && err.message ? err.message : err), "error");
    })
    .then(function () { $("harvestResetBtn").disabled = false; });
}

function toggleHarvesterPause(forcedState) {
  var nextState = typeof forcedState === "boolean" ? forcedState : !isHarvestPaused;
  var msg = nextState
    ? "Deseja pausar o Colhedor? Obras em segundo plano não serão colhidas."
    : "Deseja retomar o Colhedor?";
  if (!window.confirm(msg)) return;
  setHarvestFeedback("Atualizando estado de pausa…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "harvester-pause", paused: nextState })
  })
    .then(function () {
      setHarvestFeedback(nextState ? "Colhedor pausado com sucesso." : "Colhedor retomado com sucesso.", "ok");
      loadStatus();
    })
    .catch(function (err) {
      setHarvestFeedback("Erro ao alterar pausa: " + valueText(err && err.message ? err.message : err), "error");
    });
}

function drainHarvesterQueue() {
  if (!window.confirm("Deseja drenar uma fatia da fila do Colhedor?")) return;
  $("harvestDrainBtn").disabled = true;
  setHarvestFeedback("Drenando fatia da fila…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "harvester-drain" })
  })
    .then(function (data) {
      var d = data && data.drained !== undefined ? data.drained : 0;
      setHarvestFeedback("Fila drenada: " + d + " obra(s) processada(s).", "ok");
      loadStatus();
    })
    .catch(function (err) {
      setHarvestFeedback("Erro ao drenar: " + valueText(err && err.message ? err.message : err), "error");
    })
    .then(function () { $("harvestDrainBtn").disabled = false; });
}

function clearHarvesterQueue() {
  if (!window.confirm("Deseja realmente esvaziar todas as obras pendentes na fila do Colhedor?")) return;
  $("harvestClearQueueBtn").disabled = true;
  setHarvestFeedback("Limpando fila…", "warn");
  requestJson("/dashboard-action.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "harvester-clear-queue", confirm: true })
  })
    .then(function (data) {
      var c = data && data.cleared !== undefined ? data.cleared : 0;
      setHarvestFeedback("Fila esvaziada: " + c + " obra(s) removida(s).", "ok");
      loadStatus();
    })
    .catch(function (err) {
      setHarvestFeedback("Erro ao limpar fila: " + valueText(err && err.message ? err.message : err), "error");
    })
    .then(function () { $("harvestClearQueueBtn").disabled = false; });
}

function applyHarvesterPreset(preset) {
  if (preset === "padrao") {
    $("harvest_harvestEnabled").checked = true;
    $("harvest_harvestMaxPerHour").value = 120;
    $("harvest_harvestIdleWindowMs").value = 600000;
    $("harvest_harvestIntervalMs").value = 60000;
    $("harvest_harvestIndexerDelayMs").value = 1500;
    $("harvest_harvestQueueMax").value = 200;
    $("harvest_harvestDrainMaxWorks").value = 5;
    $("harvest_harvestBrFirst").checked = true;
    $("harvest_harvestBrMaxWaitMs").value = 21600000;
    $("harvest_seedEnabled").checked = true;
    $("harvest_seedMaxPerCycle").value = 20;
    $("harvest_seedMinVotes").value = 1000;
    $("harvest_seedIntervalH").value = 24;
    setHarvestFeedback("Preset Padrão Balanceado carregado. Clique em 'Salvar Alterações' para aplicar.", "warn");
  } else if (preset === "acelerado") {
    $("harvest_harvestEnabled").checked = true;
    $("harvest_harvestMaxPerHour").value = 300;
    $("harvest_harvestIdleWindowMs").value = 120000;
    $("harvest_harvestIntervalMs").value = 30000;
    $("harvest_harvestIndexerDelayMs").value = 1000;
    $("harvest_harvestQueueMax").value = 500;
    $("harvest_harvestDrainMaxWorks").value = 15;
    $("harvest_harvestBrFirst").checked = true;
    $("harvest_harvestBrMaxWaitMs").value = 21600000;
    $("harvest_seedEnabled").checked = true;
    $("harvest_seedMaxPerCycle").value = 40;
    $("harvest_seedMinVotes").value = 500;
    $("harvest_seedIntervalH").value = 12;
    setHarvestFeedback("Preset Acelerado (Madrugada) carregado. Clique em 'Salvar Alterações' para aplicar.", "warn");
  } else if (preset === "silencioso") {
    $("harvest_harvestEnabled").checked = true;
    $("harvest_harvestMaxPerHour").value = 40;
    $("harvest_harvestIdleWindowMs").value = 1800000;
    $("harvest_harvestIntervalMs").value = 120000;
    $("harvest_harvestIndexerDelayMs").value = 3000;
    $("harvest_harvestQueueMax").value = 100;
    $("harvest_harvestDrainMaxWorks").value = 2;
    $("harvest_harvestBrFirst").checked = true;
    $("harvest_harvestBrMaxWaitMs").value = 21600000;
    $("harvest_seedEnabled").checked = false;
    setHarvestFeedback("Preset Silencioso / Econômico carregado. Clique em 'Salvar Alterações' para aplicar.", "warn");
  }
}
