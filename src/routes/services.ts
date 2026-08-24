import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from '../config.js';
import * as runtime from '../runtime.js';
import debrid from '../debrid/index.js';
import * as jackettCatalog from '../providers/jackett-catalog.js';
import jackett from '../providers/jackett.js';
import * as secretBox from '../utils/secret-box.js';
import * as metrics from '../utils/metrics.js';
import * as cache from '../utils/cache.js';
import * as log from '../utils/logger.js';
import * as autofetch from '../providers/autofetch.js';
import * as releaseIndex from '../utils/release-index.js';
import harvester from '../providers/harvester.js';
import * as magnetdb from '../utils/magnetdb.js';
import * as brResolvers from '../br-resolvers.js';
import * as providers from '../providers/index.js';
import * as debridCommon from '../debrid/common.js';
import { accountScope } from '../utils/request-key.js';
import { verifyResolve } from '../utils/sign.js';
import { authorized, createDiagnosticGate } from '../utils/diagnostic-guard.js';
import { prefetchInFlight } from './state.js';
import type { AppServices } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildServices(): AppServices {
  return {
    config,
    runtime,
    debrid,
    jackettCatalog,
    jackett,
    secretBox,
    metrics,
    cache,
    log,
    autofetch,
    releaseIndex,
    harvester,
    magnetdb,
    brResolvers,
    providers,
    debridCommon,
    accountScope,
    verifyResolve,
    authorized,
    // Cada app precisa de seus próprios gates para os testes paralelos.
    diagnosticGate: createDiagnosticGate(),
    sealGate: createDiagnosticGate({
      limit: 600,
      maxConcurrent: 4,
      rateMessage: 'muitos pedidos de selo; tente de novo em instantes',
      busyMessage: 'selo ocupado; tente de novo em instantes',
    }),
    prefetchInFlight,
    publicPath: (file) => path.join(__dirname, '..', 'public', file),
  };
}

export { buildServices };
