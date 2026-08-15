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
const log = require('./utils/logger');

const RESOLVERS = [
  { name: 'bludv', path: '../bludv-resolver/server', port: 8700, siteEnv: 'BLUDV_URL' },
  { name: 'comandotorrents', path: '../comandotorrents-resolver/server', port: 8701, siteEnv: 'COMANDOTORRENTS_URL' },
  { name: 'nerdfilmes', path: '../nerdfilmes-resolver/server', port: 8702, siteEnv: 'NERDFILMES_URL' },
  { name: 'torrentdosfilmes', path: '../torrentdosfilmes-resolver/server', port: 8703, siteEnv: 'TORRENTDOSFILMES_URL' },
];

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
  const loaded = [];

  for (const resolver of RESOLVERS) {
    process.env.PORT = String(resolver.port);
    process.env.SELF_URL = `http://${host}:${resolver.port}`;

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
      const mod = require(resolver.path);
      // Os quatro exportam `createServer` e só sobem sozinhos quando são o
      // processo principal — assim o parser deles pode ser exercitado em teste
      // sem abrir porta. O fallback continua aqui para o caso de um resolvedor
      // voltar a ouvir no require.
      if (typeof mod?.createServer === 'function') {
        mod.createServer().listen(resolver.port, '0.0.0.0');
      }
      loaded.push(`${resolver.name}:${resolver.port}`);
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

module.exports = { load, RESOLVERS };
