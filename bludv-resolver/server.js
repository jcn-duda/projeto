// Shim de compatibilidade: preserva o caminho histórico de import
// (`<nome>-resolver/server`) para testes e consumidores. O profile é import-safe
// (não lê env no topo); a instância nasce lazy na primeira leitura e o modo
// standalone constrói explicitamente no ponto de entrada.
const { createLazyInstance } = require('../resolvers/shim-instance');
const profile = require('../resolvers/profiles/bludv');

const resolver = createLazyInstance(() => profile.createResolver());

if (require.main === module) {
  const instance = profile.createResolver();
  instance.serveMain(instance.createServer);
}

module.exports = resolver;
