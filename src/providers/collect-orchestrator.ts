import config from '../config.js';
import type { MatchContext } from '../../types/domain.js';
import * as demo from './demo.js';
import jackett, { effectiveJackettIndexers } from './jackett.js';
import prowlarr from './prowlarr.js';
import bludv from './bludv.js';
import * as torrentio from './torrentio.js';
import * as mico from './mico.js';
import * as account from './account.js';
import debrid from '../debrid/index.js';
import { planJackettQueries, liveIndexers } from './search-plan.js';
import { collectWithinWindow } from './collection-window.js';
import { computeCollectionBudget, computePriorityGrace } from './collection-budget.js';
import { opts } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { SAFE_INDEXER_ID, stageFirstTiming } from './stream-builder.js';
import type { FirstObserverState } from './stream-builder.js';
import { poolCovered } from './search-pool-coverage.js';
import type { StreamTraceState } from '../utils/stream-trace.js';
import { createLiveIndexerState, ALL_QUERY_INDEXER } from './live-indexer-state.js';
import type { LiveIndexerState } from './live-indexer-state.js';

export async function collectRaw(
  query: string,
  type: string,
  imdbId: string,
  ptQuery: string | null,
  matchContext: MatchContext,
  onLate: ((items: any[], grew: boolean, partial?: boolean, live?: LiveIndexerState | null) => any) | null,
  sweepQuery: string | null = null,
  deadlineAt: number | null = null,
  taskScope: 'all' | 'priority' | 'nonpriority' = 'all',
  /** Observador da primeira resposta (Fase 2). Passado apenas no caminho de
   * resposta; tails (`deadlineAt` null) não estagiam. Sem ele, a coleta mede
   * envelopes, mas não os registra em lugar nenhum. */
  firstObserver?: FirstObserverState | null,
  trace?: StreamTraceState | null,
  /** Título original (TMDB), degrau SEQUENCIAL opcional da cascata — nunca
   * tarefa paralela. A regra de execução mora no queryIndexer (global sempre;
   * BR só sem fallback pt-BR). */
  originalQuery: string | null = null,
  /** Raiz da coleção multiobra (TMDB), degrau SEQUENCIAL só nos indexers BR;
   * null/ausente = feature desligada (kill-switch) ou sem evidência de coleção. */
  multiWorkQuery: string | null = null,
) {
  const { providers } = opts();
  const mode = providers.includes('both') ? 'both' : providers[0] || config.provider;
  // I0 — relógio comum de UMA invocação de coleta. Cada grupo (BR/global) mede
  // o envelope do início até os SEUS tasks assentarem (limitado ao momento em
  // que o `collectWithinWindow` devolve): mede quanto da JANELA DA RESPOSTA o
  // grupo consumiu, não o trabalho que seguiu no tail. Invocações sequenciais
  // (episódio + fallback de pack) SOMAM os envelopes. Grupos NÃO são somados
  // entre si. Conta/índice são residuais no `total`, não global nem BR.
  const collectStart = Date.now();
  const grpBr = { present: false, pending: 0, maxSettle: 0 };
  const grpGlobal = { present: false, pending: 0, maxSettle: 0 };
  const tasks: { promise: Promise<any>; priority: boolean; source?: string }[] = [];
  // Estado vivo de falha por indexer (Etapa 4). Alimentado pelo `onQueryResult`
  // só nas consultas PRINCIPAIS (`recordStatus !== false`); a varredura pt-BR e
  // o caminho de fundo ficam de fora para não contaminar o fallback. O objeto
  // viaja no RawBatch e o callback tardio o muta — é isso que remove o fallback
  // do indexer assim que ele responde.
  const live = createLiveIndexerState();
  const addTask = (create: () => Promise<any>, priority = false, source?: string) => {
    if (taskScope === 'priority' && !priority) return;
    if (taskScope === 'nonpriority' && priority) return;
    const promise = create();
    tasks.push({ promise, priority, source });
    // Classificação: priority → BR; source='account' → neutra (excluída); o
    // resto → global. Só instrumentamos quando há prazo (passo de resposta).
    if (deadlineAt != null) {
      const g = priority ? grpBr : source !== 'account' ? grpGlobal : null;
      if (g) {
        g.present = true;
        g.pending += 1;
        const settle = () => { g.maxSettle = Math.max(g.maxSettle, Date.now()); g.pending -= 1; };
        Promise.resolve(promise).then(settle, settle);
      }
    }
  };
  let sweepInline = false;

  // Demo é um provider único, sem tarefas internas — trata-se como faixa global
  // (o envelope é a própria busca demo com prazo).
  if (mode === 'demo') {
    const items = await demo.search({ type, imdbId });
    if (deadlineAt != null) {
      stageFirstTiming(firstObserver, 'global', Date.now() - collectStart);
    }
    return {
      items, partial: false, completion: Promise.resolve(), sweepInline: false, live: null,
    };
  }

  const wants = (name: string) => mode === 'both' || providers.includes(name);
  const rawSelected: string[] = [...new Set((opts().jackettIndexers || []).filter((id: any) =>
    SAFE_INDEXER_ID.test(String(id)),
  ))].map(String);
  // Index-only ficam fora do caminho da resposta (colhem em fundo para o
  // índice). O filtro é ANTES do plano: se o operador mandou todos os
  // selecionados embora, o resultado é NENHUMA consulta Jackett — cair no
  // fallback `/all` reabriria a porta que o filtro acabou de fechar.
  // O card `mico` mora no `ji` mas não é do Jackett: sai daqui e vira tarefa
  // própria abaixo. Selecionar SÓ ele não pode cair no ramo "sem seleção", que
  // consultaria a lista inteira do operador.
  const jackettSelected = mico.jackettOnly(rawSelected);
  const selectedIndexers = liveIndexers(jackettSelected, config.jackett.indexOnlyIndexers, config.jackett.liveExemptIndexers);
  if (selectedIndexers.length < jackettSelected.length) {
    metrics.count('search.indexonly.excluded', jackettSelected.length - selectedIndexers.length);
  }

  // demo sempre disponível como fallback de teste se quiser both+demo — aqui só jackett/prowlarr
  if (wants('jackett')) {
    if (rawSelected.length > 0 && jackettSelected.length === 0) {
      // Só o card do Mico selecionado: nenhuma consulta ao Jackett.
    } else if (jackettSelected.length > 0 && selectedIndexers.length === 0) {
      // Todos os selecionados são index-only: a resposta sai do índice +
      // inventário; a obra entra na fila do colhedor pelo caminho de sempre.
      metrics.count('search.indexonly.all');
    } else if (selectedIndexers.length === 0) {
      // Sem seleção do usuário, `jackett.search(..., null, options)` usa a
      // config do operador — no caso comum ainda vai por-indexer e consome
      // `originalQuery`/`matchContext` normalmente. Só quando a config está
      // EFETIVAMENTE vazia é que cai no agregado puro `/all`, que não suporta
      // a cascata (uma chamada só). A decisão usa a MESMA regra real do
      // `jackett.search` (`effectiveJackettIndexers`): marcar `/all` com a
      // config povoada deixaria um `all pending` fantasma e o fallback cobriria
      // sources que nunca foram consultadas.
      const effective = effectiveJackettIndexers(null);
      if (effective.length === 0) live.noteAllStart();
      else live.noteStart(effective);
      addTask(() => jackett.search(query, type, null, {
        originalQuery: originalQuery || undefined, matchContext, imdbId,
        season: matchContext.season, episode: matchContext.episode, resetPassedFilter: true,
        onQueryResult: (info: any) => live.noteResult(info),
      }));
    } else {
      const plan = planJackettQueries(
        query,
        ptQuery,
        selectedIndexers,
        config.jackett.ptBrIndexers,
        config.jackett.slowIndexers,
        sweepQuery,
        originalQuery,
        multiWorkQuery,
      );
      for (const planned of plan) {
        const priority = planned.indexers.some((indexer) =>
          config.jackett.ptBrIndexers.includes(indexer),
        );
        // A varredura inline é a task AGRUPADA marcada ESTRUTURALMENTE pelo
        // plano (`sweep:true`) — nunca inferida por `query === sweepQuery`: a
        // task BR isolada pode ter exatamente a mesma query (filme sem ano, em
        // que a raiz pt coincide com a varredura) e continua sendo consulta
        // PRINCIPAL, que registra status e alimenta o fallback.
        const inlineSweep = planned.sweep === true;
        if (inlineSweep) sweepInline = true;
        addTask(() => {
          // `recordStatus:false` (varredura inline) não alimenta o estado vivo:
          // a falha dela não pode pintar de falho um indexer que a busca
          // principal viu de pé. O fallback só cobre consulta principal.
          if (!inlineSweep) live.noteStart(planned.indexers);
          return jackett.search(planned.query, type, planned.indexers, {
            fallbackQuery: planned.fallback,
            variantQuery: planned.variant,
            franchiseQuery: planned.franchise,
            multiWorkQuery: planned.multiWork,
            originalQuery: planned.original,
            matchContext,
            // Obra da busca para o banco de magnets vivo (captura por item).
            // Coleta viva: o build abaixo roda o filtro e escreve o resultado.
            imdbId,
            season: matchContext.season,
            episode: matchContext.episode,
            resetPassedFilter: true,
            // A mesma busca principal atualiza o status deste indexer. Falha da
            // variante pt-BR não pode sobrescrever aquele resultado como offline.
            recordStatus: inlineSweep ? false : undefined,
            ...(inlineSweep ? {} : { onQueryResult: (info: any) => live.noteResult(info) }),
            // Coleta com prazo é caminho de resposta; sem prazo é cauda
            // (enriquecimento do índice, pack tardio) — desperdício vai para o
            // balde de fundo, não para o da resposta.
            background: deadlineAt == null,
          });
        }, priority);
      }
    }
  }
  if (wants('prowlarr')) {
    addTask(() => prowlarr.search(query));
  }
  // Pool global Torrentio (Fase 1). Endpoint público, sem config/debrid; o
  // `matchContext` já carrega season/episódio da obra. A fonte entra no mesmo
  // balde dos indexers e respeita o orçamento da coleta.
  if (wants('torrentio') && config.torrentio.enabled) {
    addTask(() => torrentio.search({
      type,
      imdbId,
      season: matchContext.season,
      episode: matchContext.episode,
    }));
  }

  // Se misconfigurou PROVIDER, tenta jackett
  const validProvider = providers.some((name: string) =>
    ['jackett', 'prowlarr', 'torrentio', 'demo', 'both'].includes(name));
  if (tasks.length === 0 && providers.length > 0 && !validProvider) {
    // Mesma semântica dos branches acima: com `config.jackett.indexers`
    // povoada, as options (cascata) valem normalmente; o agregado puro `/all` —
    // só atingido com a config vazia — é que não as consome. Seja por-indexer
    // ou agregado, o estado vivo precisa refletir a consulta (o provider
    // inválido AINDA passa pelo Jackett).
    const effective = effectiveJackettIndexers(null);
    if (effective.length === 0) live.noteAllStart();
    else live.noteStart(effective);
    addTask(() => jackett.search(query, type, null, {
      originalQuery: originalQuery || undefined, matchContext, imdbId,
      season: matchContext.season, episode: matchContext.episode, resetPassedFilter: true,
      onQueryResult: (info: any) => live.noteResult(info),
    }));
  }

  // Card Mico: consulta por IMDb, fora do Jackett. Tarefa BR (prioritária)
  // como a do bludv — acervo dublado, pode chegar depois do prazo e entrar no
  // passe tardio. Sem `ji` na instalação, vale o padrão do operador.
  const wantsMico = rawSelected.length > 0 ? rawSelected.includes(mico.MICO_ID) : config.mico.default;
  if (wants('jackett') && wantsMico && config.mico.enabled) {
    // Entra no estado vivo como um indexer: se o Mico cair ou não responder no
    // prazo, a reserva do acervo (📦) cobre os hashes que ele já trouxe.
    live.noteStart([mico.MICO_ID]);
    addTask(() => mico.search({
      type,
      imdbId,
      season: matchContext.season,
      episode: matchContext.episode,
    }, {
      resetPassedFilter: true,
      onQueryResult: (info) => live.noteResult(info),
    }), true);
  }

  // Fonte BR dublada, independente do PROVIDER: entra no mesmo allSettled,
  // então se o site cair ou demorar, o resto da busca sai normalmente.
  if (config.bludv.enabled) {
    // Sites BR indexam por título pt-BR ("Coringa", não "Joker").
    addTask(() => bludv.search(ptQuery || query), true);
  }

  // A conta do debrid como fonte: o que já está pronto lá entra com ⚡ sem
  // indexer nenhum. Teto curto dentro da própria tarefa (ver account.js)
  // para a primeira leitura não segurar a resposta.
  const accountSource = config.debrid.inventorySource && Boolean(debrid.current());
  if (accountSource) {
    addTask(() => account.search(matchContext, trace), false, 'account');
  }

  // Orçamento e graça vêm de `collection-budget.ts` — fórmula única, testada
  // direto contra a produção (piso de 500ms do budget; graça sai da reserva sem
  // invadir o piso do debrid). A justificativa completa mora no próprio módulo.
  const budget = computeCollectionBudget(deadlineAt);
  const priorityGrace = computePriorityGrace();
  let watchLate = false;
  let firstLateBatch = false;
  let lateQueue = Promise.resolve();
  // Fast-path da conta: inventário suficiente responde NA HORA e o resto da
  // coleta segue em fundo. A resposta sai partial de propósito — é isso que
  // faz o passe tardio promovê-la quando os indexers fecharem.
  const fastPathOn = config.accountFastPath.enabled && accountSource;
  // Quando o índice já cobre a obra, a primeira resposta ainda pode esperar
  // somente os BR vivos: eles são a parte que o índice não sabe atualizar. Os
  // globais ficam no enriquecimento, sem transformar um hit do índice em uma
  // espera pelo caminho inteiro nem consultar index-only.
  const collected = await collectWithinWindow(tasks, {
    budgetMs: budget,
    priorityGraceMs: priorityGrace,
    graceRequiresItems: type !== 'movie',
    stopWhen: fastPathOn
      ? (batch: any[], _items: any[], meta: any) => {
        if (meta?.source !== 'account' || !Array.isArray(batch)) return false;
        if (batch.length < config.accountFastPath.minReleases) {
          metrics.count('search.fastPath.skipped');
          return false;
        }
        const userPreferDubbed = opts().preferDubbed;
        if (userPreferDubbed) {
          const covered = poolCovered(batch, { season: matchContext.season, requireDubbed: true });
          if (!covered) {
            metrics.count('search.fastPath.skipped');
            return false;
          }
        }
        metrics.count('search.account.sufficient');
        metrics.count('search.fastPath');
        metrics.count('search.fastPath.covered');
        log.info(`[search] conta suficiente (${batch.length} release(s)); respondendo sem esperar a coleta`);
        return true;
      }
      : undefined,
    onError: (err) => log.warn('[search] provider falhou:', err?.message || err),
    onBatch: (batch, allItems) => {
      if (!watchLate || firstLateBatch || !batch.length || !onLate) return;
      firstLateBatch = true;
      const snapshot = [...allItems];
      log.info(`[search] primeira fonte tardia chegou; recacheando ${snapshot.length} resultado(s)`);
      // Atualiza cedo a lista que o cliente está repetindo, mas mantém partial:
      // outros indexers ainda trabalham e a promoção definitiva vem abaixo.
      lateQueue = Promise.resolve(onLate(snapshot, true, true, live)).catch((err) => {
        log.warn('[search] passe tardio intermediário falhou:', err?.message || err);
      });
    },
  });
  if (collected.stoppedEarly) log.info(`[search] fast-path da conta: resposta antecipada com ${collected.items.length} resultado(s)`);
  // I0 — estagia os envelopes de coleta desta invocação. O fim de UM grupo é o
  // momento em que TODOS os tasks dele assentam; se algum ainda pendia quando o
  // `collectWithinWindow` devolveu (orçamento, stopEarly, graça), o retorno do
  // window é o fim (o cliente já recebeu a resposta). Envelope ≥ 0, acumulado
  // para as invocações sequenciais se somarem. Só quando há prazo de resposta.
  if (deadlineAt != null) {
    const windowEnd = Date.now();
    for (const [g, stage] of [[grpBr, 'br'], [grpGlobal, 'global']] as const) {
      if (!g.present) continue;
      const end = g.pending > 0 ? windowEnd : g.maxSettle;
      stageFirstTiming(firstObserver, stage, Math.max(0, end - collectStart));
    }
  }
  const bucket = collected.items;
  const done = collected.done;
  let completion = collected.completion;

  if (!done) {
    if (collected.prioritySeen && priorityGrace) {
      log.info(`[search] primeira fonte BR incluída na janela extra de até ${priorityGrace}ms`);
    }
    log.warn(`[search] orçamento de ${budget}ms esgotado; seguindo com ${bucket.length} resultado(s) parcial(is)`);
    // Os providers continuam trabalhando depois que a resposta sai. Quem paga
    // esse atraso são justamente as fontes BR (raspam WordPress e ainda seguem
    // protetor de link): descartar o que elas trouxeram atrasadas obrigava o
    // usuário a fechar e reabrir a lista pra vê-las. Aqui o resultado completo
    // reescreve o cache, então a próxima chamada do Stremio já vem cheia.
    const soFar = bucket.length;
    if (onLate) {
      watchLate = true;
      completion = collected.completion
        .then(() => lateQueue)
        .then(() => {
          const grew = bucket.length > soFar;
          if (grew) {
            log.info(`[search] fontes lentas chegaram: ${soFar} → ${bucket.length} resultado(s); recacheando`);
          }
          // Mesmo sem nada novo o passe tardio precisa avisar: a lista servida
          // saiu marcada como parcial (cacheMaxAge 0) e, sem esta chamada, ela
          // ficava parcial até o TTL expirar — o cliente repergunta em loop e
          // nunca recebe uma resposta que possa guardar.
          return onLate(bucket, grew, false, live);
        })
        .catch((err) => log.warn('[search] passe tardio falhou:', err?.message || err));
    }
  }
  // `partial` acompanha o lote até a resposta HTTP: quem recebe uma lista
  // incompleta não pode cacheá-la por 15 minutos (ver o handler em addon.js).
  return { items: bucket, partial: !done, completion, sweepInline, live };
}
