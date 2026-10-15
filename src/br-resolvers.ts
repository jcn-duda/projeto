import * as log from './utils/logger.js';
import config from './config.js';

/**
 * Resolvedores BR: servidos pelo binário Rust `adom-resolvers` (portas
 * 8700-8707, as que os cards Cardigann do Jackett chamam). O entrypoint sobe e
 * supervisiona o binário; o addon não abre essas portas.
 *
 * Os profiles TypeScript saíram quando os oito sites passaram ao Rust (golden
 * e diff ao vivo iguais; a versão TS segue no branch `esm`). Aqui ficou o que
 * o painel e o diagnóstico usam: a lista de sites/portas, o domínio
 * configurado e o teste direto (`probe`).
 */

type ResolverEntry = {
  name: string;
  port: number;
  siteEnv: string;
  siteUrl: string;
};

const RESOLVERS: ResolverEntry[] = [
  { name: 'bludv', port: config.resolvers.ports.bludv, siteEnv: 'BLUDV_URL', siteUrl: config.resolvers.bludvUrl },
  { name: 'comandotorrents', port: config.resolvers.ports.comandotorrents, siteEnv: 'COMANDOTORRENTS_URL', siteUrl: config.resolvers.comandotorrentsUrl },
  { name: 'nerdfilmes', port: config.resolvers.ports.nerdfilmes, siteEnv: 'NERDFILMES_URL', siteUrl: config.resolvers.nerdfilmesUrl },
  { name: 'torrentdosfilmes', port: config.resolvers.ports.torrentdosfilmes, siteEnv: 'TORRENTDOSFILMES_URL', siteUrl: config.resolvers.torrentdosfilmesUrl },
  { name: 'vacatorrent', port: config.resolvers.ports.vacatorrent, siteEnv: 'VACATORRENT_URL', siteUrl: config.resolvers.vacatorrentUrl },
  { name: 'redetorrent', port: config.resolvers.ports.redetorrent, siteEnv: 'REDETORRENT_URL', siteUrl: config.resolvers.redetorrentUrl },
  { name: 'apachetorrent', port: config.resolvers.ports.apachetorrent, siteEnv: 'APACHETORRENT_URL', siteUrl: config.resolvers.apachetorrentUrl },
  { name: 'hdrtorrents', port: config.resolvers.ports.hdrtorrents, siteEnv: 'HDRTORRENTS_URL', siteUrl: config.resolvers.hdrtorrentsUrl },
];

/** Só registra quem atende as portas: o binário Rust sobe no entrypoint. */
function load() {
  const ports = RESOLVERS.map((r) => `${r.name}:${r.port + config.resolvers.portOffset}`).join(', ');
  log.info(`[br] resolvedores servidos pelo adom-resolvers (Rust): ${ports}`);
}

/**
 * Domínio configurado do resolvedor. O failover de domínio acontece dentro do
 * binário Rust; o painel mostra o configurado (env ou default de config.ts).
 */
function activeSite(name: string): string | null {
  const resolver = RESOLVERS.find((item) => item.name === name);
  return resolver?.siteUrl || null;
}

/**
 * Não há instância TS de resolvedor no processo: sempre `null`. Quem recebe
 * `null` (o provider do BLUDV) segue pelo fetch direto.
 */
function instance(_name: string): unknown {
  return null;
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
 * - HTTP 200 é saudável e `results` conta as `class="release"` do HTML.
 * - Não-2xx volta ok:false com o corpo do erro truncado (máx 200 chars).
 * - Timeout e erro de rede NÃO lançam: um resolvedor morto aparece como
 *   ok:false, não derruba a rota.
 * - De propósito NÃO toca indexerStatus nem breaker do Jackett.
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

/** Sem servidor no processo; mantidos para o desligamento do addon. */
function close() {}

async function closeAsync() {}

export { load, close, closeAsync, activeSite, instance, probe, RESOLVERS };
