// Shim de compatibilidade: preserva o caminho histórico de import
// (`<nome>-resolver/server`) para testes e consumidores. O profile é import-safe
// (não lê env no topo); a instância nasce lazy na primeira leitura e o modo
// standalone constrói explicitamente no ponto de entrada.
import { createLazyInstance } from '../resolvers/shim-instance.js';
import { createResolver } from '../resolvers/profiles/bludv.js';
import { isMain } from '../resolvers/is-main.js';

const resolver = createLazyInstance(() => createResolver());

if (isMain(import.meta.url)) {
  const instance = createResolver();
  instance.serveMain(instance.createServer);
}

export default resolver;
