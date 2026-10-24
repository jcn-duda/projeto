// Superfície direta de cada profile para a sonda. Sem `listen`: a CLI não
// disputa as portas 8700–8707 com o container. Import dinâmico no entry-point
// (depois de `CACHE_PERSIST=false`) — import estático aqui rodaria cedo demais.
import config from '../src/config.js';
import { createResolver as createVacaResolver } from '../resolvers/profiles/vacatorrent.js';
import { createResolver as createNerdfilmesResolver } from '../resolvers/profiles/nerdfilmes.js';
import { createResolver as createTorrentdosfilmesResolver } from '../resolvers/profiles/torrentdosfilmes.js';
import { createResolver as createComandotorrentsResolver } from '../resolvers/profiles/comandotorrents.js';
import { createResolver as createRedetorrentResolver } from '../resolvers/profiles/redetorrent.js';
import { createResolver as createBludvResolver } from '../resolvers/profiles/bludv.js';
import { createResolver as createHdrtorrentsResolver } from '../resolvers/profiles/hdrtorrents.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import type { NerdfilmesResolverSurface } from '../src/providers/crawl-sites/nerdfilmes.js';
import type { TorrentdosfilmesResolverSurface } from '../src/providers/crawl-sites/torrentdosfilmes.js';
import type { ComandotorrentsResolverSurface } from '../src/providers/crawl-sites/comandotorrents.js';
import type { RedetorrentResolverSurface } from '../src/providers/crawl-sites/redetorrent.js';
import type { BludvResolverSurface } from '../src/providers/crawl-sites/bludv.js';
import type { HdrtorrentsResolverSurface } from '../src/providers/crawl-sites/hdrtorrents.js';

function selfUrl(port: number): string {
  return `http://${config.resolvers.host}:${port}`;
}

export function vacaSurface(): VacaResolverSurface {
  const port = config.resolvers.ports.vacatorrent + config.resolvers.portOffset;
  return createVacaResolver({
    port,
    selfUrl: selfUrl(port),
    siteUrl: config.resolvers.vacatorrentUrl || undefined,
    extraProtectors: config.resolvers.extraProtectors,
  });
}

export function nerdSurface(): NerdfilmesResolverSurface {
  const port = config.resolvers.ports.nerdfilmes + config.resolvers.portOffset;
  return createNerdfilmesResolver({
    port,
    selfUrl: selfUrl(port),
    siteUrl: config.resolvers.nerdfilmesUrl || undefined,
    extraProtectors: config.resolvers.extraProtectors,
  });
}

/** Card `torrentdosfilmesv2`, profile `torrentdosfilmes`. */
export function tdfSurface(): TorrentdosfilmesResolverSurface {
  const port = config.resolvers.ports.torrentdosfilmes + config.resolvers.portOffset;
  return createTorrentdosfilmesResolver({
    port,
    selfUrl: selfUrl(port),
    siteUrl: config.resolvers.torrentdosfilmesUrl || undefined,
    extraProtectors: config.resolvers.extraProtectors,
  });
}

export function comandoSurface(): ComandotorrentsResolverSurface {
  const port = config.resolvers.ports.comandotorrents + config.resolvers.portOffset;
  return createComandotorrentsResolver({
    port,
    selfUrl: selfUrl(port),
    siteUrl: config.resolvers.comandotorrentsUrl || undefined,
    extraProtectors: config.resolvers.extraProtectors,
  });
}

/** Card `redetorrent-cardigann`, profile `redetorrent`. O site está 100% atrás
 *  de Cloudflare (medido 2026-09-28): o `fetchText` do profile cai no
 *  FlareSolverr, e a sonda nunca aciona o browser sozinha — o acesso é o mesmo
 *  do caminho de busca. */
export function redetorrentSurface(): RedetorrentResolverSurface {
  const port = config.resolvers.ports.redetorrent + config.resolvers.portOffset;
  return createRedetorrentResolver({
    port,
    selfUrl: selfUrl(port),
    siteUrl: config.resolvers.redetorrentUrl || undefined,
    extraProtectors: config.resolvers.extraProtectors,
  });
}

/**
 * Card `bludv-cardigann`, profile `bludv` — mesma ponte por NOME dos dois
 * acima (o id do card não existe no profile), e o MESMO caminho direto, sem
 * `listen`. Sem esta linha a sonda — que é o PORTÃO de entrada do site na
 * rotação — não roda para o BLUDV e o site fica sem veredito possível.
 */
export function bludvSurface(): BludvResolverSurface {
  const port = config.resolvers.ports.bludv + config.resolvers.portOffset;
  return createBludvResolver({
    port,
    selfUrl: selfUrl(port),
    siteUrl: config.resolvers.bludvUrl || undefined,
    extraProtectors: config.resolvers.extraProtectors,
  });
}

/**
 * Card `hdrtorrent-cardigann`, profile `hdrtorrents` — terceira via do mesmo
 * caminho (superfície direta). Este site não usa FlareSolverr (medido 2026-09-29,
 * responde 200 direto), então a sonda nem aciona o browser.
 */
export function hdrSurface(): HdrtorrentsResolverSurface {
  const port = config.resolvers.ports.hdrtorrents + config.resolvers.portOffset;
  return createHdrtorrentsResolver({
    port,
    selfUrl: selfUrl(port),
    siteUrl: config.resolvers.hdrtorrentsUrl || undefined,
  });
}
