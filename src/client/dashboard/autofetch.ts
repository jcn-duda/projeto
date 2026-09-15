/* Adom Power-Movie — aba Chupim / Autofetch: render (C3, ESM nativo).
 * Extraído para respeitar o teto de 400 linhas; as ações (salvar/resetar/pausar/
 * drenar/presets) vivem em autofetch-actions.ts. O painel de stall é hook
 * (af-stall.ts). Nada toca o DOM no import. */

import { $, origemOf, origemValue } from './core.js';
import { applyOrigem, formatDate } from './render.js';
import { hooks } from './hooks.js';

export const AF_KEYS = [
  'autoFetchBr', 'autoFetchBrProbe', 'autoFetchAnyDubbed', 'autoFetchTopSeeds', 'autoFetchSeedsPtFirst',
  'autoFetchMinSeeders', 'autoFetchMax', 'autoFetchTopSeedsMax', 'autoFetchRareMax',
  'autoFetchRareThreshold', 'autoFetchRareMaxSeeders', 'autoFetchEnqueueMaxHour',
  'autoFetchQueue', 'autoFetchQueueDepth', 'autoFetchPauseAt', 'autoFetchPauseRefreshMs',
  'autoFetchTtl', 'autoFetchRecheckMs', 'autoFetchRecheckMax', 'autoFetchStallStreak',
  'autoFetchSettleMs', 'autoFetchDeadTtl', 'autoFetchSeasonFill',
];

export const BOOLEAN_AF_KEYS = [
  'autoFetchBr', 'autoFetchBrProbe', 'autoFetchAnyDubbed', 'autoFetchTopSeeds', 'autoFetchSeedsPtFirst',
  'autoFetchQueue', 'autoFetchSeasonFill',
];

let afPaused = false;

export function setAutofetchPaused(value: boolean): void { afPaused = value; }
export function isAutofetchPaused(): boolean { return afPaused; }

// applyOrigem + fail-open: sem kind o número antigo fica; evita removeAttribute
// no Fake DOM dos testes (só o browser real tem o método).
function paintAfOrigem(el: any, value: any, kind: string | null, uptimeS: any): void {
  if (!el) return;
  if (kind) {
    applyOrigem(el, value, kind, uptimeS);
    return;
  }
  el.textContent = origemValue(value, null);
  el.title = '';
}

export function renderAutofetchPanel(af: any, uptimeS?: any): void {
  if (!af) return;
  const cfg = af.config || {};
  const eff = cfg.effective || {};
  const env = cfg.envDefaults || {};
  const overridden = cfg.overriddenKeys || [];
  let i: number;

  setAutofetchPaused(Boolean(cfg.paused));

  const stEl = $('afMetricState');
  if (stEl) {
    if (afPaused) {
      stEl.textContent = 'PAUSADO';
      stEl.style.color = 'var(--red)';
    } else {
      stEl.textContent = 'ATIVO';
      stEl.style.color = 'var(--green)';
    }
  }

  // Filas: durável no snapshot. Sem _origem = fail-open (número antigo).
  const qEl = $('afMetricQueues');
  if (qEl && af.queues) {
    paintAfOrigem(qEl, (af.queues.count || 0) + ' fila(s) / ' + (af.queues.items || 0) + ' item(ns)', origemOf(af, 'queues'), uptimeS);
  }

  const rEl = $('afMetricRechecks');
  if (rEl) {
    rEl.textContent = (af.recheckLots || 0) + ' (' + (af.settleLots || 0) + ' settle)';
  }

  // Blacklist de mortos: durável (reindex no boot). naomedido → "—".
  const dEl = $('afMetricDead');
  if (dEl) {
    paintAfOrigem(dEl, af.deadBlacklistCount || 0, origemOf(af, 'deadBlacklistCount'), uptimeS);
  }

  // Fila de remoções represadas (gate removeById): aguarda decisão do operador,
  // que drena pelo botão próprio em vez de ligar o knob global. A origem vem do
  // _origem do snapshot — varredura do cache, durável.
  const sEl = $('afMetricSuppressed');
  if (sEl) {
    paintAfOrigem(sEl, af.suppressed || 0, origemOf(af, 'suppressed'), uptimeS);
  }

  // Orçamento hora: amostra deste processo.
  const bEl = $('afMetricBudget');
  if (bEl && af.budget) {
    const accs = af.budget.accounts || [];
    let extra = '';
    for (let j = 0; j < accs.length; j += 1) {
      extra += (j ? ' · ' : ' ') + accs[j].id + ' ' + Number(accs[j].used || 0) + '/' + Number(accs[j].limit || 0);
    }
    paintAfOrigem(bEl, (af.budget.used || 0) + ' / ' + (af.budget.limit || 0) + extra, origemOf(af, 'budget'), uptimeS);
  }

  // Por que o Chupim desistiu: o último registro do trace e a contagem por
  // motivo. Sem isso, um portão que fecha (marker, gate, budget) era um `return`
  // mudo — invisível no painel.
  const guEl = $('afMetricGiveUp');
  if (guEl && af.lastSkips && af.lastSkips.length) {
    const gu = af.lastSkips[0];
    let guTxt = gu.reason;
    if (gu.label) guTxt += ' · ' + gu.label;
    if (gu.at) guTxt += ' · ' + formatDate(gu.at);
    guEl.textContent = guTxt;
  }

  const rsEl = $('afMetricReasons');
  if (rsEl) {
    const parts: string[] = [];
    const sk = af.skips || {};
    // `dubbed-only`/`seeds-*` são razões de SELEÇÃO/POLÍTICA do pool seeds
    // (Fase 1 do Chupim 2.0): não passam pelo classifyEnqueue, mas contam em
    // `autofetch.skip.<motivo>` e por isso aparecem aqui.
    const skKeys = ['account-gate', 'budget', 'obra-cap', 'dead', 'marker', 'already-cached', 'in-flight', 'search-slot-busy', 'paused', 'unknown-cache', 'stop-has-br', 'stop-has-cached', 'dubbed-only', 'br-probe-pending', 'seeds-playable', 'seeds-size-unknown', 'seeds-too-big', 'seeds-quality', 'no-candidate', 'no-candidates', 'disabled'];
    for (i = 0; i < skKeys.length; i += 1) {
      const n = Number(sk[skKeys[i]] || 0);
      if (n > 0) parts.push(skKeys[i] + ' ' + n);
    }
    rsEl.textContent = parts.length ? parts.join(' · ') : '—';
  }

  // Gate de conta: amostra no snapshot; memo frio (_origem.accounts=naomedido)
  // não pinta "aberto" como saúde — vira "—".
  const gateEl = $('afMetricGate');
  if (gateEl && af.accountGate) {
    const gate = af.accountGate;
    let gateKind = origemOf(af, 'accountGate');
    const accountsKind = origemOf(gate, 'accounts');
    let gateColor = '';
    let gateTxt: string;
    if (!gate.pauseAt || gate.pauseAt <= 0) {
      gateTxt = 'desligado';
    } else if (gate.blocked) {
      gateTxt = 'BLOQUEADO (pauseAt ' + gate.pauseAt + ')';
      gateColor = 'var(--red)';
    } else if (gate.inFlight) {
      gateTxt = 'medindo… (pauseAt ' + gate.pauseAt + ')';
    } else if (accountsKind === 'naomedido') {
      gateTxt = '';
      gateKind = 'naomedido';
    } else {
      gateTxt = 'aberto (pauseAt ' + gate.pauseAt + ')';
    }
    paintAfOrigem(gateEl, gateTxt, gateKind, uptimeS);
    gateEl.style.color = gateColor;
  }

  const pauseBtn = $('afPauseToggleBtn');
  if (pauseBtn) {
    pauseBtn.textContent = afPaused ? 'Retomar Chupim' : 'Pausar Chupim';
    pauseBtn.className = afPaused ? 'danger' : 'primary';
  }

  const banner = $('afPauseBanner');
  if (banner) {
    if (afPaused) {
      banner.className = 'pause-banner visible';
      let txt = 'Chupim está PAUSADO';
      if (cfg.pausedSince) txt += ' desde ' + formatDate(cfg.pausedSince);
      txt += '. Nenhum download será enviado ao debrid.';
      $('afPauseBannerText').textContent = txt;
    } else {
      banner.className = 'pause-banner';
    }
  }

  for (i = 0; i < AF_KEYS.length; i += 1) {
    const k = AF_KEYS[i];
    const input = $('af_' + k);
    const envSpan = $('env_' + k);
    const badge = $('badge_' + k);
    if (input) {
      if (BOOLEAN_AF_KEYS.indexOf(k) !== -1) {
        input.checked = Boolean(eff[k]);
      } else {
        input.value = eff[k] !== undefined && eff[k] !== null ? eff[k] : '';
      }
    }
    if (envSpan) {
      envSpan.textContent = env[k] !== undefined && env[k] !== null ? String(env[k]) : '—';
    }
    if (badge) {
      badge.style.display = overridden.indexOf(k) !== -1 ? 'inline-block' : 'none';
    }
  }

  // Fase 3.5 do redesign: o diagnóstico de stall (lotes/slots/locks/skips) vem
  // de um módulo próprio (af-stall.ts), por hook.
  hooks.call('renderAutofetchStall', af, uptimeS);
}
