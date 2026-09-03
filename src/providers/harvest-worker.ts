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
import {
  resolveSearchNames,
  buildSearchQuery,
  filterRelevantRaw,
  extractInfoHash,
  looksPtBr,
  audioFromTitle,
  explicitPtAudio,
} from '../utils/format.js';
import { ptSweepIndexers, ptSweepQueryFor } from './search-plan.js';
import * as releaseIndex from '../utils/release-index.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import rdWarmer from './rd-warmer.js';
import * as harvesterLive from '../utils/harvester-live.js';
import type { HarvestEntry } from './harvest-queue.js';

type RecentWork = Pick<HarvestEntry, 'imdbId' | 'type' | 'season' | 'episode'> & { at: number; recorded: number };

// Pausa é operacional e deliberadamente não persiste: após restart o operador
// volta ao comportamento configurado no .env, sem uma ação temporária virar
// desligamento esquecido. (O estado de pausa do módulo vive no harvester.ts;
// aqui ficam só os contadores do trabalho executado.)
let harvested = 0;
let lastRunAt = 0;
const recentWorks: RecentWork[] = [];
const hourBuckets = new Map<number, number>();
const lastQueryAt = new Map<string, number>();

export function queriesThisHour() {
  const hour = Math.floor(Date.now() / 3_600_000);
  for (const bucket of [...hourBuckets.keys()]) {
    if (bucket < hour) hourBuckets.delete(bucket);
  }
  return hourBuckets.get(hour) || 0;
}

function noteQueries(count: number) {
  const hour = Math.floor(Date.now() / 3_600_000);
  hourBuckets.set(hour, (hourBuckets.get(hour) || 0) + count);
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

export async function harvestOne(entry: HarvestEntry): Promise<{ ok: boolean; capped: boolean; added: number }> {
  const startedAt = Date.now();
  const live = harvesterLive.effective();
  const [meta, titles] = await Promise.all([getMeta(entry.type, entry.imdbId), tmdb.getTitles(entry.imdbId)]);
  const searchMeta = resolveSearchNames({ meta, titles, imdbId: entry.imdbId });
  if (!searchMeta?.name) return { ok: false, capped: false, added: 0 };
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
  const query = buildSearchQuery(searchMeta, { season: entry.season ?? null, episode: entry.episode ?? null });
  const ptQuery = titles?.pt && titles.pt !== titles.original
    ? buildSearchQuery({ name: titles.pt, year: titles.year }, { season: entry.season ?? null, episode: entry.episode ?? null })
    : null;

  const indexers = [...new Set(config.jackett.indexers)];
  let attempted = 0;
  let capped = false;
  let succeeded = 0;
  const collected: any[] = [];

  // Varredura pt-BR nos globais, ANTES do laço de propósito: é a consulta de
  // maior valor por unidade (uma chamada agrupada que acha o dublado titulado
  // em PT, que a query em inglês nunca encontra), então quando o teto horário
  // cortar, quem fica pelo caminho é a cauda do laço — não ela. Na ordem
  // antiga o guard somava as consultas do laço e a varredura era a primeira
  // sacrificada: com 19 indexers e 12 alvos contra teto de 30, ela NUNCA
  // rodava.
  //
  // Varredura pt-BR nos globais, a mesma da busca ao vivo: o dublado
  // titulado em PT mora em tracker global e a query em inglês não o encontra
  // — sem isto o índice ficava sistematicamente cego para a release que só a
  // varredura acha, e o colhedor não a entregava nunca. Divergência DE
  // PROPÓSITO do caminho ao vivo: aqui o breaker é RESPEITADO (sem
  // ignoreBreaker) — colheita de fundo não precisa acordar indexer
  // recém-derrubado, o dublado raro espera o cooldown.
  const sweepQuery = config.jackett.ptSweepGlobal ? ptSweepQueryFor({ titles }) : null;
  const sweepTargets =
    sweepQuery && !activity.recentUserTraffic(live.harvestIdleWindowMs)
      ? ptSweepIndexers(indexers, config.jackett.ptBrIndexers)
      : [];
  if (sweepQuery && sweepTargets.length > 0) {
    // A varredura agrupada dispara uma consulta HTTP por alvo: conta no teto
    // com a mesma moeda do loop acima, antes de decidir. A fatia parcial
    // permite colher o que couber no orçamento em vez de tudo-ou-nada.
    const restante = live.harvestMaxPerHour - queriesThisHour();
    const fatia = restante > 0 ? sweepTargets.slice(0, restante) : [];
    if (!fatia.length) {
      log.debug('[harvest] teto horário atingido antes da varredura pt');
    } else {
      for (const target of fatia) {
        await awaitIndexerGap(target);
      }
      attempted += fatia.length;
      metrics.count('harvest.sweep');
      if (fatia.length < sweepTargets.length) {
        metrics.count('harvest.sweep.partial');
      }
      try {
        const items = await jackett.search(sweepQuery, entry.type, fatia, {
          matchContext,
          recordStatus: false,
          // Descoberta do índice: zero-sobrevivente aqui é sonda negativa,
          // não desperdício do caminho de resposta (ver jackett.search).
          background: true,
        });
        for (const target of fatia) {
          lastQueryAt.set(target, Date.now());
        }
        succeeded += fatia.length;
        collected.push(...items.filter((i: any) => !i.fromAccount));
      } catch (err: unknown) {
        for (const target of fatia) {
          lastQueryAt.set(target, Date.now());
        }
        log.warn('[harvest] varredura pt falhou:', log.errorMessage(err));
      }
    }
  }

  for (const indexer of indexers) {
    // Freio de atividade no MEIO da obra também: tráfego chegou, solta o
    // Jackett na hora (o que já foi coletado entra no índice mesmo assim).
    if (activity.recentUserTraffic(live.harvestIdleWindowMs)) break;
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
    try {
      const items = await jackett.search(query, entry.type, [indexer], {
        matchContext,
        recordStatus: false,
        fallbackQuery: ptQuery || undefined,
        // Descoberta do índice: zero-sobrevivente aqui é sonda negativa,
        // não desperdício do caminho de resposta (ver jackett.search).
        background: true,
      });
      lastQueryAt.set(indexer, Date.now());
      succeeded += 1;
      collected.push(...items.filter((i: any) => !i.fromAccount));
    } catch (err: unknown) {
      lastQueryAt.set(indexer, Date.now());
      log.warn(`[harvest] ${indexer} falhou para ${entry.imdbId}:`, log.errorMessage(err));
    }
  }

  const bludvQuery = ptQuery || query;
  if (config.bludv.enabled && bludvQuery) {
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

  const relevant = filterRelevantRaw(collected, matchContext as any);
  const added = releaseIndex.record(entry.imdbId, { season: entry.season, episode: entry.episode }, relevant);
  if (config.debrid.rdWarm.enabled && rdWarmer.rdInPlay() && relevant.length) {
    const scoresByHash = new Map<string, number>();
    for (const r of relevant) {
      const title = String(r.title || r.Title || '');
      const hash = String(extractInfoHash(r.infoHash || r.magnet || r.MagnetUri || r.Guid || r.hash) || '').toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(hash)) continue;
      const isBr = Boolean(r.isBr) || looksPtBr(title);
      const audio = audioFromTitle(title);
      const dubbed = Boolean(r.dubbed) || ['Dublado', 'Dual', 'Nacional'].includes(String(audio)) || explicitPtAudio(title);
      const score = isBr && dubbed ? 80 : (dubbed ? 40 : 5);
      const existing = scoresByHash.get(hash);
      if (existing === undefined || score > existing) {
        scoresByHash.set(hash, score);
      }
    }
    const topReleases = [...scoresByHash.entries()]
      .map(([hash, score]) => ({ hash, score }))
      .sort((a, b) => b.score - a.score);
    for (const item of topReleases.slice(0, 10)) {
      rdWarmer.enqueue([item.hash], item.score);
    }
  }
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
  metrics.observe('harvest.ms', Date.now() - startedAt);
  return { ok: added > 0 || succeeded > 0, capped, added };
}

/** Contadores do trabalho executado, para o status do painel. */
export function stats() {
  return {
    harvested,
    lastRunAt,
    recentWorks: recentWorks.map((entry) => ({ ...entry })),
  };
}
