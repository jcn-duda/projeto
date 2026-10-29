import type express from 'express';
import type config from '../config.js';
import type * as runtime from '../runtime.js';
import type debrid from '../debrid/index.js';
import type * as jackettCatalog from '../providers/jackett-catalog.js';
import type * as secretBox from '../utils/secret-box.js';
import type * as metrics from '../utils/metrics.js';
import type * as cache from '../utils/cache.js';
import type * as log from '../utils/logger.js';
import type * as autofetch from '../providers/autofetch.js';
import type * as autofetchLive from '../utils/autofetch-live.js';
import type * as autofetchSuppressed from '../providers/autofetch-suppressed.js';
import type * as releaseIndex from '../utils/release-index.js';
import type * as harvesterLive from '../utils/harvester-live.js';
import type * as harvesterDebrid from '../utils/harvester-debrid-live.js';
import type * as magnetdb from '../utils/magnetdb.js';
import type * as magnetBank from '../utils/magnet-bank.js';
import type * as brResolvers from '../br-resolvers.js';
import type * as providers from '../providers/index.js';
import type * as debridCommon from '../debrid/common.js';
import type { accountScope } from '../utils/request-key.js';
import type { verifyResolve } from '../utils/sign.js';
import type { authorized, createDiagnosticGate } from '../utils/diagnostic-guard.js';
import type * as rdLedger from '../debrid/rd-ledger.js';
import type crawler from '../providers/crawler.js';
import type * as crawlerLive from '../utils/crawler-live.js';

export type GateAdmission =
  | { ok: true; release: () => void }
  // `reason` acompanha a recusa para o cliente não ter que casar o TEXTO (que
  // é parametrizável por chamador). Opcional: gates de teste que devolvem só
  // `{ok,status,error}` continuam válidos.
  | { ok: false; status: number; error: string; reason?: 'rate' | 'busy' };

export type DiagnosticGate = ReturnType<typeof createDiagnosticGate>;

/** Dependências explícitas dos handlers; os singletons continuam referências vivas. */
export interface AppServices {
  config: typeof config;
  runtime: typeof runtime;
  debrid: typeof debrid;
  jackettCatalog: typeof jackettCatalog;
  secretBox: typeof secretBox;
  metrics: typeof metrics;
  cache: typeof cache;
  log: typeof log;
  autofetch: typeof autofetch;
  // `autofetchRunner` SAIU do contrato (corte do Chupim TS): o runner é nativo.
  // O que o painel ainda lê do Node vem de `providers.autofetchStatus()`
  // (snapshot parcial) e de `autofetchLive` (config ao vivo). Não reintroduza
  // um serviço do runner aqui: o arquivo não existe mais do lado TS.
  autofetchLive: typeof autofetchLive;
  autofetchSuppressed: typeof autofetchSuppressed;
  releaseIndex: typeof releaseIndex;
  // `harvester` SAIU do contrato (Fase 5): a fila `harvest:v1` é do gateway e o
  // painel lê o estado por `utils/harvest-native.ts` (`harvestStatusSnapshot`,
  // `pauseNativeHarvest`, `drainNativeHarvest`, `clearNativeHarvest`). Não
  // reintroduza um serviço de colhedor aqui: o Node não tem mais worker.
  harvesterLive: typeof harvesterLive;
  harvesterDebrid: typeof harvesterDebrid;
  magnetdb: typeof magnetdb;
  magnetBank: typeof magnetBank;
  brResolvers: typeof brResolvers;
  providers: typeof providers;
  debridCommon: typeof debridCommon;
  accountScope: typeof accountScope;
  verifyResolve: typeof verifyResolve;
  authorized: typeof authorized;
  diagnosticGate: DiagnosticGate;
  sealGate: DiagnosticGate;
  // `prefetchInFlight` SAIU do contrato: era um `Set` registrado no ctx que
  // nenhum handler populava nem lia. Dedupe de prefetch não mora no Node.
  publicPath(file: string): string;
  rdLedger: typeof rdLedger;
  crawler: typeof crawler;
  crawlerLive: typeof crawlerLive;
}

export type HandlerFactory<T = express.RequestHandler> = (services: AppServices) => T;
