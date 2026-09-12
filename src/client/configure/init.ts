/* Adom Power-Movie - /configure: estado inicial e ligação de eventos. Este é
 * o único módulo com efeito de boot: nada roda no import — o entry chama
 * init(), que resolve o DOM, liga os handlers e busca /defaults.json. */

import { state } from './state.js';
import { $, bindElements, ancestorWithClass, isOn, setOn, setChips, mergeState } from './dom.js';
import { KEYS, decodeConfig, isSealedKey } from './keys.js';
import { normalizeIndexerLimits } from './limits.js';
import {
  fillJackettIndexers, normalizePriority, allJackettIndexerIds, pollIndexerStatuses,
} from './indexers.js';
import { applyPreset, render, setPresetChoice, togglePriority } from './view.js';

const INDEXER_STATUS_POLL_MS = 10000;

// Preset de entrada quando /defaults.json falha; espelha os defaults do
// servidor para a página não abrir vazia nem depender de rede.
const DEFAULT_FALLBACK = {
  providers: ['jackett'], qualities: [], maxResults: 40, minSeeders: 1,
  max2160p: 3, max1080p: 3, max720p: 3, max480p: 3, maxSd: 3, maxUnknown: 3, maxPerIndexer: 0,
  brReservedSlots: 6, brOnly: false, dubbedOnly: true,
  preferDubbed: true, excludeCam: false, maxSizeGb: 0,
  brFirst: true, jackettIndexers: [], jackettIndexersSelected: [],
  indexerPriority: [], indexerLimits: {},
  debridService: '', debridApiKey: '', debridCachedOnly: true, showUncachedBr: false,
  autoFetchBr: true, services: [],
  streamNameStyle: 'compact', streamNameShowSource: true,
};

export function fillServices(list: any): void {
  state.services = list || [];
  state.services.forEach((svc) => {
    const opt = document.createElement('option');
    opt.value = svc.id;
    opt.textContent = svc.cacheCheck ? svc.label : svc.label + ' (sem consulta de cache)';
    state.el.debridService.appendChild(opt);
  });
}

function isIdList(value: any): boolean {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') return false;
  }
  return true;
}

export function apply(incoming: any): void {
  const el = state.el;
  if (incoming.providers && incoming.providers.length) {
    // 'torrentio' vira toggle; o resto é a base. Ordem e demais fontes
    // (jackett/prowlarr/demo) vêm do link salvo ou dos defaults, intactas.
    state.providerBase = incoming.providers.filter((name: string) => name !== 'torrentio');
    state.torrentioOn = incoming.providers.indexOf('torrentio') !== -1;
  }
  // Instância em modo demo mantém o pool isolado (sem rede): o toggle não é
  // oferecido e nada de torrentio é adicionado por engano.
  const offerTorrentio = state.providerBase.length === 0 || state.providerBase.some((name) => name !== 'demo');
  el.torrentioRow.hidden = !offerTorrentio;
  if (!offerTorrentio) state.torrentioOn = false;
  setOn(el.torrentioToggle, state.torrentioOn);
  setChips(el.qualities, incoming.qualities || []);
  setOn(el.brFirst, incoming.brFirst == null ? true : incoming.brFirst);
  const selectedJackett = isIdList(incoming.jackettIndexers)
    ? incoming.jackettIndexers
    : isIdList(incoming.jackettIndexersSelected)
      ? incoming.jackettIndexersSelected
      : allJackettIndexerIds();
  setChips(el.jackettIndexers, selectedJackett);
  const savedPriority = isIdList(incoming.indexerPriority)
    ? incoming.indexerPriority
    : typeof incoming.indexerPriority === 'string' ? incoming.indexerPriority.split(',').filter(Boolean) : [];
  state.indexerPriority = normalizePriority(savedPriority);
  const savedLimits = normalizeIndexerLimits(incoming.indexerLimits);
  Array.prototype.forEach.call(el.jackettIndexers.querySelectorAll('.indexer-limit'), (select: any) => {
    const id = select.getAttribute('data-indexer-id');
    select.value = Object.prototype.hasOwnProperty.call(savedLimits, id) ? String(savedLimits[id]) : '';
  });
  el.maxResults.value = incoming.maxResults;
  const qualityValue = (name: string) => {
    if (incoming[name] != null) return incoming[name];
    if (state.instanceDefaults && state.instanceDefaults[name] != null) return state.instanceDefaults[name];
    return 4;
  };
  // Link antigo pode trazer as seis cotas diferentes entre si; o controle único
  // mostra a maior, para nenhuma vaga sumir sem o usuário pedir.
  el.maxPerQuality.value = Math.max(
    Number(qualityValue('max2160p')), Number(qualityValue('max1080p')),
    Number(qualityValue('max720p')), Number(qualityValue('max480p')),
    Number(qualityValue('maxSd')), Number(qualityValue('maxUnknown')),
  );
  el.maxPerIndexer.value = incoming.maxPerIndexer;
  el.minSeeders.value = incoming.minSeeders;
  el.brSlots.value = incoming.brReservedSlots;
  setOn(el.brOnly, incoming.brOnly);
  setOn(el.dubbedOnly, incoming.dubbedOnly);
  setOn(el.preferDubbed, incoming.preferDubbed);
  setOn(el.excludeCam, incoming.excludeCam);
  el.maxSizeGb.value = incoming.maxSizeGb;
  if (el.streamNameStyle) el.streamNameStyle.value = incoming.streamNameStyle || 'compact';
  if (el.streamNameShowSource) el.streamNameShowSource.value = incoming.streamNameShowSource === false ? 'false' : 'true';
  el.debridService.value = incoming.debridService || '';
  // Chave cifrada não vai para o campo: é blob opaco, sem uso na tela.
  state.sealedKey = isSealedKey(incoming.debridApiKey) ? incoming.debridApiKey : '';
  el.debridApiKey.value = state.sealedKey ? '' : (incoming.debridApiKey || '');
  el.debridKeyKept.hidden = !state.sealedKey;
  setOn(el.debridCachedOnly, incoming.debridCachedOnly);
  setOn(el.showUncachedBr, incoming.showUncachedBr);
  setOn(el.autoFetchBr, incoming.autoFetchBr);
  render();
}

// Reabrir /<config>/configure repopula o formulário com o que o usuário já
// tinha instalado, em vez de voltar aos defaults e perder a configuração.
export function fromUrl(): any {
  const seg = location.pathname.split('/').filter(Boolean)[0];
  if (!seg || seg === 'configure') return null;
  const raw = decodeConfig(seg);
  if (!raw) return null;
  // `+` também separa lista nos links (ex.: "jackett+torrentio"), além da
  // vírgula — mesma regra do runtime.
  const toList = (v: any) => (v ? String(v).split(/[,+]/).filter(Boolean) : []);
  const out: Record<string, any> = {};
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.providers)) out.providers = toList(raw[KEYS.providers]);
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.qualities)) out.qualities = toList(raw[KEYS.qualities]);
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.maxResults)) out.maxResults = raw[KEYS.maxResults];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.minSeeders)) out.minSeeders = raw[KEYS.minSeeders];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.brReservedSlots)) out.brReservedSlots = raw[KEYS.brReservedSlots];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.brOnly)) out.brOnly = !!raw[KEYS.brOnly];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.dubbedOnly)) out.dubbedOnly = !!raw[KEYS.dubbedOnly];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.debridService)) out.debridService = raw[KEYS.debridService];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.debridApiKey)) out.debridApiKey = raw[KEYS.debridApiKey];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.debridCachedOnly)) out.debridCachedOnly = !!raw[KEYS.debridCachedOnly];
  // Links antigos não têm estas chaves. Omiti-las preserva os defaults desta
  // instância em vez de sobrescrevê-los com valores fixos do front-end.
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.max2160p)) out.max2160p = raw[KEYS.max2160p];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.max1080p)) out.max1080p = raw[KEYS.max1080p];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.max720p)) out.max720p = raw[KEYS.max720p];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.max480p)) out.max480p = raw[KEYS.max480p];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.maxSd)) out.maxSd = raw[KEYS.maxSd];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.maxUnknown)) out.maxUnknown = raw[KEYS.maxUnknown];
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.maxPerIndexer)) out.maxPerIndexer = raw[KEYS.maxPerIndexer];
  if (raw[KEYS.autoFetchBr] != null) out.autoFetchBr = !!raw[KEYS.autoFetchBr];
  if (raw[KEYS.showUncachedBr] != null) out.showUncachedBr = !!raw[KEYS.showUncachedBr];
  if (raw[KEYS.preferDubbed] != null) out.preferDubbed = !!raw[KEYS.preferDubbed];
  if (raw[KEYS.excludeCam] != null) out.excludeCam = !!raw[KEYS.excludeCam];
  if (raw[KEYS.maxSizeGb] != null) out.maxSizeGb = raw[KEYS.maxSizeGb];
  if (raw[KEYS.streamNameStyle] != null) out.streamNameStyle = String(raw[KEYS.streamNameStyle]);
  if (raw[KEYS.streamNameShowSource] != null) out.streamNameShowSource = !!raw[KEYS.streamNameShowSource];
  // Links antigos não têm bf nem ji: omitir preserva o padrão da instância;
  // na ausência de ji, apply marca todo o catálogo.
  if (raw[KEYS.brFirst] != null) out.brFirst = !!raw[KEYS.brFirst];
  if (raw[KEYS.jackettIndexers] != null) out.jackettIndexers = toList(raw[KEYS.jackettIndexers]);
  if (raw[KEYS.indexerPriority] != null) out.indexerPriority = toList(raw[KEYS.indexerPriority]);
  if (Object.prototype.hasOwnProperty.call(raw, KEYS.indexerLimits)) {
    out.indexerLimits = normalizeIndexerLimits(raw[KEYS.indexerLimits]);
  }
  return out;
}

function wireEvents(): void {
  const el = state.el;
  [el.qualities, el.jackettIndexers].forEach((group: any) => {
    group.addEventListener('click', (ev: any) => {
      const priority = group === el.jackettIndexers ? ancestorWithClass(ev.target, 'priority-btn', group) : null;
      if (priority) {
        setPresetChoice('custom');
        togglePriority(priority.getAttribute('data-value'));
        return;
      }
      const chip = ancestorWithClass(ev.target, 'chip', group);
      if (!chip) return;
      const value = chip.getAttribute('data-value');
      setOn(chip, !isOn(chip));
      if (group === el.jackettIndexers && !isOn(chip)) {
        const priorityAt = state.indexerPriority.indexOf(value);
        if (priorityAt !== -1) state.indexerPriority.splice(priorityAt, 1);
      }
      setPresetChoice('custom');
      render();
    });
  });

  [el.brFirst, el.brOnly, el.dubbedOnly, el.preferDubbed, el.excludeCam, el.debridCachedOnly, el.showUncachedBr, el.autoFetchBr]
    .forEach((sw: any) => {
      sw.addEventListener('click', () => { setOn(sw, !isOn(sw)); setPresetChoice('custom'); render(); });
    });

  // Pool global Torrentio: toggle específico sobre a base de provedores. Não
  // existe no schema como opção própria — grava no KEYS.providers ('p').
  if (el.torrentioToggle) {
    el.torrentioToggle.addEventListener('click', () => {
      setOn(el.torrentioToggle, !isOn(el.torrentioToggle));
      state.torrentioOn = isOn(el.torrentioToggle);
      setPresetChoice('custom');
      render();
    });
  }

  [el.brSlots, el.maxResults, el.maxPerQuality, el.maxPerIndexer, el.minSeeders, el.maxSizeGb].forEach((r: any) => {
    r.addEventListener('input', () => { setPresetChoice('custom'); render(); });
  });

  el.debridService.addEventListener('change', () => { setPresetChoice('custom'); render(); });
  if (el.streamNameStyle) el.streamNameStyle.addEventListener('change', () => { setPresetChoice('custom'); render(); });
  if (el.streamNameShowSource) el.streamNameShowSource.addEventListener('change', () => { setPresetChoice('custom'); render(); });
  el.debridApiKey.addEventListener('input', () => {
    // Digitou qualquer coisa: a chave do link antigo deixa de valer. Sem isto,
    // apagar o campo faria a URL voltar a carregar a chave anterior.
    state.sealedKey = '';
    el.debridKeyKept.hidden = true;
    setPresetChoice('custom');
    render();
  });

  el.presets.addEventListener('click', (ev: any) => {
    const button = ancestorWithClass(ev.target, 'preset', el.presets);
    if (!button) return;
    const name = button.getAttribute('data-preset');
    if (name === 'custom') setPresetChoice('custom');
    else applyPreset(name);
  });

  el.copyBtn.addEventListener('click', () => {
    const url = el.copyBtn.getAttribute('data-url') || '';
    if (!url) return;
    const done = () => {
      el.copyBtn.textContent = 'Copiado ✓';
      el.copyBtn.classList.add('ok');
      setTimeout(() => {
        el.copyBtn.textContent = 'Copiar link';
        el.copyBtn.classList.remove('ok');
      }, 1800);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(done, done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      done();
    }
  });

  el.installBtn.addEventListener('click', (ev: any) => {
    if (el.installBtn.getAttribute('aria-disabled') === 'true') ev.preventDefault();
  });
}

function boot(): void {
  fetch('/defaults.json')
    .then((r) => r.json())
    .catch(() => DEFAULT_FALLBACK)
    .then((defaults: any) => {
      state.instanceDefaults = defaults;
      // A marca vem do servidor: renomear o addon no .env reflete na página.
      const brand = defaults.addonName || 'Adom Power-Movie';
      document.title = brand + ' — Configurar';
      const h1 = document.getElementById('addonName');
      if (h1) h1.textContent = brand;
      fillServices(defaults.services);
      fillJackettIndexers(defaults.jackettIndexers);
      const saved = fromUrl();
      // Uma URL existente é a fonte da verdade: não deixe o preset de entrada
      // sobrescrever nem mesmo as chaves que um link antigo omitiu.
      const plan = initialPlan(defaults, saved);
      apply(plan.initial);
      if (plan.preset === 'custom') setPresetChoice('custom');
      else applyPreset(plan.preset);
      // A busca atualiza o status no backend depois que a página abre; um
      // polling leve reflete isso sem recarregar ou reprocessar a config.
      setInterval(pollIndexerStatuses, INDEXER_STATUS_POLL_MS);
    });
}

/** Monta o estado inicial a partir dos defaults e do link salvo (extraído do
 * boot para ser testável sem DOM/rede: devolve o estado e o preset escolhido). */
export function initialPlan(defaults: any, saved: any): { initial: any; preset: string } {
  const initial = mergeState({}, defaults);
  // O catálogo ocupa o mesmo nome da opção no JSON de defaults, mas não é uma
  // seleção. Removê-lo evita que um catálogo vazio esconda a seleção padrão ou
  // que objetos sejam tratados como IDs dos chips.
  delete initial.jackettIndexers;
  if (saved !== null) {
    return { initial: mergeState(initial, saved), preset: 'custom' };
  }
  // /configure novo parte do preset BR, mas applyPreset só toca opções
  // comportamentais e preserva fontes, indexadores e debrid dos defaults.
  return { initial, preset: 'recommended' };
}

export function init(): void {
  bindElements();
  wireEvents();
  boot();
}
