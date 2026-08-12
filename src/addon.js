const path = require('path');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const config = require('./config');
const { findStreams } = require('./providers');
const debrid = require('./debrid');
const runtime = require('./runtime');
const brResolvers = require('./br-resolvers');
const { verifyResolve } = require('./utils/sign');

const manifest = {
  id: config.addonId,
  version: config.version,
  name: config.addonName,
  description:
    'Torrents self-hosted com prioridade para conteúdo brasileiro dublado. ' +
    'Busca em paralelo via Jackett (BLUDV, Comando, NerdFilmes, TorrentDosFilmes ' +
    '+ indexers globais) e entrega play instantâneo por debrid.',
  // Servido pelo próprio addon quando há PUBLIC_URL; sem ela o cliente não
  // alcançaria um caminho relativo, então cai no logo genérico do Stremio.
  logo: config.debrid.publicUrl
    ? `${config.debrid.publicUrl}/logo.svg`
    : 'https://www.stremio.com/website/stremio-logo-small.png',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    adult: false,
    // Liga o botão de engrenagem do Stremio, que aponta pra /configure.
    configurable: true,
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

// Servidor próprio em vez de serveHTTP: precisamos das rotas /resolve e
// /configure ao lado das rotas do SDK.
const app = express();

// O Stremio chama isso ao dar play num stream de debrid. Resolver aqui (e não
// na listagem) evita um directdl por torrent na hora da busca.
async function resolveHandler(req, res) {
  const { infoHash } = req.params;
  if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
    return res.status(400).send('infoHash inválido');
  }
  // Com debrid ativo a URL só vale assinada: hashes aparecem nos resultados
  // públicos dos indexers, e sem sig qualquer um montaria o link na mão.
  // Sem debrid não há conta a proteger (nem o que resolver).
  if (debrid.current()) {
    const ep =
      req.query.s != null && req.query.e != null ? `?s=${req.query.s}&e=${req.query.e}` : '';
    if (!verifyResolve(infoHash, ep, req.query.sig)) {
      return res.status(403).send('assinatura inválida');
    }
  }
  try {
    const link = await debrid.resolveLink(infoHash, {
      season: req.query.s ? Number(req.query.s) : null,
      episode: req.query.e ? Number(req.query.e) : null,
    });
    if (!link) return res.status(404).send('nenhum arquivo de vídeo no torrent');
    return res.redirect(302, link);
  } catch (err) {
    console.error('[resolve]', err.message);
    return res.status(502).send('falha ao resolver no debrid');
  }
}

const CONFIGURE_PAGE = path.join(__dirname, 'public', 'configure.html');
const sendConfigure = (_, res) => res.sendFile(CONFIGURE_PAGE);

app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/logo.svg', (_, res) => res.sendFile(path.join(__dirname, 'public', 'logo.svg')));
app.get('/', (_, res) => res.redirect(302, '/configure'));
app.get('/configure', sendConfigure);

// Defaults do .env, para a página abrir já refletindo a instância. A chave do
// debrid NUNCA vai junto: a página é pública e o .env é do operador, não de
// quem está instalando.
app.get('/defaults.json', (_, res) => {
  const { debridApiKey, ...safe } = runtime.defaults();
  // `services` monta o seletor de debrid na página: a lista de serviços mora no
  // registry, não duplicada no HTML. `addonName` evita hardcodear a marca no
  // HTML — a página exibe o nome que vier da config.
  res.json({ ...safe, debridApiKey: '', services: debrid.SERVICES, addonName: config.addonName });
});

app.get('/resolve/:infoHash', resolveHandler);
// Rotas sem config: usam o .env puro. Vêm ANTES do prefixo genérico, senão
// "/manifest.json" seria lido como um segmento de configuração.
app.use(getRouter(addonInterface));

/**
 * Instalação configurada, no modelo do Torrentio: `/<config>/manifest.json`.
 * O segmento é validado por `decode` — se não for uma config, cai no 404 normal
 * em vez de virar uma rota fantasma.
 */
app.use('/:userConfig', (req, res, next) => {
  const parsed = runtime.decode(req.params.userConfig);
  // Sem 404 aqui, QUALQUER caminho de um segmento viraria um manifest válido
  // servindo a config do .env — inclusive erro de digitação no install URL.
  if (!parsed) return res.status(404).send('configuração inválida');
  runtime.run({ opts: parsed, encoded: req.params.userConfig }, () => next());
});

app.get('/:userConfig/configure', sendConfigure);
app.get('/:userConfig/resolve/:infoHash', resolveHandler);
app.use('/:userConfig', getRouter(addonInterface));

brResolvers.load();

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
