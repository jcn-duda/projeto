import type express from 'express';
import type config from '../config.js';
import type * as runtime from '../runtime.js';
import type debrid from '../debrid/index.js';
import type * as jackettCatalog from '../providers/jackett-catalog.js';
import type jackett from '../providers/jackett.js';
import type * as secretBox from '../utils/secret-box.js';
import type * as metrics from '../utils/metrics.js';
import type * as cache from '../utils/cache.js';
import type * as log from '../utils/logger.js';
import type * as autofetch from '../providers/autofetch.js';
import type * as autofetchRunner from '../providers/autofetch-runner.js';
import type * as autofetchLive from '../utils/autofetch-live.js';
import type * as releaseIndex from '../utils/release-index.js';
import type harvester from '../providers/harvester.js';
import type * as magnetdb from '../utils/magnetdb.js';
import type * as brResolvers from '../br-resolvers.js';
import type * as providers from '../providers/index.js';
import type * as debridCommon from '../debrid/common.js';
import type { accountScope } from '../utils/request-key.js';
import type { verifyResolve } from '../utils/sign.js';
import type { authorized, createDiagnosticGate } from '../utils/diagnostic-guard.js';
import type * as rdLedger from '../debrid/rd-ledger.js';
import type { rdGate } from '../debrid/rd-gate.js';
import type rdWarmer from '../providers/rd-warmer.js';

export type GateAdmission =
  | { ok: true; release: () => void }
  | { ok: false; status: number; error: string };

export type DiagnosticGate = ReturnType<typeof createDiagnosticGate>;

/** Dependências explícitas dos handlers; os singletons continuam referências vivas. */
export interface AppServices {
  config: typeof config;
  runtime: typeof runtime;
  debrid: typeof debrid;
  jackettCatalog: typeof jackettCatalog;
  jackett: typeof jackett;
  secretBox: typeof secretBox;
  metrics: typeof metrics;
  cache: typeof cache;
  log: typeof log;
  autofetch: typeof autofetch;
  autofetchRunner: typeof autofetchRunner;
  autofetchLive: typeof autofetchLive;
  releaseIndex: typeof releaseIndex;
  harvester: typeof harvester;
  magnetdb: typeof magnetdb;
  brResolvers: typeof brResolvers;
  providers: typeof providers;
  debridCommon: typeof debridCommon;
  accountScope: typeof accountScope;
  verifyResolve: typeof verifyResolve;
  authorized: typeof authorized;
  diagnosticGate: DiagnosticGate;
  sealGate: DiagnosticGate;
  /** Estado do processo, compartilhado entre instâncias de createApp. */
  prefetchInFlight: Set<string>;
  publicPath(file: string): string;
  rdLedger: typeof rdLedger;
  rdGate: typeof rdGate;
  rdWarmer: typeof rdWarmer;
}

export type HandlerFactory<T = express.RequestHandler> = (services: AppServices) => T;
