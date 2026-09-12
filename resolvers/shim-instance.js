'use strict';

// Instância lazy para os shims `<nome>-resolver/server.js`.
//
// O import do shim deixa de ler process.env (e de abrir porta): a instância só
// nasce na PRIMEIRA leitura de uma propriedade. Com isso a ordem de import em
// relação ao `src/config.js` (que carrega o dotenv) deixa de importar — quando
// o consumidor acessa o resolver, o ambiente do operador já foi carregado.
// O modo standalone constrói explicitamente no `require.main === module`.
function createLazyInstance(build) {
  let instance = null;
  const resolve = () => {
    if (!instance) instance = build();
    return instance;
  };
  return new Proxy({}, {
    get(_target, prop) { return resolve()[prop]; },
    set(_target, prop, value) { resolve()[prop] = value; return true; },
    has(_target, prop) { return prop in resolve(); },
    ownKeys() { return Reflect.ownKeys(resolve()); },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(resolve(), prop);
    },
  });
}

module.exports = { createLazyInstance };
