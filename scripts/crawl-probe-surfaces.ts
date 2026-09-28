// Superfície direta de cada profile para a sonda. Sem `listen`: a CLI não
// disputa as portas 8700–8707 com o container. Import dinâmico no entry-point
// (depois de `CACHE_PERSIST=false`) — import estático aqui rodaria cedo demais.
import config from '../src/config.js';
import { createResolver as createVacaResolver } from '../resolvers/profiles/vacatorrent.js';
import { createResolver as createNerdfilmesResolver } from '../resolvers/profiles/nerdfilmes.js';
import { createResolver as createTorrentdosfilmesResolver } from '../resolvers/profiles/torrentdosfilmes.js';
import { createResolver as createComandotorrentsResolver } from '../resolvers/profiles/comandotorrents.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import type { NerdfilmesResolverSurface } from '../src/providers/crawl-sites/nerdfilmes.js';
import type { TorrentdosfilmesResolverSurface } from '../src/providers/crawl-sites/torrentdosfilmes.js';
import type { ComandotorrentsResolverSurface } from '../src/providers/crawl-sites/comandotorrents.js';

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
