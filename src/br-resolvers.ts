import type { Server } from 'node:http';
import * as log from './utils/logger.js';
import config from './config.js';
import { createResolver as createBludvResolver } from '../resolvers/profiles/bludv.js';
import { createResolver as createComandotorrentsResolver } from '../resolvers/profiles/comandotorrents.js';
import { createResolver as createNerdfilmesResolver } from '../resolvers/profiles/nerdfilmes.js';
import { createResolver as createTorrentdosfilmesResolver } from '../resolvers/profiles/torrentdosfilmes.js';
import { createResolver as createVacatorrentResolver } from '../resolvers/profiles/vacatorrent.js';
import { createResolver as createRedetorrentResolver } from '../resolvers/profiles/redetorrent.js';
import { createResolver as createApachetorrentResolver } from '../resolvers/profiles/apachetorrent.js';
import { createResolver as createHdrtorrentsResolver } from '../resolvers/profiles/hdrtorrents.js';

/**
 * Carrega os resolvedores BR dentro do processo do addon.
 *
 * Cada um era um container só pra subir um servidor HTTP de ~200 linhas. Eles
 * continuam ouvindo nas mesmas portas (8700-8706) — o Jackett segue chamando
 * por HTTP, só que agora o host é o próprio addon.
 *
 * Cada profile é importado ESTATICAMENTE (ESM nativo, sem createRequire) e
 * expõe uma factory que recebe a configuração explícita. O addon constrói cada
 * instância com a própria porta/selfUrl/siteUrl e a lista de protetores extras
 * dos controls — cada instance carrega os próprios caches e seletores, sem
 * estado global de módulo. Falha de listen (EADDRINUSE/EACCES) é confinada ao
 * resolver pelo handler de 'error'; um resolver caído não derruba os outros.
 */

/** Contrato mínimo que o carregador consome de cada profile. */
type ResolverProfileModule = {
  createResolver(overrides: {
    port: number;
    selfUrl: string;
    siteUrl?: string;
    extraProtectors: string[];
  }): ResolverInstance;
};

/** Superfície da instância usada aqui: subir servidor e ler o domínio ativo. */
type ResolverInstance = {
  createServer?: () => Server;
  siteSelector?: { url?: () => string };
};

type ResolverEntry = ResolverProfileModule & {
  name: string;
  port: number;
  siteEnv: string;
  siteUrl: string;
};

const RESOLVERS: ResolverEntry[] = [
  { name: 'bludv', createResolver: createBludvResolver, port: config.resolvers.ports.bludv, siteEnv: 'BLUDV_URL', siteUrl: config.resolvers.bludvUrl },
  { name: 'comandotorrents', createResolver: createComandotorrentsResolver, port: config.resolvers.ports.comandotorrents, siteEnv: 'COMANDOTORRENTS_URL', siteUrl: config.resolvers.comandotorrentsUrl },
  { name: 'nerdfilmes', createResolver: createNerdfilmesResolver, port: config.resolvers.ports.nerdfilmes, siteEnv: 'NERDFILMES_URL', siteUrl: config.resolvers.nerdfilmesUrl },
  { name: 'torrentdosfilmes', createResolver: createTorrentdosfilmesResolver, port: config.resolvers.ports.torrentdosfilmes, siteEnv: 'TORRENTDOSFILMES_URL', siteUrl: config.resolvers.torrentdosfilmesUrl },
  { name: 'vacatorrent', createResolver: createVacatorrentResolver, port: config.resolvers.ports.vacatorrent, siteEnv: 'VACATORRENT_URL', siteUrl: config.resolvers.vacatorrentUrl },
  { name: 'redetorrent', createResolver: createRedetorrentResolver, port: config.resolvers.ports.redetorrent, siteEnv: 'REDETORRENT_URL', siteUrl: config.resolvers.redetorrentUrl },
  { name: 'apachetorrent', createResolver: createApachetorrentResolver, port: config.resolvers.ports.apachetorrent, siteEnv: 'APACHETORRENT_URL', siteUrl: config.resolvers.apachetorrentUrl },
  { name: 'hdrtorrents', createResolver: createHdrtorrentsResolver, port: config.resolvers.ports.hdrtorrents, siteEnv: 'HDRTORRENTS_URL', siteUrl: config.resolvers.hdrtorrentsUrl },
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

  const { host, portOffset, extraProtectors } = controls;
  const loaded: string[] = [];

  for (const resolver of RESOLVERS) {
    const port = resolver.port + portOffset;
    try {
      // Cada profile recebe a configuração explícita completa: porta própria,
      // selfUrl do host atual, o site da config e a lista de protetores extras
      // deliberada nos controls. Env AUSENTE cai no default de config.ts — não
      // no default hardcoded do profile. Enquanto o default hardcoded vencia,
      // trocar o domínio derrubado em config.ts não tinha efeito nenhum no modo
      // embutido (que é o padrão): a fonte seguia batendo no host morto.
      const instance = resolver.createResolver({
        port,
        selfUrl: `http://${host}:${port}`,
        siteUrl: resolver.siteUrl || undefined,
        extraProtectors,
      });
      // Os sete expõem createServer e só sobem sozinhos quando são o processo
      // principal — aqui o addon abre a porta no lugar deles.
      if (typeof instance?.createServer === 'function') {
        const server = instance.createServer();
        // listen() é assíncrono: EADDRINUSE/EACCES chegam como evento 'error'
        // depois do load() ter retornado. Sem handler, um resolver que não
        // sobe vira uncaughtException e o restart-loop derruba a stack inteira.
        // O handler confina a falha ao próprio resolver; os outros seis (e o
        // addon) seguem de pé, e o probe do painel reporta o que subiu.
        server.on('error', (err: any) => {
          log.warn(`[br] resolvedor ${resolver.name} não subiu na porta ${port}:`, err?.message || err);
        });
        server.listen(port, '0.0.0.0');
        servers.push(server);
      }
      modules.set(resolver.name, instance);
      loaded.push(`${resolver.name}:${port}`);
    } catch (err: any) {
      // Isolamento de falha por resolvedor: um profile quebrado não derruba os
      // outros seis nem a inicialização do addon.
      log.warn(`[br] falha ao carregar o resolvedor ${resolver.name}:`, err.message);
    }
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
 *   mesmo marcador que os sete perfis renderizam, estável entre eles.
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

/** Versão assíncrona do close(): espera todas as portas serem liberadas. */
async function closeAsync() {
  const pending = servers.splice(0).map((server) => new Promise<void>((resolve) => {
    try {
      server.closeIdleConnections?.();
      server.close(() => resolve());
    } catch (err) {
      log.warn('[br] falha ao fechar resolvedor embutido:', err.message);
      resolve();
    }
  }));
  await Promise.all(pending);
}

export { load, close, closeAsync, activeSite, probe, RESOLVERS };
