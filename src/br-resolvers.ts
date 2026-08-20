import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import * as log from './utils/logger.js';

const _require = createRequire(import.meta.url);

/**
 * Carrega os resolvedores BR dentro do processo do addon.
 *
 * Cada um era um container só pra subir um servidor HTTP de ~200 linhas. Eles
 * continuam ouvindo nas mesmas portas (8700-8703) — o Jackett segue chamando
 * por HTTP, só que agora o host é o próprio addon.
 *
 * O cuidado necessário: os quatro leem PORT, SELF_URL e SITE_URL do ambiente
 * com os MESMOS nomes, e leem no momento do require. Por isso cada um é
 * carregado com o ambiente ajustado para ele, restaurado logo depois — senão
 * todos herdariam a PORT=7000 do addon e brigariam pela mesma porta.
 */

const RESOLVERS = [
  { name: 'bludv', path: '../bludv-resolver/server', port: 8700, siteEnv: 'BLUDV_URL' },
  { name: 'comandotorrents', path: '../comandotorrents-resolver/server', port: 8701, siteEnv: 'COMANDOTORRENTS_URL' },
  { name: 'nerdfilmes', path: '../nerdfilmes-resolver/server', port: 8702, siteEnv: 'NERDFILMES_URL' },
  { name: 'torrentdosfilmes', path: '../torrentdosfilmes-resolver/server', port: 8703, siteEnv: 'TORRENTDOSFILMES_URL' },
];
const servers: Server[] = [];

function load() {
  if (String(process.env.BR_RESOLVERS_EMBEDDED || 'true') !== 'true') {
    log.info('[br] resolvedores embutidos desligados; esperando os containers separados');
    return;
  }

  const saved = {
    PORT: process.env.PORT,
    SELF_URL: process.env.SELF_URL,
    SITE_URL: process.env.SITE_URL,
    BLUDV_URL: process.env.BLUDV_URL,
  };
  const host = process.env.BR_RESOLVERS_HOST || 'addon';
  const portOffset = Number(process.env.BR_RESOLVERS_PORT_OFFSET || 0) || 0;
  const loaded: string[] = [];

  for (const resolver of RESOLVERS) {
    const port = resolver.port + portOffset;
    process.env.PORT = String(port);
    process.env.SELF_URL = `http://${host}:${port}`;

    // Injeta a URL do site específico no SITE_URL para o módulo filho
    if (resolver.siteEnv && process.env[resolver.siteEnv]) {
      process.env.SITE_URL = process.env[resolver.siteEnv];
      if (resolver.name === 'bludv') {
        process.env.BLUDV_URL = process.env[resolver.siteEnv];
      }
    } else {
      delete process.env.SITE_URL;
    }

    try {
      const mod = _require(resolver.path);
      // Os quatro exportam `createServer` e só sobem sozinhos quando são o
      // processo principal — assim o parser deles pode ser exercitado em teste
      // sem abrir porta. O fallback continua aqui para o caso de um resolvedor
      // voltar a ouvir no require.
      if (typeof mod?.createServer === 'function') {
        const server = mod.createServer().listen(port, '0.0.0.0');
        servers.push(server);
      }
      loaded.push(`${resolver.name}:${port}`);
    } catch (err) {
      log.warn(`[br] falha ao carregar o resolvedor ${resolver.name}:`, err.message);
    }
  }

  // Restaura o ambiente do processo principal com segurança
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  if (loaded.length) log.info(`[br] resolvedores embutidos: ${loaded.join(', ')}`);
}

/** Fecha sockets embutidos antes do processo sair; seguro para chamadas repetidas. */
function close() {
  for (const server of servers.splice(0)) {
    try {
      server.closeIdleConnections?.();
      server.close();
    } catch (err) {
      log.warn('[br] falha ao fechar resolvedor embutido:', err.message);
    }
  }
}

export { load, close, RESOLVERS };
