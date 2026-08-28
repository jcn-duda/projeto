// Compositor da configuração do operador (PLANO_MELHORIAS §5.8, Fase 2,
// item #1 do backlog). Todo process.env vira config AQUI — as seções em
// src/config/ são apenas a divisão física do arquivo único; a superfície
// pública não muda: `export default config`, mesmos nomes de campo, mesmos
// defaults. Consumidores continuam fazendo `import config from './config.js'`,
// que resolve para ESTE arquivo e não para o diretório ./config/.
// As seções são FÁBRICAS chamadas nesta montagem (e não objetos de módulo):
// módulo ESM é cacheado, e a re-avaliação deste arquivo (ex.: bust de cache
// nos testes, `import('.../config.js?bust')`) precisa reler o process.env —
// a chamada re-executa as leituras, o módulo seccionado não re-executa. A
// ordem dos imports importa: dotenv tem que carregar ANTES das chamadas.
import 'dotenv/config';

import { server } from './config/server.js';
import { jackett } from './config/jackett.js';
import { prowlarr, torrentio, tmdb, cinemeta, bludv } from './config/providers.js';
import { resolvers } from './config/resolvers.js';
import { searchSettings, budgets, search } from './config/search.js';
import { cacheBase, rawCache, cache, catalog } from './config/cache.js';
import { debrid } from './config/debrid.js';
import { warmup, releaseIndex, accountFastPath, harvest, seed, f3 } from './config/harvest.js';
import { magnetDb, audioAudit, notify } from './config/audit.js';

const config = {
  // port, host, addonName, addonId, version, provider, logging
  ...server(),
  jackett: jackett(),
  warmup: warmup(),
  releaseIndex: releaseIndex(),
  accountFastPath: accountFastPath(),
  harvest: harvest(),
  prowlarr: prowlarr(),
  torrentio: torrentio(),
  tmdb: tmdb(),
  cinemeta: cinemeta(),
  resolvers: resolvers(),
  bludv: bludv(),
  // preferDubbed, streamNameStyle, streamNameShowSource, qualityFilter,
  // minSeeders, maxResults, qualityLimits, maxPerIndexer, candidatePoolFactor,
  // brReservedSlots, brReservedPerQuality, brPartialGrace
  ...searchSettings(),
  // cacheTtl, streamStaleGrace
  ...cacheBase(),
  rawCache: rawCache(),
  cache: cache(),
  catalog: catalog(),
  debrid: debrid(),
  // searchTimeout, replyDeadline, debridReserve, debridCheckFloor
  ...budgets(),
  search: search(),
  seed: seed(),
  magnetDb: magnetDb(),
  audioAudit: audioAudit(),
  notify: notify(),
  f3: f3(),
};

export default config;
