const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const config = require('./config');
const { findStreams } = require('./providers');
const premiumize = require('./debrid/premiumize');

const manifest = {
  id: config.addonId,
  version: config.version,
  name: config.addonName,
  description:
    'Seu addon de torrents self-hosted. Jackett/Prowlarr + Docker. Roda na sua pasta, no PC ou no servidor.',
  logo: 'https://www.stremio.com/website/stremio-logo-small.png',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    adult: false,
    configurable: false,
    configurationRequired: false,
  },
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
  try {
    const streams = await findStreams({ type: args.type, id: args.id });
    if (!streams.length) {
      // Resposta vazia (busca ainda em background) não pode ficar cacheada:
      // o Stremio precisa perguntar de novo pra pegar o resultado real.
      return { streams, cacheMaxAge: 0 };
    }
    return {
      streams,
      cacheMaxAge: config.cacheTtl,
      staleRevalidate: config.cacheTtl * 4,
      staleError: 86400,
    };
  } catch (err) {
    console.error('[stream]', err);
    return { streams: [], cacheMaxAge: 0 };
  }
});

const addonInterface = builder.getInterface();

// Servidor próprio em vez de serveHTTP: precisamos da rota /resolve ao lado
// das rotas do SDK.
const app = express();

// O Stremio chama isso ao dar play num stream de debrid. Resolver aqui (e não
// na listagem) evita um directdl por torrent na hora da busca.
app.get('/resolve/:infoHash', async (req, res) => {
  const { infoHash } = req.params;
  if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
    return res.status(400).send('infoHash inválido');
  }
  try {
    const link = await premiumize.resolveLink(infoHash, {
      season: req.query.s ? Number(req.query.s) : null,
      episode: req.query.e ? Number(req.query.e) : null,
    });
    if (!link) return res.status(404).send('nenhum arquivo de vídeo no torrent');
    return res.redirect(302, link);
  } catch (err) {
    console.error('[resolve]', err.message);
    return res.status(502).send('falha ao resolver no debrid');
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.use(getRouter(addonInterface));

app.listen(config.port, config.host, () => {
  const local = `http://127.0.0.1:${config.port}/manifest.json`;
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log(`  ${config.addonName} v${config.version}`);
  console.log(`  Provider: ${config.provider}`);
  console.log(`  Debrid:   ${config.debrid.service || 'nenhum (P2P puro)'}`);
  console.log(`  Instale no Stremio:`);
  console.log(`  ${local}`);
  console.log('══════════════════════════════════════════════');
  console.log('');
  if (config.provider === 'demo') {
    console.log('Modo DEMO ativo → teste com o filme: Big Buck Bunny (tt1254207)');
    console.log('Para torrents de verdade: configure .env (PROVIDER=jackett|prowlarr|both)');
    console.log('');
  }
});

module.exports = addonInterface;
