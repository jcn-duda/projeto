import type { ResolverCache, ResolverCacheEntry } from './types.js';

/** Opções do cache: um `inFlight` compartilhado entre instâncias irmãs. */
export interface ResolverCacheOptions {
  inFlight?: Map<string, Promise<unknown>>;
}

/**
 * options.inFlight é OPCIONAL (retrocompatível): permite compartilhar UM único
 * mapa de coalescing entre várias instâncias de cache. Os perfis que expõem
 * post/search/magnetCache precisam de um único `inFlight` — é o shape que
 * testes e harnesses consomem (limpam e contam `mod.inFlight` diretamente).
 *
 * O retorno expõe `values` — o Map real, que cada perfil publica como
 * postCache/searchCache/magnetCache. NÃO existe um objeto-fachada com
 * get/set/has próprios: o contrato antigo do .d.ts descrevia um Map e era isso
 * mesmo, só que agora explicitado no tipo compartilhado.
 *
 * `cached` é genérico no valor do loader (`R`) para o tipo fluir até quem
 * consome (`getPostLinks` devolve o objeto do loader, não `unknown`). O Map
 * apaga o tipo por chave; as duas recuperações abaixo leem de volta o valor
 * que o próprio loader gravou — não são cast de contrato externo.
 */
function createCache(limit: number, options: ResolverCacheOptions = {}) {
  const values: ResolverCache = new Map();
  const inFlight: Map<string, Promise<unknown>> = options.inFlight || new Map();
  async function cached<R>(key: string, ttl: number, loader: () => R | Promise<R>): Promise<R> {
    const hit: ResolverCacheEntry | undefined = values.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as R;
    if (hit) values.delete(key);
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<R>;
    const task = Promise.resolve().then(loader).then((value) => {
      values.set(key, { value, expiresAt: Date.now() + ttl });
      const oldest = values.keys().next().value;
      if (values.size > limit && oldest !== undefined) values.delete(oldest);
      return value;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  }
  return { values, inFlight, cached, clear: () => values.clear() };
}

export { createCache };
