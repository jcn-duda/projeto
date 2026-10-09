/* Helper dos testes do cliente ESM de /configure.
 *
 * O cliente é emitido duas vezes: no browser (dist/src/public/client, ESM
 * nativo) e no Node (dist/src/client, NodeNext) só para os testes. Aqui a
 * gente importa o emit de Node por import DINÂMICO com URL montada em runtime:
 * o tsconfig raiz exclui src/client e um import estático puxaria o fonte para
 * dentro do programa do servidor, anulando o segundo emit.
 *
 * O DOM falso nasce dos IDs reais do configure.html e cobre só os métodos que
 * os módulos usam (getElementById/createElement/querySelector(All) por classe,
 * atributos, listeners). Assim o teste exercita o módulo de verdade, sem
 * `new Function` e sem regex de corpo de função. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/test/helpers -> dist/src/client/configure (emit NodeNext).
const CLIENT_DIR = new URL('../../src/client/configure/', import.meta.url);

export const CONFIGURE_HTML_PATH = path.join(__dirname, '..', '..', 'src', 'public', 'configure.html');

export function configureHtml(): string {
  return fs.readFileSync(CONFIGURE_HTML_PATH, 'utf8');
}

export class FakeElement {
  tagName: string;
  attrs: Record<string, string> = {};
  className = '';
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  // `value` coage para string como o DOM real: `el.maxResults.value = 40`
  // vira '40', e as comparações do collect com '0'/'100' continuam válidas.
  private rawValue = '';
  get value(): string { return this.rawValue; }
  set value(v: any) { this.rawValue = v == null ? '' : String(v); }
  hidden = false;
  disabled = false;
  href = '';
  type = '';
  style: Record<string, string> = {};
  private text = '';
  private readonly listeners: Record<string, Array<(ev: any) => void>> = {};

  constructor(tag: string) {
    this.tagName = tag;
  }

  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; this.children = []; }

  setAttribute(key: string, value: any): void {
    this.attrs[key] = String(value);
    if (key === 'class') this.className = String(value);
  }

  getAttribute(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
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

  dispatch(type: string, extra: Record<string, any> = {}): void {
    const event = { stopPropagation() {}, preventDefault() {}, target: this, ...extra };
    (this.listeners[type] || []).slice().forEach((fn) => fn(event));
  }

  focus(): void { /* no-op */ }
  select(): void { /* no-op */ }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (matchesClass(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function matchesClass(el: FakeElement, selector: string): boolean {
  if (!selector.startsWith('.')) return false;
  return (' ' + el.className + ' ').includes(' ' + selector.slice(1) + ' ');
}

export interface FakeDom {
  document: any;
  byId: Record<string, FakeElement>;
  cleanup(): void;
}

/** Instala document/location/navigator globais a partir dos IDs do HTML. */
export function installConfigureDom(html?: string): FakeDom {
  const source = html ?? configureHtml();
  const byId: Record<string, FakeElement> = {};
  for (const match of source.matchAll(/\bid="([^"]+)"/g)) byId[match[1]] = new FakeElement('div');
  // Repovoa com o MARKUP real: cada tag relevante vira o elemento com classe e
  // atributos (role/aria-checked/data-*), e os presets/chips estáticos entram
  // nos containers que o cliente consulta. Sem isso o clique de preset/chip
  // não teria nem alvo nem ancestral para o ancestorWithClass.
  for (const tag of source.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of tag[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
    const classes = (attrs.class || '').split(/\s+/);
    if (!attrs.id && !attrs['data-preset'] && !classes.includes('chip')) continue;
    const element = new FakeElement(tag[1].toLowerCase());
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    if (attrs.id) byId[attrs.id] = element;
    else if (attrs['data-preset'] && byId.presets) byId.presets.appendChild(element);
    else if (classes.includes('chip') && byId.qualities) byId.qualities.appendChild(element);
  }
  const body = new FakeElement('body');
  const fakeDocument: any = {
    title: '',
    body,
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => byId[id] || null,
    execCommand: () => true,
  };
  const previous = {
    document: (globalThis as any).document,
    location: (globalThis as any).location,
    navigator: (globalThis as any).navigator,
  };
  // `navigator` é getter no globalThis do Node; atribuição direta lança. O
  // defineProperty sobrescreve e o cleanup restaura (ou apaga) cada global.
  const define = (key: string, value: any) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define('document', fakeDocument);
  define('location', { origin: 'http://localhost:7000', pathname: '/configure' });
  define('navigator', { clipboard: { writeText: () => Promise.resolve() } });
  return {
    document: fakeDocument,
    byId,
    cleanup() {
      for (const key of ['document', 'location', 'navigator'] as const) {
        if (previous[key] === undefined) delete (globalThis as any)[key];
        else define(key, previous[key]);
      }
    },
  };
}

export interface ClientModules {
  state: any;
  dom: any;
  keys: any;
  limits: any;
  indexers: any;
  view: any;
  seal: any;
  init: any;
}

let cached: ClientModules | null = null;

export async function loadClientModules(): Promise<ClientModules> {
  if (!cached) {
    cached = {
      state: await import(new URL('state.js', CLIENT_DIR).href),
      dom: await import(new URL('dom.js', CLIENT_DIR).href),
      keys: await import(new URL('keys.js', CLIENT_DIR).href),
      limits: await import(new URL('limits.js', CLIENT_DIR).href),
      indexers: await import(new URL('indexers.js', CLIENT_DIR).href),
      view: await import(new URL('view.js', CLIENT_DIR).href),
      seal: await import(new URL('seal.js', CLIENT_DIR).href),
      init: await import(new URL('init.js', CLIENT_DIR).href),
    };
  }
  return cached;
}

/** DOM limpo + estado zerado + elementos ligados; pronto para exercitar. */
export async function resetClientEnvironment(html?: string): Promise<{ dom: FakeDom; mods: ClientModules }> {
  const dom = installConfigureDom(html);
  const mods = await loadClientModules();
  mods.state.resetConfigureState();
  mods.dom.bindElements();
  return { dom, mods };
}

export { FakeElement as Element };
