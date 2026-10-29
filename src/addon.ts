import config from './config.js';
import * as brResolvers from './br-resolvers.js';
import * as jackettCatalog from './providers/jackett-catalog.js';
import * as secretBox from './utils/secret-box.js';
import * as cache from './utils/cache.js';
import * as log from './utils/logger.js';
import * as metrics from './utils/metrics.js';
import debrid from './debrid/index.js';
import { createApp } from './app.js';
import { startHarvestPolling, stopHarvestPolling } from './utils/harvest-native.js';
import { startIndexerStatusPolling, stopIndexerStatusPolling } from './providers/indexer-status-native.js';
import { startSweepsPolling, stopSweepsPolling } from './utils/sweeps-native.js';
import rdWarmer from './providers/rd-warmer.js';
import brCoverage from './utils/br-coverage.js';
import * as magnetdb from './utils/magnetdb.js';
import * as magnetBank from './utils/magnet-bank.js';
import { backfillClassification } from './utils/magnet-bank-backfill.js';
import * as crawlStore from './utils/crawl-store.js';
import crawler from './providers/crawler.js';
import * as rustCore from './utils/rust-core.js';
import * as autofetch from './providers/autofetch.js';

const services = { magnetdb, magnetBank };

// Ponte Rust: carrega o núcleo no boot, antes da primeira busca, para o custo
// do primeiro carregamento não cair numa resposta. Caminho em `RUST_CORE_PATH`;
// falha ao carregar só loga (a busca é quem falha depois).
rustCore.install();
// Filas que sobreviveram ao restart: o reindex do módulo roda no import, ANTES
// deste install, e sem núcleo é no-op. Refaz aqui para o painel e o "drenar
// filas" enxergarem o que está no disco (o dreno por searchKey não depende).
autofetch.reindexQueues();
autofetch.reindexDead();

// Banco de magnets vivo: abre o SQLite próprio no BOOT DO PROCESSO — só quando
// LIGADO (`MAGNET_BANK=false` não cria arquivo/WAL). O `createApp` (./app,
// importado pelos testes) não abre nada; só quem sobe o servidor paga o disco.
// O fechamento com flush+checkpoint vai no shutdown abaixo.
magnetBank.openIfEnabled();
// Acervo gravado sem `dubbed`/`quality`: preenche em fundo, em lotes (no-op
// quando já está preenchido). Falha só loga — o banco segue servindo.
if (config.magnetBank?.enabled) {
  backfillClassification(config.magnetBank.dbPath)
    .then((r) => { if (r.updated) log.info(`[magnetbank] ${r.updated} magnet(s) classificado(s) (dublado/qualidade)`); })
    .catch((err: unknown) => log.warn('[magnetbank] classificação do acervo falhou:', log.errorMessage(err)));
}

// O Express app + manifest + rotas vivem em ./app (sem listen), para os testes
// poderem exercitar o roteamento real sem subir servidor.

const { app, manifest, addonInterface } = createApp();

brResolvers.load();

// O scrypt do selo custa ~100ms e o resultado fica em cache. Derivar aqui tira
// esse custo da primeira requisição de quem instalar.
if (secretBox.enabled()) secretBox.seal('warmup');
// Catálogo é usado na primeira abertura de /configure; aquecer só com credencial
// evita uma chamada inútil para instalações em modo demo/P2P.
// Também é quem preenche a lista automática de indexers (sem JACKETT_INDEXERS),
// com nova tentativa a cada 30s até o Jackett responder.
jackettCatalog.startAutoRefresh();
// Antes do primeiro /magnet/upload, para a conta do operador não classificar
// os uploads da primeira busca como magnets que já eram do usuário.
debrid.warmupEnv();
// As varreduras destrutivas da AllDebrid (mortos, não-dublados, reconcile da
// posse e revalidação de represados) saíram daqui: o agendador é o NATIVO do
// gateway (`al_sweeps`, gate `DEBRID_AL_SWEEP_APPLY`), dono único das quatro.

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
  // Colhedor NATIVO (Fase 5): o Node não drena mais fila nenhuma — a
  // `harvest:v1` (fila, balde horário, dedupe) é do gateway, que colhe com as
  // mesmas fontes do `/stream`. Aqui só se arma o espelho de estado que o
  // bloco do painel lê sem esperar rede. Idempotente e best-effort: gateway
  // fora do ar vira backoff, nunca erro de boot.
  startHarvestPolling();
  // Status dos indexadores medido pelo gateway (painel e alerta de BR offline).
  startIndexerStatusPolling();
  // Varreduras NATIVAS da AllDebrid: o Node só espelha o status do gateway
  // (modo, último tick, contadores) para o painel — quem varre é o `al_sweeps`.
  startSweepsPolling();
  rdWarmer.start();
  brCoverage.start();
  // Raspagem total (piloto Vaca): armada SEMPRE, mesmo com `CRAWL_ENABLED=false`
  // — o motor decide pelo overlay vivo (`crawler-live`) e o painel liga/desliga
  // sem restart. Desligado, o tick não roda e o `crawl.db` nem é aberto. O
  // habilitado pelo painel persiste em `cfg:v1:crawler` (decisão explícita do
  // operador) e volta a valer neste `start`; `crawl-config-reset` restaura o
  // default desligado do `.env`.
  crawler.start();
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`[shutdown] ${signal} recebido; drenando conexões`);
  // Primeiro passo: para o poll do colhedor para nenhum refresh novo sair
  // enquanto o processo fecha (a ponte já é best-effort, mas o timer também
  // não deve sobreviver ao desarme).
  stopHarvestPolling();
  stopIndexerStatusPolling();
  stopSweepsPolling();
  server.closeIdleConnections?.();
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  server.close(() => {
    brResolvers.close();
    services.magnetdb.savePersistentCounts?.();
    services.magnetBank.close();
    crawlStore.close();
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
