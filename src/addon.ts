import config from './config.js';
import * as brResolvers from './br-resolvers.js';
import * as jackettCatalog from './providers/jackett-catalog.js';
import * as secretBox from './utils/secret-box.js';
import * as cache from './utils/cache.js';
import * as log from './utils/logger.js';
import * as metrics from './utils/metrics.js';
import debrid from './debrid/index.js';
import { createApp } from './app.js';
import warmup from './warmup.js';
import harvester from './providers/harvester.js';

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
// O outro lixo que a limpeza por busca nunca alcança: magnet antigo sem áudio
// PT que o autofetch acumulou — pronto, só inútil para este addon.
// Defasado do sweepDead: os dois têm o mesmo intervalo default e disparar os
// dois no boot é rajada de deletes concorrentes — a AllDebrid responde 503.
if (config.debrid.sweepUndubbed) {
  const undubbedDelay = Math.max(60_000, Math.floor(config.debrid.sweepUndubbedIntervalMs / 2));
  setTimeout(() => {
    debrid.sweepUndubbedEnv();
    setInterval(() => { debrid.sweepUndubbedEnv(); }, config.debrid.sweepUndubbedIntervalMs).unref();
  }, undubbedDelay).unref();
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
  warmup.start().catch((err) => log.warn('[warmup] falha no boot:', err?.message || err));
  harvester.start();
});

let shuttingDown = false;
function shutdown(signal: string) {
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
// Express 4 não encaminha rejeição de handler async ao middleware de erro. O
// handler de rota deve responder 500, mas esta rede evita que uma promessa de
// fundo derrube o processo inteiro e o supervisor leve a stack junto.
process.on('unhandledRejection', (reason) => {
  metrics.count('process.unhandled_rejection');
  log.error('[process] rejeição não tratada:', reason);
});

// Mantido para compatibilidade com quem importa o módulo; o manifest vem junto
// porque agora é criado dentro da fábrica.
addonInterface.manifest = manifest;
export default addonInterface;
