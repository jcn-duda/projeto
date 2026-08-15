const path = require('path');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const config = require('./config');
const { findStreams } = require('./providers');
const debrid = require('./debrid');
const runtime = require('./runtime');
const brResolvers = require('./br-resolvers');
const { verifyResolve } = require('./utils/sign');
const jackettCatalog = require('./providers/jackett-catalog');
const jackett = require('./providers/jackett');
const { authorized, createDiagnosticGate } = require('./utils/diagnostic-guard');
const secretBox = require('./utils/secret-box');
const metrics = require('./utils/metrics');
const cache = require('./utils/cache');
const log = require('./utils/logger');

const diagnosticGate = createDiagnosticGate();

// /seal-config é público como o resto de /configure. Selar é barato (o scrypt
// fica em cache e sobra o AES), mas "barato" e "de graça" não são a mesma
// coisa: sem teto o endpoint vira um jeito de queimar CPU da instância.
//
// Global, e não por IP, pelo mesmo motivo do /test-indexer.json: atrás do Caddy
// o req.ip é o proxy, então limitar por cliente limitaria todo mundo junto.
//
// Quem protege de fato aqui é a JANELA: o handler é síncrono, então ele entra e
// libera a vaga antes do próximo pedido ser despachado, e o teto de
// concorrência nunca chega a fechar. Ele fica como rede para o dia em que a
// selagem virar assíncrona. O limite por minuto é folgado de propósito — a
// página pede o selo enquanto se digita a chave (com debounce de 250ms), e um
// 429 no meio disso seria um bug de UX, não proteção.
const sealGate = createDiagnosticGate({
  limit: 600,
  maxConcurrent: 4,
  rateMessage: 'muitos pedidos de selo; tente de novo em instantes',
  busyMessage: 'selo ocupado; tente de novo em instantes',
});

const manifest = {
  id: config.addonId,
  version: config.version,
  name: config.addonName,
  description:
    'Torrents self-hosted com prioridade para conteúdo brasileiro dublado. ' +
    'Busca em paralelo via Jackett (BLUDV, Comando, NerdFilmes, TorrentDosFilmes, ' +
    'RedeTorrent + indexers globais) e entrega play instantâneo por debrid.',
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
    const { streams, partial } = await findStreams({ type: args.type, id: args.id });
    if (!streams.length || partial) {
      // Resposta vazia (busca ainda em background) não pode ficar cacheada:
      // o Stremio precisa perguntar de novo pra pegar o resultado real.
      //
      // Lista PARCIAL também não: os indexadores BR levam 6-8s e não cabem no
      // orçamento de coleta, então a primeira resposta sai só com as fontes
      // globais. Com cacheMaxAge normal o cliente ficava 15 minutos preso nela
      // enquanto o passe tardio já tinha recacheado a lista completa no servidor
      // — era isso que fazia "o BR não aparecer" mesmo estando lá.
      return { streams, cacheMaxAge: 0 };
    }
    return {
      streams,
      cacheMaxAge: config.cacheTtl,
      staleRevalidate: config.cacheTtl * 4,
      staleError: 86400,
    };
  } catch (err) {
    log.error('[stream]', err);
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
    log.error('[resolve]', err.message);
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
app.get('/defaults.json', async (_, res) => {
  const { debridApiKey, ...safe } = runtime.defaults();
  // `services` monta o seletor de debrid na página: a lista de serviços mora no
  // registry, não duplicada no HTML. `addonName` evita hardcodear a marca no
  // HTML — a página exibe o nome que vier da config.
  const jackettIndexers = await jackettCatalog.load();
  res.json({
    ...safe,
    jackettIndexersSelected: safe.jackettIndexers,
    jackettIndexers,
    debridApiKey: '',
    services: debrid.SERVICES,
    addonName: config.addonName,
    indexerTestEnabled: Boolean(config.jackett.testToken),
    // Liga o passo de selo na página; sem RESOLVE_SECRET não há o que cifrar.
    sealKeyEnabled: secretBox.enabled(),
  });
});

/**
 * Devolve o segmento de config com a chave de debrid cifrada. A página monta a
 * URL no navegador e não tem o RESOLVE_SECRET, então a troca acontece aqui.
 *
 * Público como o resto de /configure: selar não exige saber de nada e não
 * revela nada — é cifra, não decifra. Quem já tinha a chave para mandar aqui já
 * a tinha antes.
 */
app.post('/seal-config', express.text({ type: () => true, limit: '16kb' }), (req, res) => {
  if (!secretBox.enabled()) {
    return res.status(503).json({ error: 'RESOLVE_SECRET não configurado' });
  }
  const admission = sealGate.enter('global');
  if (!admission.ok) return res.status(admission.status).json({ error: admission.error });

  try {
    const sealed = runtime.sealSegment(String(req.body || '').trim());
    if (!sealed) return res.status(400).json({ error: 'configuração inválida' });
    return res.json({ segment: sealed });
  } finally {
    admission.release();
  }
});

/**
 * Contadores e latências desde a subida do processo:
 *   curl -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" \
 *     http://127.0.0.1:7000/metrics.json
 *
 * Atrás do mesmo token do diagnóstico: não tem segredo dentro, mas revela quais
 * indexadores o operador usa e o ritmo de uso da instância — e a página de
 * configuração é pública.
 */
app.get('/metrics.json', (req, res) => {
  if (!config.jackett.testToken) {
    return res.status(503).json({ error: 'métricas desativadas: defina JACKETT_TEST_TOKEN' });
  }
  if (!authorized(config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
    return res.status(401).json({ error: 'token de diagnóstico inválido' });
  }
  return res.json({
    ...metrics.snapshot(),
    logLevel: log.level(),
    cache: { entries: cache.size(), maxEntries: cache.MAX_ENTRIES },
  });
});

/**
 * Testa um indexer pelo mesmo caminho da busca real. A página usa isso pro botão
 * de teste; serve também no terminal:
 *   curl "http://127.0.0.1:7000/test-indexer.json?id=bludv-cardigann"
 *
 * O `id` é validado contra o catálogo do Jackett em vez de ir cru pra URL: sem
 * isso qualquer string viraria um caminho na API do Jackett.
 */
app.get('/test-indexer.json', async (req, res) => {
  if (!config.jackett.testToken) {
    return res.status(503).json({ ok: false, error: 'diagnóstico desativado pelo operador' });
  }
  if (!authorized(config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
    return res.status(401).json({ ok: false, error: 'token de diagnóstico inválido' });
  }
  // A stack passa pelo Caddy; limitar por req.ip trataria o proxy como se fosse
  // cada cliente. O teto é global de propósito e protege a única fila Jackett.
  const admission = diagnosticGate.enter('global');
  if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error });

  try {
    const id = String(req.query.id || '');
    const catalog = await jackettCatalog.load();
    if (!catalog.some((indexer) => indexer.id === id)) {
      return res.status(400).json({ ok: false, error: 'indexador desconhecido' });
    }
    // Sem `q`, quem escolhe o termo é o provider: indexer BR recebe o título em
    // português e o global o original. O teste é do indexer, não da query.
    const query = req.query.q ? String(req.query.q).slice(0, 80) : '';
    const type = req.query.type === 'series' ? 'series' : 'movie';
    return res.json(await jackett.test(id, query, type));
  } finally {
    admission.release();
  }
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

// O scrypt do selo custa ~100ms e o resultado fica em cache. Derivar aqui tira
// esse custo da primeira requisição de quem instalar.
if (secretBox.enabled()) secretBox.seal('warmup');
// Catálogo é usado na primeira abertura de /configure; aquecer só com credencial
// evita uma chamada inútil para instalações em modo demo/P2P.
if (config.jackett.apiKey) jackettCatalog.load().catch(() => {});

const server = app.listen(config.port, config.host, () => {
  const local = `http://127.0.0.1:${config.port}/manifest.json`;
  log.info('');
  log.info('══════════════════════════════════════════════');
  log.info(`  ${config.addonName} v${config.version}`);
  log.info(`  Provider: ${config.provider}`);
  log.info(`  Debrid:   ${config.debrid.service || 'nenhum (P2P puro)'}`);
  log.info(
    `  Chave na URL: ${secretBox.enabled() ? 'cifrada (RESOLVE_SECRET)' : 'em texto puro — defina RESOLVE_SECRET'}`,
  );
  log.info(`  Instale no Stremio:`);
  log.info(`  ${local}`);
  log.info('══════════════════════════════════════════════');
  log.info('');
  if (config.provider === 'demo') {
    log.info('Modo DEMO ativo → teste com o filme: Big Buck Bunny (tt1254207)');
    log.info('Para torrents de verdade: configure .env (PROVIDER=jackett|prowlarr|both)');
    log.info('');
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`[shutdown] ${signal} recebido; drenando conexões`);
  server.closeIdleConnections?.();
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  server.close(() => {
    brResolvers.close();
    cache.close();
    log.info('[shutdown] addon encerrado');
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = addonInterface;
