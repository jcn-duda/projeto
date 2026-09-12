/* Adom Power-Movie — /dashboard: núcleo compartilhado (C3, ESM nativo).
 * Helpers puros e HTTP autenticado; o ESTADO mutável entre módulos (token,
 * timers, requestInFlight, lastStatusRoot…) vive em state.ts (DashState). O que
 * DESENHA vive em render.ts; sondas em probes.ts; abas em nav.ts; painéis da
 * Geral em panels*.ts; Chupim/Colhedor/Catálogo/MagnetDB em módulos próprios.
 *
 * Nenhum acesso a DOM no import: `$`/HTTP só tocam `document`/`window`/`fetch`
 * quando chamados, e o entry só chama o boot com o DOM montado. Módulo folha
 * (importa só o estado). */

import { DashState } from './state.js';

export const TOKEN_KEY = 'adom.dashboard.test-token';
export const RATE_KEY = 'adom.dashboard.refresh-rate';

export interface KnownService {
  id: string;
  label: string;
}

export const knownServices: KnownService[] = [
  { id: 'premiumize', label: 'Premiumize' },
  { id: 'alldebrid', label: 'AllDebrid' },
  { id: 'torbox', label: 'TorBox' },
  { id: 'realdebrid', label: 'Real-Debrid' },
  { id: 'debridlink', label: 'Debrid-Link' },
];

/** Seletor por id. `any` de propósito: o DOM falso dos testes não implementa a
 * árvore inteira, e o contrato de nulidade é tratado em cada chamador. */
export function $(id: string): any {
  return document.getElementById(id);
}

export function isObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function copyObject(source: any): Record<string, any> {
  const out: Record<string, any> = {};
  Object.keys(isObject(source) ? source : {}).forEach((key) => { out[key] = source[key]; });
  return out;
}

export function own(object: any, key: string): boolean {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

export function first(object: any, names: string[], fallback: any): any {
  let i: number;
  if (!object) return fallback;
  for (i = 0; i < names.length; i += 1) {
    if (object[names[i]] !== undefined && object[names[i]] !== null) return object[names[i]];
  }
  return fallback;
}

export function valueText(value: any): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (typeof value === 'number') return isFinite(value) ? String(value) : '—';
  if (typeof value === 'object') return 'ver detalhes';
  return String(value);
}

// Fase 4 — procedência do painel (_origem). Limiar alinhado ao Chupim:
// uptime baixo + amostra pode subcontar L2 após restart.
export const AMOSTRA_CEDO_S = 300;

export function isAmostraCedo(uptimeS: any): boolean {
  const n = Number(uptimeS);
  return isFinite(n) && n >= 0 && n < AMOSTRA_CEDO_S;
}

export function origemOf(map: any, key: string): string | null {
  let o: any;
  if (!isObject(map) || !key) return null;
  o = map._origem;
  if (!isObject(o)) return null;
  if (o[key] === 'duravel' || o[key] === 'amostra' || o[key] === 'naomedido') return o[key];
  return null;
}

export function origemTitle(kind: string | null, uptimeS: any): string {
  if (kind === 'duravel') return 'Persistente (L1/L2 ou fila durável)';
  if (kind === 'amostra') {
    return isAmostraCedo(uptimeS)
      ? 'Amostra deste processo (uptime baixo; pode subcontar o L2)'
      : 'Amostra deste processo (≠ L1/L2)';
  }
  if (kind === 'naomedido') return 'Ainda não medido neste processo';
  return '';
}

export function origemValue(value: any, kind: string | null): string {
  // Fail-open: sem _origem o número antigo continua; só naomedido vira "—".
  if (kind === 'naomedido') return '—';
  return valueText(value);
}

export function setFeedback(text: string, kind?: string): void {
  const node = $('feedback');
  node.className = 'feedback' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
}

export function setConnection(state: string, text: string): void {
  const node = $('connection');
  let cls = 'connection';
  if (state && state !== 'unknown') {
    cls += ' ' + (state === 'error' ? 'error' : state === 'warn' ? 'warn' : state === 'syncing' ? 'syncing' : 'online');
  }
  node.className = cls;
  $('connectionText').textContent = text;
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = extra || {};
  for (const key of Object.keys(source)) headers[key] = source[key];
  if (DashState.token) headers['X-Indexer-Test-Token'] = DashState.token;
  return headers;
}

// Segmento de config em que a página foi aberta ("" na raiz, "/abc123" numa
// install URL). Sem isto o painel sempre perguntaria pela conta do .env,
// mesmo aberto a partir da instalação do usuário.
export function basePrefix(): string {
  const match = String(window.location.pathname || '').match(/^\/(.+)\/dashboard\/?$/);
  return match ? '/' + match[1] : '';
}

export function requestJson(url: string, options?: any): Promise<any> {
  const request: any = options || {};
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  request.headers = authHeaders(request.headers);
  if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
    request.signal = controller.signal;
    timeoutId = setTimeout(() => {
      try { controller!.abort(); } catch (e) { /* abort em corrida é esperado */ }
    }, 10000);
  }
  return fetch(basePrefix() + url, request).then((response) => {
    if (timeoutId) clearTimeout(timeoutId);
    return response.json().then((data: any) => {
      if (!response.ok) {
        // `fix` das ações aponta o conserto (ex.: aba Conta do Colhedor sem
        // conta de operador); o campo já viaja na mensagem do erro (abaixo),
        // então o operador vê a instrução sem leitor adicional.
        const fix = data && data.fix;
        const message = ((data && (data.error || data.message)) || 'HTTP ' + response.status) + (fix ? ' — ' + fix : '');
        const error: any = new Error(message);
        error.status = response.status;
        throw error;
      }
      return data;
    });
  }, (err) => {
    if (timeoutId) clearTimeout(timeoutId);
    throw err;
  });
}

export function readStored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch (error) { return null; }
}

export function writeStored(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch (error) { /* storage bloqueado não impede o dashboard */ }
}

export function seriesKey(name: string): string {
  return 'adom.dashboard.series.' + name;
}

export function pushSeries(name: string, value: any): number[] {
  let values: number[];
  let parsed: any;
  if (!isFinite(Number(value))) return [];
  try { parsed = JSON.parse(readStored(seriesKey(name)) || '[]'); } catch (error) { parsed = []; }
  values = Array.isArray(parsed) ? parsed : [];
  values.push(Number(value));
  values = values.slice(-120);
  writeStored(seriesKey(name), JSON.stringify(values));
  return values;
}

export function removeStored(key: string): void {
  try { window.localStorage.removeItem(key); } catch (error) { /* storage bloqueado não impede o dashboard */ }
}
