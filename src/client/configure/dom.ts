/* Adom Power-Movie - /configure: acesso ao DOM e helpers de estado de chips e
 * switches. bindElements() é o único ponto que resolve os IDs do HTML — os
 * módulos leem state.el em tempo de chamada, nunca no import. */

import { state } from './state.js';

export function $(id: string): any {
  return document.getElementById(id);
}

export function bindElements(): void {
  state.el = {
    presets: $('presets'),
    qualities: $('qualities'),
    brFirst: $('brFirst'),
    torrentioToggle: $('torrentioToggle'), torrentioRow: $('torrentioRow'),
    jackettIndexers: $('jackettIndexers'), indexerPriorityOrder: $('indexerPriorityOrder'),
    brSlots: $('brSlots'), outBr: $('outBr'),
    maxResults: $('maxResults'), outMax: $('outMax'),
    maxPerQuality: $('maxPerQuality'), outPerQuality: $('outPerQuality'),
    maxPerIndexer: $('maxPerIndexer'), outPerIndexer: $('outPerIndexer'),
    minSeeders: $('minSeeders'), outSeed: $('outSeed'),
    maxSizeGb: $('maxSizeGb'), outMaxSize: $('outMaxSize'),
    brOnly: $('brOnly'), dubbedOnly: $('dubbedOnly'),
    preferDubbed: $('preferDubbed'), excludeCam: $('excludeCam'),
    streamNameStyle: $('streamNameStyle'), streamNameShowSource: $('streamNameShowSource'),
    debridService: $('debridService'), debridApiKey: $('debridApiKey'),
    keyHintPlain: $('keyHintPlain'), keyHintSealed: $('keyHintSealed'), debridKeyKept: $('debridKeyKept'),
    debridKeyField: $('debridKeyField'), keyLink: $('keyLink'),
    debridCachedOnly: $('debridCachedOnly'), cachedOnlyRow: $('cachedOnlyRow'),
    showUncachedBr: $('showUncachedBr'), uncachedBrRow: $('uncachedBrRow'),
    autoFetchBr: $('autoFetchBr'), autoFetchRow: $('autoFetchRow'),
    noCacheNotice: $('noCacheNotice'),
    adMagnetNotice: $('adMagnetNotice'),
    installUrl: $('installUrl'), installBtn: $('installBtn'), copyBtn: $('copyBtn'),
  };
}

export function ancestorWithClass(node: any, className: string, stop: any): any {
  while (node && node !== stop) {
    if ((' ' + node.className + ' ').indexOf(' ' + className + ' ') !== -1) return node;
    node = node.parentNode;
  }
  return null;
}

export function isOn(sw: any): boolean {
  return sw.getAttribute('role') === 'switch'
    ? sw.getAttribute('aria-checked') === 'true'
    : sw.getAttribute('aria-pressed') === 'true';
}

export function setOn(sw: any, on: any): void {
  const active = on === true || on === 1 || on === '1' || on === 'true';
  sw.setAttribute('aria-pressed', active ? 'true' : 'false');
  if (sw.getAttribute('role') === 'switch') {
    sw.setAttribute('aria-checked', active ? 'true' : 'false');
  }
}

export function chipsSelected(group: any): string[] {
  return Array.prototype.filter
    .call(group.querySelectorAll('.chip'), (c: any) => c.getAttribute('aria-pressed') === 'true')
    .map((c: any) => c.getAttribute('data-value'));
}

export function setChips(group: any, values: string[]): void {
  Array.prototype.forEach.call(group.querySelectorAll('.chip'), (c: any) => {
    c.setAttribute('aria-pressed', values.indexOf(c.getAttribute('data-value')) !== -1 ? 'true' : 'false');
  });
}

export function mergeState(base: any, overlay: any): any {
  const out: Record<string, any> = {};
  const copy = (source: any) => {
    if (!source) return;
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
    }
  };
  copy(base);
  copy(overlay);
  return out;
}
