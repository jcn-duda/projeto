import * as runtime from '../../src/runtime.js';

/**
 * Chamada capturada pelo dublê de fetch, com o url já normalizado para string
 * (o fetch aceita URL/Request, e as assertivas comparam contra string).
 */
export interface FetchCall {
  url: string;
  /** Options como chegaram ao fetch. Fica solto de propósito: os testes leem
   * campos que o `RequestInit` do DOM não declara (ex.: `timeoutMs` nos
   * adaptadores de debrid) e apertar o tipo empurraria um cast para dentro de
   * cada assertiva. */
  options?: any;
}

/**
 * Resposta mínima que o código sob teste consome do fetch: `ok` decide o
 * ramo, `json` entrega o corpo e `status` alimenta a mensagem de erro. O
 * contrato real entre teste e código é este objeto parcial — um `Response`
 * completo nunca é exercitado.
 */
export interface FetchResponse {
  ok: boolean;
  status?: number;
  json?(): Promise<unknown>;
  text?(): Promise<string>;
}

/** Quem responde por uma chamada do dublê. */
export type StubFetchHandler = (
  url: string,
  options?: RequestInit,
) => FetchResponse | Promise<FetchResponse>;

export interface FetchStub {
  calls: FetchCall[];
  restore(): void;
}

/**
 * Substitui `global.fetch` por um dublê que captura as chamadas e delega a
 * resposta ao `handler`. O cast para o tipo de DOM mora AQUI, uma vez: a
 * atribuição ao global exige `Response`, mas o valor real é o objeto parcial
 * do `FetchResponse` — sem o cast, todo teste que dubla o fetch teria que
 * repetir a mentira na própria cara. O intermediário `unknown` existe porque
 * o parcial não é comparável a `Response` em nenhuma direção (TS2352).
 */
export function stubFetch(handler: StubFetchHandler): FetchStub {
  const calls: FetchCall[] = [];
  const original = global.fetch;
  global.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, options: init });
    return handler(url, init) as unknown as Response;
  };
  return {
    calls,
    restore() {
      global.fetch = original;
    },
  };
}

/**
 * Troca temporariamente `mod[key]` pela implementação dada e devolve o
 * restaurador — o `finally` esquecido é o bug clássico dos dublês por
 * atribuição de módulo (um `checkCached` de teste vazava para o próximo).
 */
export function patch<T extends object, K extends keyof T>(mod: T, key: K, impl: T[K]): () => void {
  const original = mod[key];
  mod[key] = impl;
  return () => {
    mod[key] = original;
  };
}

/**
 * Opções de usuário completas (defaults do runtime + overrides parciais),
 * sem o spread manual que todo teste repetia. O retorno é o tipo mesclado:
 * propriedade não overrideada herda o tipo do default.
 */
export function testOpts<T extends object>(overrides: T) {
  return { ...runtime.defaults(), ...overrides };
}