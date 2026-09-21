import config from '../config.js';
import type { Stream } from '../../types/domain.js';
import {
  markDebridName,
  filterKnownCache,
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
} from '../utils/format.js';
import * as cache from '../utils/cache.js';
import debrid from '../debrid/index.js';
import { accountScope } from '../utils/request-key.js';
import { signResolve } from '../utils/sign.js';
import { prefix, opts } from '../runtime.js';
import { remainingCheckBudget } from '../utils/deadline.js';
import * as autofetch from './autofetch.js';
import * as rdLedger from '../debrid/rd-ledger.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { autoFetchCandidates, releaseAllHolds, autoFetchBrDubbed } from './autofetch-runner.js';
import rdWarmer from './rd-warmer.js';
import { queueDubAudit, collectAuditCandidates } from './dub-audit.js';
import { countFirstBr, pruneKnownBroken, probeRdOracle, enrichInstantWithoutCacheCheck } from './debrid-pipeline-steps.js';
import type { FirstObserverState } from './stream-builder.js';
import { dropTrace, type StreamTraceState } from '../utils/stream-trace.js';
import { annotateEpisodeSizes, packHashesMissingFiles } from './episode-size.js';
import { playDisposition } from './debrid-play-guard.js';

/**
 * Marca quais streams já estão cacheados no debrid e troca o infoHash por um
 * link de play que passa pela nossa rota /resolve.
 */
type WorkHintInput = { n: string[]; y: number | null } | null;
type CacheResultSignal = {
  known: boolean;
  needsFullRefresh: boolean;
  autofetchCount?: number;
  trustDropped?: number;
};
// Exportado só como tipo (consumido pelo dub-audit via `import type`, que não
// cria aresta de runtime); o barrel NÃO o reexporta — a superfície pública
// continua sendo exatamente a do monolito.
export interface ApplyDebridOptions {
  season?: number | null;
  episode?: number | null;
  imdbId?: string | null;
  searchKey?: string | null;
  deadlineAt?: number | null;
  /** Contagem de episódios por temporada (Cinemeta), para a média do pack. */
  meta?: { episodes?: Record<string, number> } | null;
  /**
   * Só a passada REIVINDICADA como primeira resposta observa as métricas
   * `search.first.*`. Refresh de SWR/background e recaches tardios vêm sem este
   * flag, então não podem inflar a métrica.
   */
  observeFirstPass?: boolean;
  /** Estado marginal do observador de primeira resposta (finalização no
   * `onSelected` do buildStreams mantém brFound/brCached/brHidden/brVisible
   * coerentes num único bloco). */
  firstObserver?: FirstObserverState | null;
  onCacheResult?: (result: CacheResultSignal) => void;
  workHint?: WorkHintInput;
  /** P5 — ledger observacional (criado pelo buildStreams/finish); os cortes do
   * debrid (pré-checagem e cachedOnly) entram nele. null => sem efeito. */
  trace?: StreamTraceState | null;
}

export async function applyDebrid(input: Array<Stream | null>, {
  season, episode, imdbId, searchKey, deadlineAt, meta, observeFirstPass = false, firstObserver, onCacheResult, workHint, trace,
}: ApplyDebridOptions = {}) {
  let streams: Stream[] = input.filter((stream): stream is Stream => stream !== null);
  // Mentira de áudio (DubLieError / auditoria) já marcada no stream: corta ANTES
  // do early-return sem adapter. Sem isso, P2P puro entregava o mentiroso; com
  // adapter o pruneKnownBroken também corta via isLie, mas o campo _lied sairia
  // daqui SEM dropTrace — o P5 perderia o motivo 'lie'. Contador próprio
  // (search.lie.pre-debrid) para não dobrar magnetdb.dropped.lie.
  const preLieStreams = streams.filter((s) => s._lied === true);
  if (preLieStreams.length > 0) {
    for (const s of preLieStreams) dropTrace(trace, s, 'lie');
    streams = streams.filter((s) => s._lied !== true);
    metrics.count('search.lie.pre-debrid', preLieStreams.length);
  }
  if (streams.length === 0) return streams;
  const adapter = debrid.current();
  // Sem debrid nenhum, pack multiobra não tem play possível (o torrent P2P
  // inteiro baixaria a coleção): a lista sai sem ele.
  if (!adapter) return streams.filter((s) => !s._multiWorkAdmitted);

  const {
    debridCachedOnly: cachedOnly,
    showUncachedBr,
    brReservedSlots,
  } = opts();

  const trustApiKey = opts().debridApiKey;
  const trustScope = accountScope(trustApiKey);
  // O filtro pré-checagem (banco de magnets + blacklist do autofetch) mora no
  // steps: aqui fica só a consequência — a lista viva e o total descartado.
  const pruned = pruneKnownBroken(streams, adapter.id, { apiKey: trustApiKey, trustScope, season, episode, imdbId, trace });
  streams = pruned.streams;
  if (streams.length === 0) {
    // O filtro pré-checagem esvaziou a lista: sem reportar, o aviso sairia como
    // "fora do cache", culpando a checagem pelo que foi histórico ruim.
    if (onCacheResult) onCacheResult({ known: true, needsFullRefresh: false, autofetchCount: 0, trustDropped: pruned.trustDropped });
    return streams;
  }

  // Recusa legal do Real-Debrid (ledger `blocked`) é DEFINITIVA: o serviço
  // jamais aceitará este hash, então ele não pode virar [RD⚡] nem sair pelo
  // /resolve. O conjunto purga o hash do `cached` e pula o `viaDebrid` na saída
  // (construído UMA vez: o hash ressurgiria por memo davail/inventário/alive).
  const blockedHashes = new Set<string>();
  if (adapter.id === 'realdebrid' && config.debrid.rdLedger.enabled) {
    for (const s of streams) {
      const h = String(s.infoHash || '').toLowerCase();
      if (h && rdLedger.peek(h) === 'blocked') blockedHashes.add(h);
    }
  }
  const isBlocked = (s: Stream): boolean =>
    Boolean(s.infoHash && blockedHashes.has(String(s.infoHash).toLowerCase()));

  // Só quem ainda é torrent tem hash pra consultar; stream já resolvido não entra no lote.
  const hashes = streams.flatMap((s) => s.infoHash ? [s.infoHash] : []);
  if (hashes.length === 0) return streams;

  // A escolha dos candidatos vem antes da checagem (cada hold protege o hash da
  // limpeza); o disparo, depois — só aí sabemos se falta dublado em cache.
  // Pack multiobra admitido e fallback do banco (Etapa 4) nunca viram candidato.
  const candidates = autoFetchCandidates(streams.filter((s) => !s._multiWorkAdmitted && !s._fromFallback), {
    season, episode,
    imdbId: imdbId || undefined,
    searchKey: searchKey || undefined, trace,
  });
  const checkStarted = Date.now();
  // Teto dinâmico: o que resta do REPLY_DEADLINE menos margem para serialização.
  // null = sem teto (passe tardio usa o timeout completo do adaptador).
  // <=0 degrada na hora para known:false sem rede.
  const timeoutMs = remainingCheckBudget(
    deadlineAt,
    checkStarted,
    config.debrid.checkFormatMargin,
  );
  await probeRdOracle(hashes, { adapter, season, episode, imdbId, deadlineAt, apiKey: trustApiKey });
  // A etapa do oráculo também consome o deadline: recalcula o teto antes de
  // chamar o adapter, para não transformar o último milissegundo em atraso HTTP.
  const adapterTimeoutMs = remainingCheckBudget(deadlineAt, Date.now(), config.debrid.checkFormatMargin);
  // Packs sem lista de arquivos no memo: quem sabe listar lê na mesma checagem.
  const fileHashes = packHashesMissingFiles(streams, season);
  const { cached, known, unusable } = await debrid.checkCached(
    hashes,
    { ...(adapterTimeoutMs != null ? { timeoutMs: adapterTimeoutMs } : {}), ...(fileHashes.length ? { fileHashes } : {}) },
  );
  const checkMs = Date.now() - checkStarted;
  const needsFullRefresh = adapter.cacheCheck && !known && !unusable;
  // Chave recusada ou conta cheia: a lista inteira sairia como `[AD download]`
  // apontando para o /resolve, e TODO play morreria lá — os dois casos barram o
  // upload, que é como o serviço resolve. Como torrent puro ela ao menos toca.
  // O autofetch também não roda: enfileirar download numa conta que recusa
  // upload só gera erro em série.
  if (unusable) {
    // Conta cheia ou chave recusada: ninguém será baixado — enfileirar download
    // numa conta que recusa upload só gera erro em série. Libera todos os holds
    // para que os hashes voltem à limpeza normal.
    releaseAllHolds(candidates);
    if (onCacheResult) onCacheResult({ known, needsFullRefresh: false, autofetchCount: 0 });
    log.warn(
      `[debrid] ${adapter.label} indisponível (${unusable.reason}); ` +
        `${streams.length} stream(s) devolvido(s) como P2P (sem ⚡)`,
    );
    return streams.filter((s) => !s._multiWorkAdmitted);
  }

  // fsz aquecido na PRÓPRIA checagem (a AllDebrid lê os arquivos do pack na
  // mesma passada, dentro do orçamento): reanota o tamanho do episódio/filme
  // em quem ainda tem infoHash. Quem já saiu anotado do buildStreams é
  // ignorado pelo guard do marcador no annotate; medida pura — `_size` não
  // muda, o filtro de tamanho continua valendo para o download inteiro.
  streams = annotateEpisodeSizes(streams, { season, episode, meta, work: workHint, trace });
  // Hit-rate do autofetch: hash cacheado que carrega marker ativo é download
  // que o chupim enfileirou e agora toca na hora — a métrica mede o retorno do
  // mecanismo. Contagem pura, fora do caminho da resposta: erro vira no-op.
  if (known && cached.size > 0) {
    try {
      let hits = 0;
      for (const hash of cached) {
        if (cache.get(autofetch.markerKey(adapter.id, trustScope, hash))) hits += 1;
      }
      if (hits > 0) metrics.count('autofetch.hit', hits);
    } catch { /* diagnóstico nunca derruba a resposta */ }
  }

  // Inventário da conta + histórico de play complementam o `cached` com ⚡
  // gratuito — mas SÓ em adaptador sem cacheCheck. O dono do conjunto continua
  // sendo esta função; o steps só acrescenta os hits. Sem `accountKnown` (ou
  // sem ledger) o corte do cachedOnly abaixo não roda.
  const { cachedForAutofetch, knownForAutofetch, accountKnown } =
    enrichInstantWithoutCacheCheck(adapter, streams, cached, known, trustApiKey);

  // O `blocked` não pode sobreviver em `cached` por NENHUM vetor de
  // ressurreição (memo davail, inventário, histórico alive): um ⚡ aqui é um
  // play garantido em 451. Purga DEPOIS que todos os re-adds rodaram, num
  // único ponto de estrangulamento.
  if (blockedHashes.size) {
    let removedBlocked = 0;
    for (const h of blockedHashes) {
      if (cached.delete(h)) removedBlocked += 1;
    }
    if (removedBlocked) {
      metrics.count('debrid.blocked.dropped');
      log.info(`[debrid] ${removedBlocked} hash(es) com recusa legal do RD fora do cache (sem ⚡)`);
    }
  }

  const autofetchCount = autoFetchBrDubbed(streams, candidates, {
    cached: cachedForAutofetch,
    known: knownForAutofetch,
    season,
    episode,
    imdbId,
    searchKey, trace,
  });
  // Warmer RD em fundo (F3): enfileira os top-N desconhecidos sem rede nem atraso na resposta.
  if (config.debrid.rdWarm.enabled && (adapter.id === 'realdebrid' || config.debrid.service === 'realdebrid')) {
    // A config selada na URL nunca chega ao .env; sem registrar a chave vista
    // aqui, o warmer ficaria inerte nesta instalacao.
    if (adapter.id === 'realdebrid' && trustApiKey) rdWarmer.noteCredential(trustApiKey);
    const cachedSet = new Set([...cached].map((h) => String(h).toLowerCase()));
    const topN = 10;
    const warmable = streams.filter((s) => !s._multiWorkAdmitted && !s._fromFallback);
    const brCands = pickBrDubbedCandidates(warmable, cachedSet, topN)
      .map((s) => String(s.infoHash || '').toLowerCase())
      .filter(Boolean);
    if (brCands.length) rdWarmer.enqueue(brCands, 100);

    const anyDubbedCands = pickAnyDubbedCandidates(warmable, cachedSet, topN)
      .map((s) => String(s.infoHash || '').toLowerCase())
      .filter(Boolean);
    if (anyDubbedCands.length) rdWarmer.enqueue(anyDubbedCands, 50);

    const topSeededCands = pickTopSeededCandidates(warmable, cachedSet, topN, { minSeeders: 1 })
      .map((s) => String(s.infoHash || '').toLowerCase())
      .filter(Boolean);
    if (topSeededCands.length) rdWarmer.enqueue(topSeededCands, 10);
  }
  if (onCacheResult) onCacheResult({
    known,
    needsFullRefresh,
    ...(autofetchCount ? { autofetchCount } : {}),
  });
  const ep = season != null && episode != null ? `?s=${season}&e=${episode}` : '';
  const viaDebrid = (s: Stream, instant: boolean): Stream => {
    if (!s.infoHash) return s;
    // Pack multi-obra: o /resolve NÃO pode cair no maior arquivo (comportamento
    // pré-existente). `d` prova a promessa feita NA listagem e `i` permite que o
    // play grave a evidência no índice da obra — o `i` entra SEMPRE que a obra é
    // conhecida, não só em filme ou dublado (um pack BR sem dica provava o
    // episódio errado no play e jogava a prova fora por falta de obra). Campos
    // opcionais ficam dentro do hint já assinado; URLs antigas sem eles
    // continuam verificando normalmente.
    const hint = workHint || s._dubbed || imdbId
      ? {
        ...(workHint || {}),
        ...(workHint && s._multiWork ? { p: 1 } : {}),
        ...(s._dubbed ? { d: 1 } : {}),
        ...(imdbId ? { i: imdbId } : {}),
      }
      : null;
    const hintJson = hint ? JSON.stringify(hint) : '';
    // Assinatura cobre hash + temporada/episódio + dica (não o host): sem ela
    // o /resolve rejeita. O host sai só na resposta (`applyNoticeOrigin`) —
    // bake absoluto no cache envenenava play entre LAN/localhost/domínio.
    const sig = signResolve(s.infoHash, ep, hintJson);
    return {
      ...s,
      // Formato do Torrentio: [AD⚡] toca na hora, [AD download] ainda baixa.
      name: markDebridName(s.name, adapter.short || adapter.id, instant),
      url:
        `${prefix()}/resolve/${s.infoHash}${ep}${ep ? '&' : '?'}` +
        `${hintJson ? `w=${encodeURIComponent(hintJson)}&` : ''}sig=${sig}`,
      infoHash: undefined,
      sources: undefined,
    };
  };

  // `blocked` (recusa legal RD) nunca sai pelo /resolve nem leva ⚡: volta como
  // torrent P2P puro. Sem este desvio, o hash bloqueado voltaria como
  // [RD⚡]/[RD download] e o play morreria em 451 outra vez — a invalidação do
  // cache feita no /resolve não surtiria efeito.
  // Multiobra admitida: nunca P2P; a coleção fria só resolve com `resolveUncached`.
  const materialize = (s: Stream, instant: boolean): Stream | null => {
    if (isBlocked(s)) return s._multiWorkAdmitted ? null : s;
    const d = playDisposition(s, { cached: instant, resolveUncached: config.debrid.resolveUncached, degraded: true });
    return d === 'resolve' ? viaDebrid(s, instant) : d === 'p2p' ? s : null;
  };

  // Serviço sem `cacheCheck` (ou resposta incompleta): tudo pelo debrid — a
  // resolução no play dirá se toca. O ⚡ vai só em quem foi confirmado; numa
  // resposta parcial os demais são "não perguntei", não "não tem".
  if (!known) {
    // Antes só virava log: o contador é o que deixa a degradação visível no
    // /metrics.json sem precisar reler saída do container.
    metrics.count('debrid.check.unknown');
    const tetoInfo = timeoutMs != null ? `, teto ${timeoutMs}ms` : '';
    log.info(
      `[debrid] ${adapter.label} sem resposta completa de cache em ${checkMs}ms${tetoInfo}; ${streams.length} stream(s) via debrid` +
        (cached.size ? ` (${cached.size} confirmado(s) em cache)` : ''),
    );
    // Fase D também na degradação: o confirmado em cache aqui é candidato tão
    // bom quanto no caminho completo — este return passa por cima da coleta lá
    // de baixo, e era aqui que a fila ficava vazia nas respostas parciais.
    queueDubAudit(adapter.id, trustApiKey, collectAuditCandidates(streams, cached, { season, episode, imdbId, workHint }), searchKey);
    // Com cachedOnly ligado, "sem raio nao aparece" tambem vale aqui: o
    // inventario da conta e conhecimento COMPLETO sobre o que toca na hora,
    // mesmo o servico nao respondendo pelo cache global dele. Sem
    // `accountKnown` o corte nao roda — apagar a lista por memo frio seria pior
    // do que mostrar de mais.
    //
    // No Real-Debrid com ledger habilitado, a regra ternária entra: os misses
    // confirmados pelo ledger são descartados pelo cachedOnly, enquanto os
    // desconhecidos continuam visíveis.
    let missHashes: Set<string> | undefined;
    if (adapter.id === 'realdebrid' && config.debrid.rdLedger.enabled) {
      missHashes = new Set<string>();
      for (const s of streams) {
        const h = String(s.infoHash || '').toLowerCase();
        if (!h) continue;
        const state = rdLedger.peek(h);
        if (state === 'miss' || state === 'blocked') {
          missHashes.add(h);
        }
      }
    }

    if (cachedOnly && (accountKnown || missHashes)) {
      const corte = filterKnownCache(streams, cached, {
        cachedOnly,
        showUncachedBr,
        brReservedSlots,
        known: Boolean(accountKnown && !missHashes),
        missHashes,
        trace,
      });
      countFirstBr(streams, cached, corte.streams, observeFirstPass, firstObserver, { cachedOnly, showUncachedBr });
      if (corte.visibleBr.size) {
        log.info(`[debrid] ${corte.visibleBr.size} fonte(s) BR fora do cache mantida(s) como P2P`);
      }
      log.info(
        `[debrid] cachedOnly: ${corte.streams.length}/${streams.length} stream(s) com play instantaneo na conta ${adapter.label}`,
      );
      return corte.streams
        .map((s) => materialize(s, Boolean(s.infoHash && cached.has(s.infoHash))))
        .filter((s): s is Stream => s != null);
    }
    // Sem corte (não-cachedOnly, ou cachedOnly sem conta/miss conhecidos): o BR
    // segue inteiro para a listagem. Estagia cached/hidden para a finalização
    // coerente; o brFound (funil) já foi registrado no buildStreams.
    countFirstBr(streams, cached, streams, observeFirstPass, firstObserver, { cachedOnly, showUncachedBr });
    return streams
      .map((s) => materialize(s, Boolean(s.infoHash && cached.has(s.infoHash))))
      .filter((s): s is Stream => s != null);
  }

  // O tempo entra no log porque ele é o que decide o teto: a checagem divide o
  // REPLY_DEADLINE com a coleta e disputa o event loop com os resolvedores BR,
  // que rodam neste mesmo processo.
  const tetoInfo = timeoutMs != null ? `, teto ${timeoutMs}ms` : '';
  log.info(`[debrid] ${cached.size}/${streams.length} em cache no ${adapter.label} (${checkMs}ms${tetoInfo})`);
  const filtered = filterKnownCache(streams, cached, {
    cachedOnly,
    showUncachedBr,
    brReservedSlots,
    trace,
  });
  countFirstBr(streams, cached, filtered.streams, observeFirstPass, firstObserver, { cachedOnly, showUncachedBr });
  const { visibleBr } = filtered;
  if (visibleBr.size) {
    log.info(`[debrid] ${visibleBr.size} fonte(s) BR fora do cache mantida(s) como P2P`);
  }
  // Fase D: candidatos ⚡ dublados desta busca entram na fila do tail. A ordem
  // de `filtered.streams` é a do sort — o topo é o que o usuário toca, então
  // é ele que a auditoria prova primeiro.
  queueDubAudit(adapter.id, trustApiKey, collectAuditCandidates(filtered.streams, cached, { season, episode, imdbId, workHint }), searchKey);
  const out: Stream[] = [];
  for (const s of filtered.streams) {
    // Recusa legal do debrid: multiobra sai da lista (sem play), o resto volta
    // como P2P puro — comportamento antigo.
    if (isBlocked(s)) {
      if (!s._multiWorkAdmitted) out.push(s);
      continue;
    }
    // Pack multiobra nunca vira torrent P2P inteiro: cached sai pelo /resolve;
    // fora do cache só sai com `resolveUncached`, senão nem é oferecido.
    const instant = Boolean(s.infoHash && cached.has(s.infoHash));
    const disposition = playDisposition(s, { cached: instant, resolveUncached: config.debrid.resolveUncached });
    if (disposition === 'resolve') out.push(viaDebrid(s, instant));
    else if (disposition === 'p2p') out.push(s);
  }
  return out;
}
