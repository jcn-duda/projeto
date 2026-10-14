// Instância lazy para os shims `<nome>-resolver/server`.
//
// O import do shim deixa de ler process.env (e de abrir porta): a instância só
// nasce na PRIMEIRA leitura de uma propriedade. Com isso a ordem de import em
// relação ao `src/config.js` (que carrega o dotenv) deixa de importar — quando
// o consumidor acessa o resolver, o ambiente do operador já foi carregado.
// O modo standalone constrói explicitamente após `isMain(import.meta.url)`.
//
// Toda a dinâmica do Proxy vive AQUI; os seis shims apenas chamam a factory.
// A única assertion da conversão está concentrada abaixo, na fronteira
// dinâmica, com a justificativa.
function createLazyInstance<T extends object>(build: () => T): T {
  let instance: T | null = null;
  const resolve = (): T => {
    if (!instance) instance = build();
    return instance;
  };

  const handler: ProxyHandler<T> = {
    get(_target, prop) { return Reflect.get(resolve(), prop); },
    set(_target, prop, value) { return Reflect.set(resolve(), prop, value); },
    has(_target, prop) { return Reflect.has(resolve(), prop); },
    ownKeys() { return Reflect.ownKeys(resolve()); },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(resolve(), prop);
    },
  };

  // Fronteira dinâmica: um Proxy precisa de um alvo-objeto real, mas NENHUMA
  // operação é servida por ele — o handler encaminha get/set/has/ownKeys/
  // getOwnPropertyDescriptor para a instância viva. `{} as T` é a única
  // assertion; os consumidores recebem `T` e não precisam de cast algum.
  return new Proxy({} as T, handler);
}

export { createLazyInstance };
