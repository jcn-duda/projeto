import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import * as log from './utils/logger.js';
import config from './config.js';

const _require = createRequire(import.meta.url);

/**
 * Carrega os resolvedores BR dentro do processo do addon.
 *
 * Cada um era um container só pra subir um servidor HTTP de ~200 linhas. Eles
 * continuam ouvindo nas mesmas portas (8700-8704) — o Jackett segue chamando
 * por HTTP, só que agora o host é o próprio addon.
 *
 * O cuidado necessário: os cinco leem PORT, SELF_URL e SITE_URL do ambiente
 * com os MESMOS nomes, e leem no momento do require. Por isso cada um é
 * carregado com o ambiente ajustado para ele, restaurado logo depois — senão
 * todos herdariam a PORT=7000 do addon e brigariam pela mesma porta.
 */

const RESOLVERS = [
  { name: 'bludv', path: '../bludv-resolver/server', port: config.resolvers.ports.bludv, siteEnv: 'BLUDV_URL', siteUrl: config.resolvers.bludvUrl },
  { name: 'comandotorrents', path: '../comandotorrents-resolver/server', port: config.resolvers.ports.comandotorrents, siteEnv: 'COMANDOTORRENTS_URL', siteUrl: config.resolvers.comandotorrentsUrl },
  { name: 'nerdfilmes', path: '../nerdfilmes-resolver/server', port: config.resolvers.ports.nerdfilmes, siteEnv: 'NERDFILMES_URL', siteUrl: config.resolvers.nerdfilmesUrl },
  { name: 'torrentdosfilmes', path: '../torrentdosfilmes-resolver/server', port: config.resolvers.ports.torrentdosfilmes, siteEnv: 'TORRENTDOSFILMES_URL', siteUrl: config.resolvers.torrentdosfilmesUrl },
  { name: 'vacatorrent', path: '../vacatorrent-resolver/server', port: config.resolvers.ports.vacatorrent, siteEnv: 'VACATORRENT_URL', siteUrl: config.resolvers.vacatorrentUrl },
];
const servers: Server[] = [];
// Módulo carregado de cada resolvedor, para ler o domínio ATIVO deles depois
// (o failover troca de host em runtime; a env congelada no boot mente).
const modules = new Map<string, any>();

type ResolverControls = typeof config.resolvers;

function load(controls: ResolverControls = config.resolvers) {
  if (!controls.embedded) {
    log.info('[br] resolvedores embutidos desligados; esperando os containers separados');
    return;
  }

  const saved = {
    PORT: process.env.PORT,
    SELF_URL: process.env.SELF_URL,
    SITE_URL: process.env.SITE_URL,
    BLUDV_URL: process.env.BLUDV_URL,
  };
  const { host, portOffset } = controls;
  const loaded: string[] = [];

  for (const resolver of RESOLVERS) {
    const port = resolver.port + portOffset;
    process.env.PORT = String(port);
    process.env.SELF_URL = `http://${host}:${port}`;

    // Injeta a URL do site específico no SITE_URL para o módulo filho. Env
    // AUSENTE cai no default de config.ts -- e não mais no default hardcoded
    // dentro do server.js do resolvedor. Enquanto caía lá, trocar o domínio
    // derrubado em config.ts não tinha efeito nenhum no modo embutido (que é o
    // padrão): a fonte seguia batendo no host morto, em silêncio.
    const siteUrl = resolver.siteUrl;
    if (siteUrl) {
      process.env.SITE_URL = siteUrl;
      if (resolver.name === 'bludv') {
        process.env.BLUDV_URL = siteUrl;
      }
    } else {
      delete process.env.SITE_URL;
    }

    try {
      const mod = _require(resolver.path);
      // Os cinco exportam `createServer` e só sobem sozinhos quando são o
      // processo principal — assim o parser deles pode ser exercitado em teste
      // sem abrir porta. O fallback continua aqui para o caso de um resolvedor
      // voltar a ouvir no require.
      if (typeof mod?.createServer === 'function') {
        const server = mod.createServer().listen(port, '0.0.0.0');
        servers.push(server);
      }
      modules.set(resolver.name, mod);
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

/**
 * Domínio que o resolvedor está REALMENTE usando agora.
 *
 * O painel mostrava `process.env[siteEnv]`, que é null quando vale o default
 * e vira mentira assim que o failover de domínio troca o site em runtime --
 * justo no diagnóstico de "a fonte BR não responde", onde saber o host real é
 * a primeira pergunta. O seletor do resolvedor é a única fonte verdadeira;
 * env e default de config ficam como fallback do modo container separado.
 */
function activeSite(name: string): string | null {
  try {
    const url = modules.get(name)?.siteSelector?.url?.();
    if (url) return String(url);
  } catch {
    // Resolvedor sem seletor exposto: cai no configurado, abaixo.
  }
  const resolver = RESOLVERS.find((item) => item.name === name);
  if (!resolver) return null;
  return resolver.siteUrl || null;
}

/** Resultado do teste direto de um resolvedor; `error` só vem quando falhou. */
type ResolverProbe = {
  resolver: string;
  ok: boolean;
  results: number | null;
  ms: number;
  error: string | null;
  host: string | null;
};

/**
 * Teste DIRETO do resolvedor: repete o mesmo caminho que o card Cardigann
 * percorre (GET /search?q= na porta local) sem passar pelo Jackett, para o
 * painel separar "o site caiu" de "o Jackett caiu".
 *
 * - Nome fora da lista devolve null (a rota responde 400).
 * - HTTP 200 é saudável e `results` conta as `class="release"` do HTML — o
 *   mesmo marcador que os cinco perfis renderizam, estável entre eles.
 * - Não-2xx volta ok:false com o corpo do erro truncado (máx 200 chars): é
 *   a mensagem original do perfil (ex.: 502 do /search), diagnosticável.
 * - Timeout e erro de rede NÃO lançam: diagnóstico é dado, não exceção — um
 *   resolvedor morto tem que aparecer como ok:false, não derrubar a rota.
 * - `host` é o domínio ATIVO do seletor (activeSite), não a env congelada.
 * - De propósito NÃO toca indexerStatus nem breaker do Jackett: medida
 *   avulsa do painel não pode abrir circuito nem pintar card de indexer.
 */
async function probe(name: string, query = ''): Promise<ResolverProbe | null> {
  const resolver = RESOLVERS.find((item) => item.name === name);
  if (!resolver) return null;
  const port = resolver.port + config.resolvers.portOffset;
  const host = activeSite(name);
  const url = `http://${config.resolvers.host}:${port}/search?q=${encodeURIComponent(query)}`;
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config.resolvers.probeTimeoutMs) });
    const body = await response.text();
    const ms = Date.now() - startedAt;
    if (response.status === 200) {
      return { resolver: name, ok: true, results: body.split('class="release"').length - 1, ms, error: null, host };
    }
    return { resolver: name, ok: false, results: null, ms, error: body.slice(0, 200), host };
  } catch (err: any) {
    const ms = Date.now() - startedAt;
    // AbortSignal.timeout nomeia o abort como TimeoutError; AbortError cobre
    // cancelamentos externos do mesmo signal.
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const message = timeout ? `timeout após ${ms}ms` : String(err?.message || err);
    return { resolver: name, ok: false, results: null, ms, error: message.slice(0, 200), host };
  }
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

export { load, close, activeSite, probe, RESOLVERS };
