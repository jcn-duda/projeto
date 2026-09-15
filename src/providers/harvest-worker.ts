// Colheita de UMA obra: metadados, varredura pt-BR nos globais, laço de
// indexers, filtro e registro no índice de releases — mais a contabilidade
// compartilhada do teto horário e do intervalo por indexer. Separada do ciclo
// (harvester.ts) porque é o trabalho em si; o ciclo decide QUANDO e QUANTAS.
// As consultas educadas (teto horário, gap por indexer) moram aqui porque só
// fazem sentido junto do laço que as gasta.
import config from '../config.js';
import * as activity from './activity.js';
import jackett from './jackett.js';
import bludv from './bludv.js';
import { getMeta } from '../utils/cinemeta.js';
import * as tmdb from '../utils/tmdb.js';
import { resolveSearchNames, filterRelevantRaw } from '../utils/format.js';
import { runPtSweep } from './harvest-sweep.js';
import * as releaseIndex from '../utils/release-index.js';
import { brTransition, invalidateStreamsForObra, hasBrDubbed, newBrDubbedReleases, probeFoundViable, BR_GAP_TARGET_QUALITY } from '../utils/br-gap.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { buildWorkQueries } from './harvest-queries.js';
import { queueRdWarmForRelevant } from './harvest-warmer.js';
import { applyPtTitleDual } from './pt-title-dual.js';
import { probeIndexers, probeRunWaitMs } from './br-probe.js';
import * as harvesterLive from '../utils/harvester-live.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import type { HarvestEntry } from './harvest-queue.js';

type RecentWork = Pick<HarvestEntry, 'imdbId' | 'type' | 'season' | 'episode'> & { at: number; recorded: number };

// Balde da hora civil UTC no L1/L2: sem isto, restart/deploy zera o Map e o
// colhedor pode estourar HARVEST_MAX_HOUR de novo na mesma hora (risco de ban).
const HOUR_KEY = `${prefix('harvest')}hour`;

type HourBucket = { hour: number; count: number };

// Pausa é operacional e deliberadamente não persiste: após restart o operador
// volta ao comportamento configurado no .env, sem uma ação temporária virar
// desligamento esquecido. (O estado de pausa do módulo vive no harvester.ts;
// aqui ficam só os contadores do trabalho executado.)
let harvested = 0;
let lastRunAt = 0;
const recentWorks: RecentWork[] = [];
const hourBuckets = new Map<number, number>();
const lastQueryAt = new Map<string, number>();

/** Segundos até o fim do balde + folga curta; mínimo 60 para o L2 não sumir na virada. */
function hourBucketTtlSeconds(hour: number): number {
  const endMs = (hour + 1) * 3_600_000;
  const secondsLeft = Math.ceil((endMs - Date.now()) / 1000) + 60;
  return Math.max(60, secondsLeft);
}

function hydrateCurrentHour(hour: number) {
  if (hourBuckets.has(hour)) return;
  const stored = cache.get(HOUR_KEY) as HourBucket | undefined;
  if (
    stored &&
    stored.hour === hour &&
    typeof stored.count === 'number' &&
    Number.isFinite(stored.count) &&
    stored.count > 0
  ) {
    hourBuckets.set(hour, stored.count);
  }
}

export function queriesThisHour() {
  const hour = Math.floor(Date.now() / 3_600_000);
  for (const bucket of [...hourBuckets.keys()]) {
    if (bucket < hour) hourBuckets.delete(bucket);
  }
  hydrateCurrentHour(hour);
  return hourBuckets.get(hour) || 0;
}

/** Anota consultas no balde da hora e persiste no cache (só este contador é durável). */
export function noteQueries(count: number) {
  const hour = Math.floor(Date.now() / 3_600_000);
  // Incremento parte do balde hidratado — senão um noteQueries sem leitura
  // prévia sobrescreveria o L2 com só o delta desta obra.
  hydrateCurrentHour(hour);
  const next = (hourBuckets.get(hour) || 0) + count;
  hourBuckets.set(hour, next);
  cache.set(HOUR_KEY, { hour, count: next } satisfies HourBucket, hourBucketTtlSeconds(hour));
}

/** Zera só o Map — testes simulam processo novo; o L1/L2 permanece. */
export function clearHourBuckets() {
  hourBuckets.clear();
}

async function awaitIndexerGap(indexer: string) {
  const gap = Date.now() - (lastQueryAt.get(indexer) || 0);
  const delay = harvesterLive.effective().harvestIndexerDelayMs;
  if (gap < delay) {
    // SEM unref, diferente do wait() do common.ts: aquele só roda dentro de uma
    // requisição, onde o servidor segura o event loop. Este roda no colhedor,
    // trabalho de FUNDO — com unref o Node encerra o loop com a promise ainda
    // pendente e o await nunca volta, travando a obra no meio. O preço é o
    // shutdown esperar no máximo um indexerDelayMs.
    await new Promise((resolve) => setTimeout(resolve, delay - gap));
  }
}

/** Reexportado do irmão para preservar a superfície pública (testes/painel). */
export { sliceSweepFatia, resetSweepCursor } from './harvest-sweep.js';

export async function harvestOne(entry: HarvestEntry): Promise<{ ok: boolean; capped: boolean; preempted: boolean; added: number; brFound: boolean; responded: number }> {
  const startedAt = Date.now();
  const live = harvesterLive.effective();
  // Modo dirigido da sonda (Fase 4): consulta SÓ a interseção index-only∩pt-BR,
  // um por vez, pelos MESMOS controles do colhedor (teto, intervalo, breaker,
  // orçamento dedicado e o registro/transição do índice). Não é um segundo
  // worker — é o worker existente com escopo reduzido.
  const directed = entry.brProbe === true;
  // Urgência operacional (Fase 4/5): `next-episode` é play real e brProbe é a
  // lacuna provada pela sonda. AMBOS furam SÓ o gate de inatividade — teto
  // horário, intervalo por indexer, breaker e worker único continuam valendo.
  const urgent = directed || entry.reason === 'next-episode';
  const [meta, titles] = await Promise.all([getMeta(entry.type, entry.imdbId), tmdb.getTitles(entry.imdbId)]);
  const searchMeta = resolveSearchNames({ meta, titles, imdbId: entry.imdbId });
  if (!searchMeta?.name) return { ok: false, capped: false, preempted: false, added: 0, brFound: false, responded: 0 };
  const matchContext = {
    names: searchMeta.names,
    year: searchMeta.year,
    // Pelo TIPO, não pela temporada: obra semeada pela lista de populares
    // entra sem temporada, e `isSeries: false` aplicaria a precisão de título
    // de FILME numa série. Para quem já vinha com temporada, é equivalente.
    isSeries: entry.type === 'series',
    season: entry.season ?? null,
    episode: entry.episode ?? null,
  };
  const { query, ptQuery, originalQuery } = buildWorkQueries(entry, searchMeta, titles);

  const indexers = directed ? probeIndexers() : [...new Set(config.jackett.indexers)];
  let attempted = 0;
  let capped = false;
  let preempted = false;
  let succeeded = 0;
  // Sonda dirigida (Fase 4): só uma resposta VÁLIDA autoriza `empty`.
  let responded = 0;
  const collected: any[] = [];

  // Varredura pt-BR nos globais, ANTES do laço de propósito: ver harvest-sweep.
  const sweep = await runPtSweep({
    entry,
    titles,
    matchContext,
    indexers,
    directed,
    urgent,
    harvestMaxPerHour: live.harvestMaxPerHour,
    harvestIdleWindowMs: live.harvestIdleWindowMs,
    queriesThisHour: queriesThisHour(),
    awaitGap: awaitIndexerGap,
    markQueried: (target) => lastQueryAt.set(target, Date.now()),
  });
  attempted += sweep.attempted;
  succeeded += sweep.succeeded;
  collected.push(...sweep.items);

  if (directed) {
    metrics.count('autofetch.brProbe.run');
    // Idade scheduled -> run da sonda (do `pending` gravado até esta execução).
    const wait = probeRunWaitMs(entry);
    if (wait != null && wait >= 0) metrics.observe('autofetch.brProbe.runWaitMs', wait);
  }
  for (const indexer of indexers) {
    // Freio de atividade no MEIO da obra também: tráfego chegou, solta o
    // Jackett na hora (o que já foi coletado entra no índice mesmo assim).
    // O sinal é preempção, não teto: o ciclo devolve a obra à frente da fila
    // sem contar tentativa (tráfego não é falha dela) nem eficácia de
    // meia-obra.
    if (!urgent && activity.recentUserTraffic(live.harvestIdleWindowMs)) {
      preempted = true;
      break;
    }
    // O breaker pertence ao caminho ao vivo; aqui ele é apenas consumido
    // (recordStatus:false). Indexer com circuito aberto não deve pagar slot de
    // cota nem contar como sucesso — o próprio jackett.search economizaria a
    // consulta, mas a contabilidade (attempted/succeeded) não. O lastQueryAt
    // segue marcado para o gap continuar coerente: na meia-abertura o indexer
    // volta a respeitar o intervalo mínimo, como o search fazia ao devolver []
    // pelo breaker.
    if (jackett.breakerTripped(indexer)) {
      lastQueryAt.set(indexer, Date.now());
      continue;
    }
    if (queriesThisHour() + attempted >= live.harvestMaxPerHour) {
      // A obra sai DAQUI pela metade: quem a desenfileirou precisa saber, senão
      // ela é dada por colhida com meia dúzia de indexers e nunca mais volta.
      capped = true;
      log.debug('[harvest] teto horário atingido');
      break;
    }
    // Intervalo mínimo entre consultas ao MESMO indexer: educação básica.
    await awaitIndexerGap(indexer);
    attempted += 1;
    // Index-only recebem orçamento TOTAL dedicado (busca + resolução /dl):
    // latência medida de 12–19s contra o budgetFor comum derrubava-os antes
    // de qualquer resultado. Indexer comum NUNCA o recebe — o colhedor não é
    // porta de fuga para esticar o prazo de ninguém além dos isolados.
    const indexOnly = config.jackett.indexOnlyIndexers.includes(indexer);
    try {
      // Direção da cascata no colhedor (DELIBERADAMENTE invertida do vivo):
      // aqui a primária é a query mainstream (EN) e o fallback do BR é o
      // título pt — no vivo a primária BR é pt e o fallback é o EN. O gate do
      // degrau original (queryIndexer: `isBr && fallbackQuery`) usa a presença
      // do fallback pt, então "pt útil" tem que significar pt DIFERENTE da
      // query: quando a query já É o título pt (Cinemeta 404 cai no próprio
      // pt), o fallback some e o degrau original NÃO é suprimido.
      const items = await jackett.search(query, entry.type, [indexer], {
        matchContext,
        recordStatus: false,
        fallbackQuery: ptQuery && ptQuery !== query ? ptQuery : undefined,
        originalQuery: originalQuery || undefined,
        // Descoberta do índice: zero-sobrevivente aqui é sonda negativa,
        // não desperdício do caminho de resposta (ver jackett.search).
        background: true,
        ...(indexOnly ? { timeoutMs: config.jackett.indexOnlyHarvestTimeout } : {}),
        // Observabilidade da sonda: só conta resposta VÁLIDA do indexer (HTTP +
        // envelope sadios). O callback não mexe em status nem no breaker.
        ...(directed
          ? { onQueryResult: (info: { responded: boolean }) => { if (info.responded) responded += 1; } }
          : {}),
      });
      lastQueryAt.set(indexer, Date.now());
      if (!directed) succeeded += 1;
      collected.push(...items.filter((i: any) => !i.fromAccount));
    } catch (err: unknown) {
      lastQueryAt.set(indexer, Date.now());
      log.warn(`[harvest] ${indexer} falhou para ${entry.imdbId}:`, log.errorMessage(err));
    }
  }

  const bludvQuery = ptQuery || query;
  if (!directed && config.bludv.enabled && bludvQuery) {
    try {
      collected.push(...(await bludv.search(bludvQuery)).filter((i: any) => !i.fromAccount));
    } catch (err: unknown) {
      log.warn('[harvest] bludv falhou:', log.errorMessage(err));
    }
  }

  // O teto horário só fecha a conta se as consultas forem ANOTADAS: este
  // chamado faltava e o acumulador vivia vazio — queriesThisHour() devolvia
  // sempre 0 e HARVEST_MAX_HOUR não segurava nada entre obras (o guard do
  // tick via um balde eternamente limpo). Só consultas ao Jackett contam,
  // na mesma moeda dos guards; uma única anotação no fim cobre loop e
  // varredura.
  noteQueries(attempted);

  // No modo dirigido o DUAL titulado em PT de tracker global ganha a marca BR
  // antes do filtro/registro: os sites BR já carimbam `isBr`, mas a prova por
  // título é a mesma rede de segurança do pipeline vivo — sem ela a release só
  // "Dual" ficaria de fora de um índice que a sonda existe para preencher.
  const collectedForIndex = directed
    ? applyPtTitleDual(collected, { titles }).map((item) => (item?.ptTitleDual ? { ...item, isBr: true } : item))
    : collected;
  const relevant = filterRelevantRaw(collectedForIndex, matchContext as any);
  // Registro PARCIAL quando a colheita saiu pela metade (teto horário ou
  // preempção por tráfego): a obra volta à fila e o fast-path da busca fica
  // bloqueado até uma gravação completa regravar (last-write-wins limpa o
  // flag). Falha de rede e varredura pt parcial NÃO marcam — o laço seguiu.
  const location = { season: entry.season, episode: entry.episode };
  // A lista `streams:vN` guardada antes de existir BR ou antes do upgrade de
  // faixa não pode sobreviver até o TTL: a próxima abertura deve reconstruir
  // a resposta a partir do índice enriquecido pelo colhedor.
  const beforeReleases = releaseIndex.lookupQuiet(entry.imdbId, location);
  // A sonda SUPLEMENTA o índice, não o cobre: o subset indexOnly∩pt-BR não é a
  // obra inteira. Então o registro dirigido nunca LIMPA o partial de um
  // registro existente e, quando não havia registro algum, nasce parcial —
  // senão o fast-path trataria o subset como cobertura completa.
  const directedPartial = directed && (releaseIndex.isPartial(entry.imdbId, location) || beforeReleases.length === 0);
  const added = releaseIndex.record(entry.imdbId, location, relevant, {
    partial: capped || preempted || directedPartial,
  });
  const afterReleases = releaseIndex.lookupQuiet(entry.imdbId, location);
  const transition = brTransition(beforeReleases, afterReleases);
  if (transition !== 'none') {
    const cleared = invalidateStreamsForObra(entry.imdbId);
    metrics.count(transition === 'br' ? 'harvest.transition.br' : 'harvest.transition.brUpgrade');
    if (directed) metrics.count('autofetch.brProbe.transition');
    if (cleared > 0) {
      metrics.count(transition === 'br' ? 'harvest.transition.br.invalidated' : 'harvest.transition.brUpgrade.invalidated', cleared);
    }
  }
  queueRdWarmForRelevant(relevant);
  // `found` só de evidência NOVA e VIÁVEL produzida por esta execução. BR antiga
  // no índice (ou nova de 0 seeders / faixa errada no upgrade) NÃO finaliza
  // found: o tick decide empty/failed pelo `responded`. Upgrade exige a faixa
  // alvo (1080p); ausência exige seeders > 0 (fontes BR usam placeholder 1, e
  // 0 é inviável).
  const upgradeProbe = hasBrDubbed(beforeReleases);
  const brFound = probeFoundViable(beforeReleases, afterReleases, upgradeProbe ? { requireQuality: BR_GAP_TARGET_QUALITY } : {});
  if (!brFound && newBrDubbedReleases(beforeReleases, afterReleases).length > 0) {
    metrics.count('autofetch.brProbe.found.unviable');
  }
  // Obra preemptada volta à fila: contar harvested / lastRunAt / recentWorks
  // aqui dobraria a eficácia (meia-colheita + conclusão) e listaria meia
  // obra no painel. O tempo gasto (harvest.ms) continua real em ambos.
  if (!preempted) {
    harvested += 1;
    lastRunAt = Date.now();
    if (config.harvest.dashboardLastWorks > 0) {
      recentWorks.unshift({
        at: lastRunAt,
        imdbId: entry.imdbId,
        type: entry.type,
        season: entry.season ?? null,
        episode: entry.episode ?? null,
        recorded: added,
      });
      recentWorks.length = Math.min(recentWorks.length, config.harvest.dashboardLastWorks);
    }
  }
  const elapsed = Date.now() - startedAt;
  metrics.observe('harvest.ms', elapsed);
  if (directed) metrics.observe('autofetch.brProbe.ms', elapsed);
  // `responded` só existe no modo dirigido; no normal vale a semântica antiga.
  const ok = added > 0 || (directed ? responded > 0 : succeeded > 0);
  return { ok, capped, preempted, added, brFound, responded };
}

/** Contadores do trabalho executado, para o status do painel. */
export function stats() {
  return {
    harvested,
    lastRunAt,
    recentWorks: recentWorks.map((entry) => ({ ...entry })),
  };
}
