// Baseline de cobertura BR ⚡ (Fase 3.1) sobre a COORTE POPULAR persistida.
//
// O addon colhe, indexa e aquece conteúdo BR dublado; a pergunta que este
// módulo responde é "quantas das obras POPULARES (fonte IMDb) já têm ⚡
// confirmado (pronto para tocar)". O denominador não é o índice inteiro — é a
// coorte que a semente grava (`popularCohort`): os top filmes e séries do IMDb.
// Medir o índice inteiro dizia o que o addon já sabe sobre o que foi buscado,
// não o que importa (o que as pessoas estão prestes a abrir).
//
// É observabilidade PURA: varre o índice em memória em background, não faz
// rede, não escreve no debrid e não toca no orçamento da resposta. Nenhuma
// chamada a checkCached/enqueue/addMagnet. As métricas continuam em memória
// (metrics.ts) — a coorte é persistida pela semente, o resto é estado local.
//
// ⚡ por RELEASE (não-lied) = um destes:
//   - ledger RD hit (sinal GLOBAL, independente de conta, lido quieto);
//   - davail positivo da conta do operador;
//   - magnetdb.alive da conta do operador.
// Miss explícito = ledger RD miss/blocked OU davail zero.
// Sem conta do operador configurada (DEBRID_ALLOW_ENV_KEY/service/apiKey), só
// o ledger decide — a cobertura reflete o que o serviço garante, não o que a
// conta provou. A classificação é POR RELEASE; a da obra agrega (hit se
// qualquer hit; miss só se TODAS as candidatas BR não-lied são miss; senão
// unknown).
//
// Exclui deliberadamente releases com `lied`: o post prometeu PT mas os
// arquivos provaram release EN — não é candidato BR, é ruído da medição.
import config from '../config.js';
import * as cache from './cache.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';
import { prefix } from './cache-keys.js';
import { accountScope } from './request-key.js';
import * as rdLedger from '../debrid/rd-ledger.js';
import * as releaseIndex from './release-index.js';
import { popularCohort } from '../providers/imdb-seed.js';
import type { PopularCohort } from '../providers/imdb-seed.js';
import type { IndexedRelease } from './release-index.js';

type TypeCounts = {
  target: number;
  indexed: number;
  withBr: number;
  cached: number;
  knownMiss: number;
  unknown: number;
};

export type BrCoverageSample = {
  at: number;
  /** `at` da coorte que originou esta leitura (quando foi persistida). */
  cohortAt: number | null;
  targetWorks: number;
  indexedWorks: number;
  worksWithBr: number;
  worksCached: number;
  worksKnownMiss: number;
  worksUnknown: number;
  releasesWithBr: number;
  releasesCached: number;
  movie: TypeCounts;
  series: TypeCounts;
};

type BrCoverageStatus = {
  enabled: boolean;
  baselineAt: number;
  samples: number;
  latest: BrCoverageSample | null;
  popularCoverage: number | null;
  brWarmRate: number | null;
  discoveryRate: number | null;
  counters: { sample: number };
};

/** Conta do operador (quem olha o dashboard) — sem credencial vazada. */
type OperatorCtx = { adapterId: string | null; apiKey: string };

let latest: BrCoverageSample | null = null;
let baselineAt = 0;
let samples = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function operatorCtx(): OperatorCtx {
  const service = String(config.debrid.service || '').toLowerCase();
  // A Fase 3 mede o alvo deste plano: cobertura no Real-Debrid. Histórico de
  // outra conta/adapter não pode pintar de ⚡ um hash que o warmer RD atende.
  const active = service === 'realdebrid' && config.debrid.allowEnvKey && Boolean(config.debrid.apiKey);
  return { adapterId: active ? service : null, apiKey: active ? config.debrid.apiKey : '' };
}

/** Chave do magnetdb.alive construída localmente; lida com peek (quieta). */
function aliveKey(adapterId: string, apiKey: string, hash: string) {
  return `${prefix('mag')}alive:${adapterId}:${accountScope(apiKey)}:${String(hash || '').toLowerCase()}`;
}

type ReleaseStatus = 'hit' | 'miss' | 'unknown';

/** Classificação pura de uma release. Somente leituras quietas de L1. */
function releaseStatus(release: IndexedRelease, ctx: OperatorCtx): ReleaseStatus {
  const ledger = rdLedger.peekQuiet(release.hash);
  let hasHit = false;
  let hasMiss = false;
  // Recusa legal é terminal no RD e vence evidência local atrasada. Um davail
  // ou alive antigo não pode ressuscitar o hash bloqueado como cobertura.
  if (ledger === 'blocked') return 'miss';
  if (ledger === 'hit') hasHit = true;
  if (ledger === 'miss') hasMiss = true;
  if (ctx.adapterId && ctx.apiKey) {
    const davailKey = `${prefix('davail')}${ctx.adapterId}:${accountScope(ctx.apiKey)}:${String(release.hash).toLowerCase()}`;
    const davail = cache.peek(davailKey);
    if (davail === 1) hasHit = true;
    if (davail === 0) hasMiss = true;
    if (cache.peek(aliveKey(ctx.adapterId, ctx.apiKey, release.hash)) === 1) hasHit = true;
  }
  // Um positivo (qualquer fonte) vence um miss: falso negativo da cobertura é o
  // erro que a decisão de vazão pagaria. Na dúvida, unknown.
  if (hasHit) return 'hit';
  if (hasMiss) return 'miss';
  return 'unknown';
}

/** Candidata BR dublada e não-lied (o post mente não é candidata). */
function isBrRelease(rel: IndexedRelease): boolean {
  return Boolean(rel && rel.isBr && rel.dubbed && !rel.lied);
}

function emptyType(): TypeCounts {
  return { target: 0, indexed: 0, withBr: 0, cached: 0, knownMiss: 0, unknown: 0 };
}

function buildSample(coorte: PopularCohort, snap: Map<string, IndexedRelease[]>, ctx: OperatorCtx): BrCoverageSample {
  const movie = emptyType();
  const series = emptyType();
  movie.target = coorte.movies.length;
  series.target = coorte.series.length;

  const typed: Record<string, TypeCounts> = {};
  for (const id of coorte.movies) typed[id] = movie;
  for (const id of coorte.series) typed[id] = series;

  let indexedWorks = 0;
  let worksWithBr = 0;
  let worksCached = 0;
  let worksKnownMiss = 0;
  let worksUnknown = 0;
  let releasesWithBr = 0;
  let releasesCached = 0;

  for (const id of [...coorte.movies, ...coorte.series]) {
    const releaseList = snap.get(id) || [];
    const bucket = typed[id] || movie;
    if (releaseList.length === 0) continue; // obra ainda não indexada
    bucket.indexed += 1;
    indexedWorks += 1;

    // Candidatas BR dubladas e não-lied desta obra.
    const brRels = releaseList.filter(isBrRelease);
    if (brRels.length === 0) continue; // sem conteúdo BR pra medir
    bucket.withBr += 1;
    worksWithBr += 1;
    releasesWithBr += brRels.length;

    let anyHit = false;
    let allMiss = true;
    for (const rel of brRels) {
      const st = releaseStatus(rel, ctx);
      if (st === 'miss') continue;
      if (st === 'hit') {
        anyHit = true;
        releasesCached += 1;
      } else {
        allMiss = false; // unknown deixa de ser "todas são miss"
      }
    }
    if (anyHit) {
      bucket.cached += 1;
      worksCached += 1;
    } else if (allMiss) {
      bucket.knownMiss += 1;
      worksKnownMiss += 1;
    } else {
      bucket.unknown += 1;
      worksUnknown += 1;
    }
  }

  return {
    at: Date.now(),
    cohortAt: coorte.at,
    targetWorks: coorte.movies.length + coorte.series.length,
    indexedWorks,
    worksWithBr,
    worksCached,
    worksKnownMiss,
    worksUnknown,
    releasesWithBr,
    releasesCached,
    movie,
    series,
  };
}

/** Publica os valores ATUAIS (níveis) do estado, nunca deltas. */
function publishGauges(s: BrCoverageSample) {
  metrics.gauge('f3.br.popular.target', s.targetWorks);
  metrics.gauge('f3.br.popular.indexed', s.indexedWorks);
  metrics.gauge('f3.br.popular.withBr', s.worksWithBr);
  metrics.gauge('f3.br.popular.cached', s.worksCached);
  metrics.gauge('f3.br.popular.knownMiss', s.worksKnownMiss);
  metrics.gauge('f3.br.popular.unknown', s.worksUnknown);
  metrics.gauge('f3.br.popular.releasesWithBr', s.releasesWithBr);
  metrics.gauge('f3.br.popular.releasesCached', s.releasesCached);
  // Razões: nenhum denominador inventado — se a obra (:cohort) ou a BR for
  // zero, a razão é 0 (não null), porque o denominador da coorte é > 0 sempre.
  metrics.gauge('f3.br.popular.popularCoverage', s.targetWorks ? s.worksCached / s.targetWorks : 0);
  metrics.gauge('f3.br.popular.brWarmRate', s.worksWithBr ? s.worksCached / s.worksWithBr : 0);
  metrics.gauge('f3.br.popular.discoveryRate', s.targetWorks ? s.worksWithBr / s.targetWorks : 0);
}

const GAUGES = [
  'target', 'indexed', 'withBr', 'cached', 'knownMiss', 'unknown',
  'releasesWithBr', 'releasesCached', 'popularCoverage', 'brWarmRate', 'discoveryRate',
].map((name) => `f3.br.popular.${name}`);

function clearGauges(): void {
  for (const name of GAUGES) metrics.clearGauge(name);
}

/**
 * Uma varredura da coorte: devolve null quando ainda não há coorte válida —
 * sem denominador não há o que medir, e a baseline só começa no primeiro
 * amostra com coorte. Emite só o gauge (estado) e o contador de samples.
 */
export function sample(): BrCoverageSample | null {
  const coorte = popularCohort();
  if (!coorte) {
    // Coorte expirada invalida a janela de 48h: manter gauges/latest antigos
    // faria a 3.3 decidir vazão sobre um alvo que já não existe.
    latest = null;
    baselineAt = 0;
    samples = 0;
    clearGauges();
    return null;
  }
  const ctx = operatorCtx();
  const snap = releaseIndex.snapshotWorks([...coorte.movies, ...coorte.series]);
  const cur = buildSample(coorte, snap, ctx);
  if (baselineAt === 0) baselineAt = cur.at;
  latest = cur;
  samples += 1;
  metrics.count('f3.br.sample');
  publishGauges(cur);
  return cur;
}

/** Painel: estado consolidado sem expor hash/credencial/API key. */
export function status(): BrCoverageStatus {
  const counters = metrics.snapshot().counters;
  const latestSample = latest;
  return {
    enabled: config.f3.enabled && config.f3.br.enabled,
    baselineAt,
    samples,
    latest: latestSample,
    popularCoverage: latestSample && latestSample.targetWorks > 0 ? latestSample.worksCached / latestSample.targetWorks : null,
    brWarmRate: latestSample && latestSample.worksWithBr > 0 ? latestSample.worksCached / latestSample.worksWithBr : null,
    discoveryRate: latestSample && latestSample.targetWorks > 0 ? latestSample.worksWithBr / latestSample.targetWorks : null,
    counters: { sample: counters['f3.br.sample'] || 0 },
  };
}

/** Timer de fundo (unref). Varre já no boot e de `sampleMs` em `sampleMs`. */
export function start(): void {
  if (!config.f3.enabled || !config.f3.br.enabled) {
    log.info('[br-coverage] desativado (F3_BR_ENABLED ou F3_ENABLED off)');
    return;
  }
  if (timer) return;
  const tick = () => {
    try {
      sample();
    } catch (err) {
      log.warn('[br-coverage] varredura falhou:', (err as Error)?.message || err);
    }
  };
  tick();
  timer = setInterval(tick, config.f3.br.sampleMs);
  timer.unref();
}

/** Teste: zera estado em memória. */
export function reset(): void {
  latest = null;
  baselineAt = 0;
  samples = 0;
  clearGauges();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default { sample, status, start, reset };
