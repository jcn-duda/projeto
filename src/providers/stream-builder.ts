import config from '../config.js';
import type { RawItem, Stream } from '../../types/domain.js';
import { limitReservingBr } from '../utils/format.js';
import { prefix, origin } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { applyDebrid } from './debrid-pipeline.js';
import { stageTrace, dropTrace, finalizeTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';
import {
  SAFE_INDEXER_ID,
  applyFileEvidence,
  prepareCandidateStreams,
} from './stream-builder-pipeline.js';
import type {
  PrepareCandidatesOptions,
  CandidatePoolResult,
} from './stream-builder-pipeline.js';
import {
  createFirstObserver,
  stageFirstTiming,
  firstObserverStep,
  firstObserverClaim,
  promoteFirstObserverEligible,
} from './stream-builder-first-observer.js';
import type { FirstObserverState } from './stream-builder-first-observer.js';

// Reexportações públicas com total compatibilidade
export {
  SAFE_INDEXER_ID,
  applyFileEvidence,
  prepareCandidateStreams,
};
export type {
  PrepareCandidatesOptions,
  CandidatePoolResult,
};
export {
  createFirstObserver,
  stageFirstTiming,
  firstObserverStep,
  firstObserverClaim,
  promoteFirstObserverEligible,
};
export type { FirstObserverState };

/**
 * Bruto dos providers → streams do Stremio: corte por título, por episódio,
 * ordenação, debrid e limite final.
 * @returns {Promise<import('../../types/domain').Stream[]>}
 */
export interface BuildStreamsOptions {
  meta?: { name?: string | null; title?: string; year?: number | string | null } | null;
  titles?: { original?: string | null; pt?: string | null; year?: number | string | null } | null;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  isDemo?: boolean;
  searchKey?: string | null;
  deadlineAt?: number | null;
  onDebridResult?: (result: { autofetchCount?: number; trustDropped?: number }) => void;
  /**
   * I0 — observabilidade da PRIMEIRA resposta. Vem `true` SÓ na passada
   * reclamada atomicamente pelo `finish` de uma busca síncrona real com prazo
   * de resposta; SWR/background e recaches tardios vêm com `observeFirstPass`
   * false e não podem reclamar nem contar a primeira resposta.
   */
  observeFirstPass?: boolean;
  /**
   * Marca a passada como recache tardio observável (JÁ com a primeira resposta
   * contada): conta `search.first.brLate` pelo delta acima do máximo visto.
   */
  observeLatePass?: boolean;
  /** Estado marginal do observador de primeira resposta, persistido entre os
   * passes do `finish` de UMA execução de `doSearch`. */
  firstObserver?: FirstObserverState;
  /**
   * P5 — ledger observacional do pipeline (stream-trace). Criado pelo `finish`
   * (uma build = um ledger), consumido aqui como leitura/escrita observacional
   * e gravado no cache já serializado. `undefined`/`null` => nenhum efeito.
   */
  trace?: StreamTraceState | null;
}

export async function buildStreams(rawInput: RawItem[], {
  meta, titles, imdbId, season, episode, isDemo, searchKey, deadlineAt, onDebridResult, observeFirstPass, observeLatePass, firstObserver, trace,
}: BuildStreamsOptions = {}) {
  const pool = prepareCandidateStreams(rawInput, {
    meta,
    titles,
    imdbId,
    season,
    episode,
    isDemo,
    trace,
  });

  let autofetchCount = 0;
  let streams = pool.streams;

  // Contagem ANTES do debrid: `applyDebrid` já devolve a lista pós-cachedOnly,
  // então usar o retorno dele para decidir o aviso era medir depois do corte —
  // no caso que motivou o aviso (nada em cache) ele volta VAZIO e a condição
  // nunca ligava.
  const candidatesBeforeDebrid = streams.length;
  // Contagem local: o notice de BR oculto pelo cachedOnly não pode depender
  // só do firstObserver (teste sem observador / passe sem claim). O estado
  // do observador continua sendo a fonte das métricas first.
  const brEnteredDebrid = streams.filter((s) => (s as any)._br).length;
  // Dubladas que ENTRARAM no corte. O aviso PROMETE dublada, então contar só
  // `_br` errava dos dois lados: BR legendado sobrevivente calava o aviso, e
  // BR legendado oculto o disparava mentindo. Medido em produção (tt6751668):
  // 5 dubladas no índice, nenhuma em cache, 2 legendadas servidas — o autofetch
  // já baixava a dublada e o usuário não via sinal nenhum disso.
  const dubEnteredDebrid = streams.filter((s) => (s as any)._br && (s as any)._dubbed).length;
  // I0 — funil da primeira resposta, contado AQUI (no buildStreams, não no
  // debrid): é o BR que ENTRARIA no debrid, independente de haver adapter. Por
  // ser estagiado no estado e finalizado no `onSelected` junto de brVisible,
  // P2P/sem adapter fica coerente — ou todas as métricas first contam (build
  // concluída dentro do prazo) ou nenhuma.
  if (observeFirstPass && firstObserver && !firstObserver.firstCounted) {
    firstObserver.pendingBrFound = brEnteredDebrid;
  }
  // Cortados pelo filtro pré-checagem (histórico ruim), reportados pelo
  // applyDebrid só quando eles esvaziam a lista — é a única vez em que o texto
  // "fora do cache" mentiria sobre o motivo.
  let trustDropped = 0;
  const debridStart = deadlineAt != null ? Date.now() : null;
  const beforeCut = await applyDebrid(streams, {
    season,
    episode,
    imdbId,
    searchKey,
    deadlineAt,
    // Só a passada reclamada e ainda não contada observa o `search.first.*`.
    observeFirstPass: Boolean(observeFirstPass && firstObserver && !firstObserver.firstCounted),
    firstObserver,
    // P5 — os cortes do debrid (bad/dead/lie/idx-miss, cached-only, rd-miss)
    // também entram no ledger; o ledger mora aqui fora, o steps só lê/escreve.
    trace,
    onCacheResult: (result: { autofetchCount?: number; trustDropped?: number }) => {
      autofetchCount += result.autofetchCount || 0;
      trustDropped += result.trustDropped || 0;
      if (onDebridResult) onDebridResult(result);
    },
    workHint: pool.workHint,
  });
  // I0 — mede a checagem de debrid SOMENTE no passo de resposta (`deadlineAt`
  // presente). Passes tardios vêm com `deadlineAt` null; SWR pode carregar um
  // prazo próprio, mas usa observador inelegível e nunca chega ao commit first.
  if (debridStart != null) {
    stageFirstTiming(firstObserver, 'debrid', Date.now() - debridStart);
  }
  streams = limitReservingBr(beforeCut, {
    brReservedSlots: pool.brReservedSlots,
    brReservedPerQuality: config.brReservedPerQuality,
    maxResults: pool.maxResults,
    brOnly: pool.brOnly,
    qualityLimits: pool.qualityLimits,
    brFirst: pool.brFirst,
    maxPerIndexer: pool.maxPerIndexer,
    indexerLimits: pool.safeIndexerLimits,
    season,
    // P5 — cotas finais (quality-quota/indexer-limit/max-results e as vagas
    // BR trocadas) observadas pelo mesmo ledger.
    trace,
    // I0 — finaliza as métricas first aqui, num ÚNICO bloco coerente: o
    // `onSelected` roda depois do debrid e do limite, então `Date.now() <=
    // deadlineAt` aqui é a prova de que a build da primeira resposta CONCLUIU
    // dentro do prazo. Estourou, o cliente já recebeu o corte do
    // `raceWithDeadline` e `search.deadline` mede esse caso — nada é contado
    // (firstCounted segue false e nenhum recache tardio pode virar late).
    onSelected: (selected) => {
      const state = firstObserver;
      if (!state) return;
      const brVisible = selected.filter((s) => (s as any)._br).length;
      const step = firstObserverStep(state, { observeFirstPass: Boolean(observeFirstPass), observeLatePass: Boolean(observeLatePass), brVisible });
      if (step.kind === 'none') return;
      if (step.kind === 'first') {
        if (deadlineAt == null || Date.now() > deadlineAt) return;
        state.firstCounted = true;
        state.maxBrVisible = Math.max(state.maxBrVisible || 0, brVisible);
        metrics.count('search.first.responses');
        // I0 — cinco timers da primeira resposta fria, comitados aqui, no mesmo
        // denominador de `search.first.responses` (só a passada first contada).
        // Buscas cortadas pelo deadline ficam deliberadamente fora destes
        // histogramas: `search.deadline` conta o corte e `search.response`/
        // `search.metadata` retêm a cauda da execução que terminou em fundo.
        // `collect.global` e `collect.br` se sobrepõem (BR divide o relógio com
        // os globais na mesma coleta) e não devem ser somados entre si; cada um
        // é um envelope da SUA faixa. Sem estagio (null) o timer simplesmente
        // não aparece — recaches tardios/SWR/deadline expirado nunca emitem.
        if (state.pendingMetadata != null) metrics.observe('search.first.metadata', state.pendingMetadata);
        if (state.pendingGlobal != null) metrics.observe('search.first.collect.global', state.pendingGlobal);
        if (state.pendingBr != null) metrics.observe('search.first.collect.br', state.pendingBr);
        if (state.pendingDebrid != null) metrics.observe('search.first.debrid', state.pendingDebrid);
        metrics.observe('search.first.total', Math.max(0, Date.now() - state.timingStartedAt));
        if ((state.pendingBrFound || 0) > 0) metrics.count('search.first.brFound', state.pendingBrFound);
        if ((state.pendingBrCached || 0) > 0) metrics.count('search.first.brCached', state.pendingBrCached);
        if ((state.pendingBrHidden || 0) > 0) metrics.count('search.first.brHidden', state.pendingBrHidden);
        if (brVisible > 0) metrics.count('search.first.brVisible', brVisible);
      } else if (step.kind === 'late') {
        if (step.delta > 0) {
          state.maxBrVisible = Math.max(state.maxBrVisible || 0, brVisible);
          metrics.count('search.first.brLate', step.delta);
        }
      }
    },
  });

  // "A dublada não ficou em cima" é a queixa mais comum e tem três causas
  // distintas (não veio da fonte / veio mas foi cortada / veio e ficou abaixo).
  // Sem este log as três são indistinguíveis a partir da lista final, porque o
  // corte apaga os campos internos que responderiam a pergunta. Conta ANTES do
  // notice: o brHidden alimenta o texto do aviso e o sufixo do log.
  const brIn = beforeCut.filter((s) => s._br);
  const dubIn = brIn.filter((s) => s._dubbed);
  // pendingBrHidden já é o delta pós-trust (countFirstBr depois do prune):
  // bad/dead/lie não entram. Math.max com (brEnteredDebrid − brIn) misturava
  // trust drop com cachedOnly e o notice "reabra" mentia — reabrir não tira
  // hash da blacklist. Com observador (produção), só a medida precisa; sem
  // ele (teste avulso), cai no delta bruto.
  const brHidden = firstObserver
    ? firstObserver.pendingBrHidden || 0
    : Math.max(0, brEnteredDebrid - brIn.length);
  const head = streams.slice(0, 3).map((s) => (s.name || '').split('\n')[1] || '?').join(' / ');
  log.info(
    `[search] entrada do corte: ${beforeCut.length} stream(s), ${brIn.length} BR (${dubIn.length} dublada(s))` +
      ` | brFirst=${pool.brFirst} preferDubbed=${pool.preferDubbed} | topo: ${head}` +
      (brHidden > 0 ? ` | brHidden=${brHidden} ocultos pelo cachedOnly` : ''),
  );

  // Tres estados, nesta ordem de precisao: ja mandamos baixar / achamos mas o
  // cachedOnly cortou / nao achamos nada ainda. O terceiro so vale para SERIE,
  // que e onde a busca tardia de pack roda de verdade — prometer "reabra em
  // instantes" num filme sem resultado seria mentira.
  //
  // Quarto caso: a DUBLADA existiu e o cachedOnly escondeu TODAS — lista vazia,
  // só Dual/gringo, ou só BR legendado. Sem notice o sintoma parece "não tem
  // dublado", inclusive quando o autofetch já está baixando. O texto NÃO
  // empurra ligar `bu` (mostrar frio é opt-in): aponta reabertura / autofetch.
  // Só o TEXTO nasce aqui; o link sai no `applyNoticeOrigin`.
  // `brHidden` é BR de QUALQUER áudio e vem post-trust (preciso); o delta de
  // dubladas é bruto. O `min` casa os dois: limita o bruto pelo teto preciso,
  // então se nada sumiu no cachedOnly (só trust/blacklist) o aviso não nasce —
  // reabrir não tira hash da blacklist, e a promessa continua honesta.
  const dubHidden = Math.min(brHidden, Math.max(0, dubEnteredDebrid - dubIn.length));
  const dubHiddenByCachedOnly = dubHidden > 0 && dubIn.length === 0;
  const noticeText = () => {
    if (autofetchCount > 0) return '⏳ Baixando no debrid — reabra em alguns minutos';
    if (dubHiddenByCachedOnly) {
      return 'Fontes BR dubladas existem, mas ainda fora do cache — reabra em alguns minutos';
    }
    if (candidatesBeforeDebrid > 0 && trustDropped >= candidatesBeforeDebrid) {
      return `Nenhuma fonte pronta — ${trustDropped} resultado(s) descartado(s) por histórico ruim nesta conta do debrid`;
    }
    if (candidatesBeforeDebrid > 0) {
      return `Nenhuma fonte pronta — ${candidatesBeforeDebrid} resultado(s) fora do cache`;
    }
    if (season != null) return 'Nada pronto ainda — procurando a temporada; reabra em instantes';
    return null;
  };
  if (config.search.noticeStream) {
    const name = noticeText();
    if (name && (streams.length === 0 || dubHiddenByCachedOnly)) {
      // Lista vazia: o aviso É a lista. Lista com Dual/gringo e BR sumido no
      // cachedOnly: ANEXA o aviso — substituir apagaria o que ainda toca.
      streams = streams.length === 0
        ? [{ name, notice: true }]
        : [...streams, { name, notice: true }];
      dropTrace(trace, { name }, 'notice');
      stageTrace(trace, 'notice', streams.filter((s) => s?.notice).length);
    }
  }

  // P5 — fecha o ledger com o tamanho ENTREGUE (o aviso entra na contagem) e
  // o instante de término. Depois daqui o `finish` serializa e grava no cache.
  finalizeTrace(trace, streams.length);
  return streams;
}

// `buildStreams` sai exportado pelo mesmo motivo do `applyDebrid`: e o unico
// jeito de testar o item de aviso sem subir uma busca inteira com Jackett.
/**
 * Fecha o aviso de lista vazia na RESPOSTA, com o origin de quem está
 * perguntando agora. O texto é conteúdo da busca e fica no cache; o link não
 * pode: `streamsCacheKey` não carrega o origin, então montá-lo dentro do
 * `buildStreams` gravava na entrada compartilhada o endereço do primeiro
 * cliente — a TV que chama 192.168.0.23 deixava esse link para o celular que
 * chama pelo domínio, e um `Host` forjado envenenava a entrada para o próximo.
 *
 * PUBLIC_URL (endereço público) tem precedência; sem ela vale o origin da
 * requisição, que por definição é um endereço que aquele cliente alcança.
 *
 * Sem origin nenhum (chamada interna, teste sem req) o item é DESCARTADO: sem
 * `url`/`infoHash`/`externalUrl` nenhum cliente Stremio renderiza a linha, então
 * ela só ocuparia a resposta e sumiria na tela — foi o que deixou o app com
 * "Nenhum stream disponível" enquanto a busca já tinha resultado.
 */
export function applyNoticeOrigin(streams: Stream[] = []) {
  if (!streams.some((stream) => stream?.notice)) return streams;
  const base = (config.debrid.publicUrl || origin() || '').replace(/\/$/, '');
  const link = base ? `${base}${prefix()}/configure` : '';
  return streams.flatMap((stream) => {
    if (!stream?.notice) return [stream];
    if (!link) return [];
    // `notice` é marca interna: não faz parte do objeto que o Stremio recebe.
    const { notice, ...rest } = stream;
    return [{ ...rest, externalUrl: link }];
  });
}

/** A lista não tem resultado nenhum — só o aviso. */
export function onlyNotice(streams: Stream[] = []) {
  return streams.length > 0 && streams.every((stream) => stream?.notice);
}
