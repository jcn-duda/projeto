const config = require('./config');
const brResolvers = require('./br-resolvers');
const jackettCatalog = require('./providers/jackett-catalog');
const secretBox = require('./utils/secret-box');
const cache = require('./utils/cache');
const log = require('./utils/logger');
const debrid = require('./debrid');
const { createApp } = require('./app');

// O Express app + manifest + rotas vivem em ./app (sem listen), para os testes
// poderem exercitar o roteamento real sem subir servidor.

const { app, manifest, addonInterface } = createApp();

brResolvers.load();

// O scrypt do selo custa ~100ms e o resultado fica em cache. Derivar aqui tira
// esse custo da primeira requisição de quem instalar.
if (secretBox.enabled()) secretBox.seal('warmup');
// Catálogo é usado na primeira abertura de /configure; aquecer só com credencial
// evita uma chamada inútil para instalações em modo demo/P2P.
if (config.jackett.apiKey) jackettCatalog.load().catch(() => {});
// Antes do primeiro /magnet/upload, para a conta do operador não classificar
// os uploads da primeira busca como magnets que já eram do usuário.
debrid.warmupEnv();
// Lixo que a limpeza por busca nunca alcança: magnet morto que ninguém mais
// pesquisa. unref() para a varredura periódica não segurar o processo aberto
// no shutdown.
if (config.debrid.sweepDead) {
  debrid.sweepDeadEnv();
  setInterval(() => { debrid.sweepDeadEnv(); }, config.debrid.sweepDeadIntervalMs).unref();
}

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

// Mantido para compatibilidade com quem importa o módulo; o manifest vem junto
// porque agora é criado dentro da fábrica.
module.exports = addonInterface;
module.exports.manifest = manifest;
