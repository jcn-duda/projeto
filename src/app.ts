import express from 'express';
import { buildServices } from './routes/services.js';
import { createStreamHandler } from './routes/stream.js';
import { registerRoutes } from './routes/register.js';
import { createAddonInterface } from './routes/addon-router.js';

/** Monta o app sem listen, warmup ou carregamento de resolvedores. */
function createApp() {
  const services = buildServices();
  const manifest = {
    id: services.config.addonId,
    version: services.config.version,
    name: services.config.addonName,
    description:
      'Torrents self-hosted com prioridade para conteúdo brasileiro dublado. ' +
      'Busca em paralelo via Jackett (BLUDV, Comando, NerdFilmes, TorrentDosFilmes, ' +
      'RedeTorrent + indexers globais) e entrega play instantâneo por debrid.',
    logo: services.config.debrid.publicUrl
      ? `${services.config.debrid.publicUrl}/logo.png`
      : 'https://www.stremio.com/website/stremio-logo-small.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { adult: false, configurable: true, configurationRequired: false },
  };
  const addonInterface = createAddonInterface(manifest, createStreamHandler(services));
  const app = express();
  registerRoutes(app, services, addonInterface);
  return { app, manifest, addonInterface };
}

export { createApp };
export { asyncRoute } from './routes/async.js';
export { originOf, streamsNeedRevalidation } from './routes/origin.js';
