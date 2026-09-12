/* DOM falso dos testes do cliente ESM de /dashboard (C3).
 *
 * Cobre o que os módulos usam: getElementById/createElement/querySelector(All)
 * por classe/tag/#id, atributos, listeners, style, value. `getElementById` é
 * ESTRITO: id que o HTML não define (e o teste não criou com element()) devolve
 * null — é assim que o teste estático "ids referenciados ⊆ ids do dashboard.html"
 * ganha valor. Importar o grafo real não toca o DOM; o entry é o único que roda
 * bind() no import.
 *
 * O `installDashboardDom` pré-cria um nó por id do HTML e registra as tags com
 * .action-button/.section-toggle, para o boot achar os alvos sem montar a árvore
 * inteira. Timers criados com este DOM são rastreados e limpos no cleanup (o
 * setInterval do boot manteria o processo de teste vivo).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DASHBOARD_HTML_PATH = path.join(__dirname, '..', '..', 'src', 'public', 'dashboard.html');

export function dashboardHtml(): string {
  return fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
}

export class FakeElement {
  tagName: string;
  id = '';
  className = '';
  attrs: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  style: Record<string, any> = {};
  hidden = false;
  disabled = false;
  checked = false;
  selected = false;
  href = '';
  type = '';
  offsetTop = 0;
  width = 100;
  height = 24;
  scrolled = false;
  private rawValue = '';
  private text = '';
  private readonly listeners: Record<string, Array<(ev: any) => void>> = {};

  constructor(tag: string) { this.tagName = tag.toLowerCase(); }

  get value(): string { return this.rawValue; }
  set value(v: any) { this.rawValue = v == null ? '' : String(v); }

  // title reflete o atributo (como no DOM real): removeAttribute('title') zera.
  get title(): string { return this.attrs.title ?? ''; }
  set title(v: any) { this.attrs.title = String(v ?? ''); }

  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v == null ? '' : String(v); this.children = []; }

  setAttribute(key: string, value: any): void {
    this.attrs[key] = String(value);
    if (key === 'class') this.className = String(value);
    if (key === 'id') this.id = String(value);
  }

  getAttribute(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }

  hasAttribute(key: string): boolean { return Object.prototype.hasOwnProperty.call(this.attrs, key); }

  removeAttribute(key: string): void {
    delete this.attrs[key];
    if (key === 'class') this.className = '';
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }

  addEventListener(type: string, fn: (ev: any) => void): void {
    (this.listeners[type] ||= []).push(fn);
  }

  removeEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }

  dispatch(type: string, extra: Record<string, any> = {}): void {
    const event = { stopPropagation() {}, preventDefault() {}, target: this, currentTarget: this, ...extra };
    (this.listeners[type] || []).slice().forEach((fn) => fn(event));
  }

  focus(): void { /* no-op */ }
  select(): void { /* no-op */ }
  scrollIntoView(): void { this.scrolled = true; }

  hasClass(name: string): boolean { return (' ' + this.className + ' ').includes(' ' + name + ' '); }

  closest(selector: string): FakeElement | null {
    let el: FakeElement | null = this;
    while (el) {
      if (matchesPart(el, selector)) return el;
      el = el.parentNode;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return queryAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return queryAll(this, selector);
  }
}

function matchesPart(el: FakeElement, part: string): boolean {
  if (!part) return false;
  if (part.startsWith('#')) return el.id === part.slice(1);
  if (part.startsWith('.')) return el.hasClass(part.slice(1));
  return el.tagName === part.toLowerCase();
}

function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (node: FakeElement) => {
    for (const child of node.children) { out.push(child); walk(child); }
  };
  walk(root);
  return out;
}

/** Selector limitado ao que o dashboard usa: partes simples (tag/#id/.classe)
 * separadas por espaço (descendência) e por vírgula (união). */
function queryAll(root: FakeElement, selector: string): FakeElement[] {
  const partsList = selector.split(',').map((s) => s.trim().split(/\s+/).filter(Boolean));
  const result: FakeElement[] = [];
  for (const parts of partsList) {
    const last = parts[parts.length - 1];
    for (const candidate of descendants(root)) {
      if (!matchesPart(candidate, last)) continue;
      let ok = true;
      let node: FakeElement | null = candidate.parentNode;
      for (let i = parts.length - 2; i >= 0; i -= 1) {
        while (node && !matchesPart(node, parts[i])) node = node.parentNode;
        if (!node) { ok = false; break; }
        node = node.parentNode;
      }
      if (ok) result.push(candidate);
    }
  }
  return result;
}

export interface FakeDom {
  document: any;
  window: any;
  body: FakeElement;
  byId: Record<string, FakeElement>;
  /** Cria/obtém um nó por id e o anexa ao body (para o querySelectorAll vê-lo). */
  element(id: string): FakeElement;
  attach(parent: FakeElement, tag: string, attrs?: Record<string, any>): FakeElement;
  setFetch(fn: (url: string, init?: any) => Promise<any>): void;
  cleanup(): void;
}

/** Instala document/window/fetch globais e devolve o DOM falso. Sem HTML o DOM
 * nasce vazio e `getElementById` devolve null até o teste criar o nó. */
export function installDashboardDom(html = ''): FakeDom {
  const body = new FakeElement('body');
  const htmlRoot = new FakeElement('html');
  htmlRoot.appendChild(body);
  const byId: Record<string, FakeElement> = {};

  const element = (id: string): FakeElement => {
    if (!byId[id]) { byId[id] = new FakeElement('div'); byId[id].id = id; body.appendChild(byId[id]); }
    return byId[id];
  };

  // Pré-cria nós para todo id do HTML e registra tags com .action-button /
  // .section-toggle, para o boot achar os alvos sem montar a árvore inteira.
  if (html) {
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) element(match[1]);
    for (const tag of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
      const attrs: Record<string, string> = {};
      for (const attr of tag[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
      const classes = (attrs.class || '').split(/\s+/);
      if (!classes.includes('action-button') && !classes.includes('section-toggle')) continue;
      const node = new FakeElement(tag[1]);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      body.appendChild(node);
    }
  }

  const attach = (parent: FakeElement, tag: string, attrs: Record<string, any> = {}): FakeElement => {
    const node = new FakeElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (attrs.id) byId[attrs.id] = node;
    parent.appendChild(node);
    return node;
  };

  const fakeDocument: any = {
    title: '',
    hidden: false,
    body,
    documentElement: htmlRoot,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => ({ text, nodeType: 3 }),
    // Estrito de propósito: id ausente devolve null. Crie o nó com element().
    getElementById: (id: string) => byId[id] ?? null,
    querySelector: (selector: string) => queryAll(body, selector)[0] ?? null,
    querySelectorAll: (selector: string) => queryAll(body, selector),
    execCommand: () => true,
    addEventListener: () => {},
  };

  const storage = new Map<string, string>();
  const windowListeners: Record<string, Array<(ev: any) => void>> = {};
  const fakeWindow: any = {
    location: { origin: 'http://localhost:7000', pathname: '/dashboard', hash: '', search: '' },
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => { storage.set(k, String(v)); },
      removeItem: (k: string) => { storage.delete(k); },
    },
    confirm: () => true,
    pageYOffset: 0,
    addEventListener: (type: string, fn: (ev: any) => void) => { (windowListeners[type] ||= []).push(fn); },
    removeEventListener: (type: string, fn: (ev: any) => void) => { windowListeners[type] = (windowListeners[type] || []).filter((f) => f !== fn); },
    dispatch: (type: string, extra: Record<string, any> = {}) => {
      const event = { preventDefault() {}, target: fakeWindow, ...extra };
      (windowListeners[type] || []).slice().forEach((fn) => fn(event));
    },
  };

  const previous = {
    document: (globalThis as any).document,
    window: (globalThis as any).window,
    fetch: (globalThis as any).fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  // O boot agenda setInterval/setTimeout que manteriam o processo de teste vivo.
  // Rastreia os timers criados com este DOM e os limpa no cleanup.
  const activeTimers = new Set<any>();
  const trackInterval = (fn: any, ms?: number, ...args: any[]): any => {
    const id = (previous.setInterval as any)(fn, ms, ...args);
    activeTimers.add(id);
    return id;
  };
  const trackTimeout = (fn: any, ms?: number, ...args: any[]): any => {
    const id = (previous.setTimeout as any)(fn, ms, ...args);
    activeTimers.add(id);
    return id;
  };
  const define = (key: string, value: any) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define('document', fakeDocument);
  define('window', fakeWindow);
  define('fetch', () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
  define('setInterval', trackInterval);
  define('setTimeout', trackTimeout);
  define('clearInterval', (id: any) => { activeTimers.delete(id); return (previous.clearInterval as any)(id); });
  define('clearTimeout', (id: any) => { activeTimers.delete(id); return (previous.clearTimeout as any)(id); });

  return {
    document: fakeDocument,
    window: fakeWindow,
    body,
    byId,
    element,
    attach,
    setFetch(fn) { define('fetch', fn); },
    cleanup() {
      for (const id of activeTimers) {
        try { (previous.clearInterval as any)(id); } catch { /* já disparou */ }
        try { (previous.clearTimeout as any)(id); } catch { /* já disparou */ }
      }
      activeTimers.clear();
      for (const key of ['document', 'window', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const) {
        if (previous[key] === undefined) delete (globalThis as any)[key];
        else define(key, previous[key]);
      }
    },
  };
}
