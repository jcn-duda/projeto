/* Adom Power-Movie - /configure: montagem da URL (collect), pintura dos
 * outputs e presets. providerChoice recompõe a lista de fontes: a base
 * (jackett/prowlarr/demo) intacta + o pool global Torrentio como toggle. */

import { state } from './state.js';
import { isOn, setOn, chipsSelected } from './dom.js';
import { KEYS, encodeConfig } from './keys.js';
import { collectIndexerLimits } from './limits.js';
import { applySegment, requestSeal } from './seal.js';

// maxPerQuality: 3 desde 2026-09-01 (era 6) -- decisão do operador por lista
// mais curta. O controle é único e vale também para o balde "sem resolução",
// o das fontes BR. O BR não fica desprotegido: a reserva (brReservedSlots)
// atravessa a cota e não a consome.
export const PRESET_BEHAVIORS: Record<string, any> = {
  recommended: {
    brFirst: true, preferDubbed: true, dubbedOnly: true, brOnly: false,
    excludeCam: true, brReservedSlots: 6, maxResults: 40,
    maxPerQuality: 3, maxPerIndexer: 0, minSeeders: 1, maxSizeGb: 0,
    debridCachedOnly: true, showUncachedBr: false, autoFetchBr: true,
  },
  powerBr: {
    brFirst: true, preferDubbed: true, dubbedOnly: true, brOnly: false,
    excludeCam: true, brReservedSlots: 6, maxResults: 40,
    maxPerQuality: 3, maxPerIndexer: 0, minSeeders: 1, maxSizeGb: 0,
    debridCachedOnly: true, showUncachedBr: true, autoFetchBr: true,
  },
};

// Base vazia representa o modo torrentio-only; demo continua isolado.
export function hasSearchBase(): boolean {
  return state.providerBase.length === 0 || state.providerBase.some((name) => name !== 'demo');
}

export function providerChoice(): string {
  const list = state.providerBase.slice();
  if (state.torrentioOn && hasSearchBase()) list.push('torrentio');
  if (!list.length) list.push('jackett');
  return list.join(',');
}

export function serviceById(id: string): any {
  for (let i = 0; i < state.services.length; i++) {
    if (state.services[i].id === id) return state.services[i];
  }
  return null;
}

export function setPresetChoice(name: string): void {
  Array.prototype.forEach.call(state.el.presets.querySelectorAll('.preset'), (button: any) => {
    button.setAttribute('aria-pressed', button.getAttribute('data-preset') === name ? 'true' : 'false');
  });
}

export function renderPriority(): void {
  const el = state.el;
  const labels: string[] = [];
  for (let i = 0; i < state.indexerPriority.length; i++) {
    for (let j = 0; j < state.jackettIndexers.length; j++) {
      if (state.jackettIndexers[j].id === state.indexerPriority[i]) {
        labels.push(state.jackettIndexers[j].label);
        break;
      }
    }
  }
  el.indexerPriorityOrder.textContent = labels.length ? labels.join(' → ') : 'nenhuma marcada';
  Array.prototype.forEach.call(el.jackettIndexers.querySelectorAll('.priority-btn'), (button: any) => {
    const on = state.indexerPriority.indexOf(button.getAttribute('data-value')) !== -1;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.textContent = on ? '★' : '☆';
    let label = button.getAttribute('data-value');
    for (let i = 0; i < state.jackettIndexers.length; i++) {
      if (state.jackettIndexers[i].id === label) { label = state.jackettIndexers[i].label; break; }
    }
    button.setAttribute('aria-label', (on ? 'Remover ' : 'Marcar ') + 'prioridade alta de ' + label);
  });
}

export function togglePriority(id: string): void {
  const at = state.indexerPriority.indexOf(id);
  const el = state.el;
  if (at === -1) {
    state.indexerPriority.push(id);
    // Priorizar uma fonte desligada não teria efeito e parece um controle
    // quebrado; a estrela também ativa o indexador de forma explícita.
    let toggle = null;
    const toggles = el.jackettIndexers.querySelectorAll('.indexer-toggle');
    for (let i = 0; i < toggles.length; i++) {
      if (toggles[i].getAttribute('data-value') === id) { toggle = toggles[i]; break; }
    }
    if (toggle) setOn(toggle, true);
  } else {
    state.indexerPriority.splice(at, 1);
  }
  renderPriority();
  render();
}

export function applyPreset(name: string): void {
  const preset = PRESET_BEHAVIORS[name];
  const el = state.el;
  if (!preset) {
    setPresetChoice('custom');
    return;
  }
  el.brSlots.value = preset.brReservedSlots;
  el.maxResults.value = preset.maxResults;
  el.maxPerQuality.value = preset.maxPerQuality;
  el.maxPerIndexer.value = preset.maxPerIndexer;
  el.minSeeders.value = preset.minSeeders;
  el.maxSizeGb.value = preset.maxSizeGb;
  setOn(el.brFirst, preset.brFirst);
  setOn(el.preferDubbed, preset.preferDubbed);
  setOn(el.dubbedOnly, preset.dubbedOnly);
  setOn(el.brOnly, preset.brOnly);
  setOn(el.excludeCam, preset.excludeCam);
  setOn(el.debridCachedOnly, preset.debridCachedOnly);
  setOn(el.showUncachedBr, preset.showUncachedBr);
  setOn(el.autoFetchBr, preset.autoFetchBr);
  setPresetChoice(name);
  render();
}

/* ---------- montagem da URL ---------- */

export function collect(): Record<string, any> {
  const el = state.el;
  const cfg: Record<string, any> = {};
  // A fonte saiu da página (era config de operador) e viaja intacta: as fontes
  // BR entram por fora, independente dela.
  cfg[KEYS.providers] = providerChoice();
  cfg[KEYS.qualities] = chipsSelected(el.qualities).join(',');
  cfg[KEYS.maxResults] = Number(el.maxResults.value);
  // Um controle, seis cotas. As chaves seguem separadas na URL -- o backend
  // (SCHEMA em src/runtime.ts) não muda e link antigo continua válido.
  const perQuality = Number(el.maxPerQuality.value);
  cfg[KEYS.max2160p] = perQuality;
  cfg[KEYS.max1080p] = perQuality;
  cfg[KEYS.max720p] = perQuality;
  cfg[KEYS.max480p] = perQuality;
  cfg[KEYS.maxSd] = perQuality;
  cfg[KEYS.maxUnknown] = perQuality;
  cfg[KEYS.maxPerIndexer] = Number(el.maxPerIndexer.value);
  cfg[KEYS.minSeeders] = Number(el.minSeeders.value);
  cfg[KEYS.brReservedSlots] = Number(el.brSlots.value);
  cfg[KEYS.brOnly] = isOn(el.brOnly) ? 1 : 0;
  cfg[KEYS.dubbedOnly] = isOn(el.dubbedOnly) ? 1 : 0;
  cfg[KEYS.preferDubbed] = isOn(el.preferDubbed) ? 1 : 0;
  cfg[KEYS.excludeCam] = isOn(el.excludeCam) ? 1 : 0;
  cfg[KEYS.maxSizeGb] = Number(el.maxSizeGb.value);
  cfg[KEYS.brFirst] = isOn(el.brFirst) ? 1 : 0;
  cfg[KEYS.jackettIndexers] = chipsSelected(el.jackettIndexers).join(',');
  cfg[KEYS.indexerPriority] = state.indexerPriority.join(',');
  cfg[KEYS.indexerLimits] = collectIndexerLimits();
  cfg[KEYS.debridService] = el.debridService.value;
  cfg[KEYS.debridCachedOnly] = isOn(el.debridCachedOnly) ? 1 : 0;
  cfg[KEYS.showUncachedBr] = isOn(el.showUncachedBr) ? 1 : 0;
  cfg[KEYS.autoFetchBr] = isOn(el.autoFetchBr) ? 1 : 0;
  if (el.streamNameStyle && el.streamNameStyle.value && el.streamNameStyle.value !== 'compact') {
    cfg[KEYS.streamNameStyle] = el.streamNameStyle.value;
  }
  if (el.streamNameShowSource && el.streamNameShowSource.value === 'false') {
    cfg[KEYS.streamNameShowSource] = 0;
  }
  // Chave vazia não entra: evita gravar "dk":"" no link à toa.
  if (el.debridService.value && el.debridApiKey.value.trim()) {
    cfg[KEYS.debridApiKey] = el.debridApiKey.value.trim();
  } else if (el.debridService.value && state.sealedKey) {
    // Reabriu um link de chave cifrada e mexeu noutra opção: reaproveita o
    // valor cifrado em vez de gerar uma URL sem debrid nenhum.
    cfg[KEYS.debridApiKey] = state.sealedKey;
  }
  return cfg;
}

export function render(): void {
  const el = state.el;
  const qualityLimitLabel = (value: string) => {
    return value === '0' ? 'nenhuma' : value === '100' ? 'sem limite' : value;
  };
  el.outBr.textContent = el.brSlots.value;
  el.outMax.textContent = el.maxResults.value;
  el.outPerQuality.textContent = qualityLimitLabel(el.maxPerQuality.value);
  // 0 aqui é "desligado", não "nenhuma" — semântica oposta às cotas acima.
  el.outPerIndexer.textContent = el.maxPerIndexer.value === '0' ? 'sem limite' : el.maxPerIndexer.value;
  el.outSeed.textContent = el.minSeeders.value === '0' ? 'sem filtro' : el.minSeeders.value;
  el.outMaxSize.textContent = el.maxSizeGb.value === '0' ? 'sem limite' : el.maxSizeGb.value + ' GB';
  renderPriority();

  // O serviço ativo continua visível no próprio seletor, que é onde a escolha
  // se faz; o badge do cabeçalho saiu com a tagline.
  const svc = serviceById(el.debridService.value);
  el.debridKeyField.hidden = !svc;
  // A dica só pode prometer cifra quando a instância tem RESOLVE_SECRET.
  const sealOn = Boolean(state.instanceDefaults && state.instanceDefaults.sealKeyEnabled);
  el.keyHintPlain.hidden = sealOn;
  el.keyHintSealed.hidden = !sealOn;
  // Sem consulta de cache o filtro não teria como funcionar: esconde e explica.
  el.cachedOnlyRow.hidden = !svc || !svc.cacheCheck;
  // Mesmo motivo do filtro: sem consulta o download automático não roda.
  el.autoFetchRow.hidden = !svc || !svc.cacheCheck;
  el.uncachedBrRow.hidden = !svc || !svc.cacheCheck || !isOn(el.debridCachedOnly);
  el.noCacheNotice.hidden = !svc || svc.cacheCheck;
  el.adMagnetNotice.hidden = !svc || svc.id !== 'alldebrid';
  if (svc && svc.keyUrl) {
    el.keyLink.href = svc.keyUrl;
    el.keyLink.hidden = false;
  } else {
    el.keyLink.hidden = true;
  }

  // URLs novas carregam explicitamente as escolhas comportamentais: reabrir o
  // link não depende de defaults futuros do operador ou do servidor.
  const segment = encodeConfig(collect());
  applySegment(segment);
  requestSeal(segment);
}
