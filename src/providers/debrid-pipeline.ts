import config from '../config.js';
import type { DebridAdapter, Stream, WorkHint } from '../../types/domain.js';
import {
  markDebridName,
  filterKnownCache,
  parseTitleSeasonEpisode,
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
import * as magnetdb from '../utils/magnetdb.js';
import * as rdLedger from '../debrid/rd-ledger.js';
import * as rdOracle from '../debrid/rd-oracle.js';
import { isDubLieError, isEpisodePickError } from '../debrid/common.js';
import * as releaseIndex from '../utils/release-index.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { autoFetchCandidates, releaseAllHolds, autoFetchBrDubbed } from './autofetch-runner.js';
import rdWarmer from './rd-warmer.js';

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
interface ApplyDebridOptions {
  season?: number | null;
  episode?: number | null;
  imdbId?: string | null;
  searchKey?: string | null;
  deadlineAt?: number | null;
  onCacheResult?: (result: CacheResultSignal) => void;
  workHint?: WorkHintInput;
}

export async function applyDebrid(input: Array<Stream | null>, {
  season, episode, imdbId, searchKey, deadlineAt, onCacheResult, workHint,
}: ApplyDebridOptions = {}) {
  let streams: Stream[] = input.filter((stream): stream is Stream => stream !== null);
  const adapter = debrid.current();
  if (!adapter || streams.length === 0) return streams;

  const {
    debridCachedOnly: cachedOnly,
    showUncachedBr,
    brReservedSlots,
  } = opts();
  const { publicUrl } = config.debrid;

  // Banco de magnets + blacklist do autofetch: o que já PROVOU estar quebrado
  // sai ANTES da checagem — não se gasta lote (nem upload, na AllDebrid) com
  // fracasso conhecido. Só histórico desta conta: cache do debrid pertence a
  // ela, e um morto aqui pode estar vivo em outro serviço.
  const trustApiKey = opts().debridApiKey;
  const trustScope = accountScope(trustApiKey);
  // Contadores SEPARADOS por origem: bad é play sem vídeo (banco de magnets),
  // dead é estado terminal no recheck do autofetch. Somados escondem qual dos
  // dois corta — e é exatamente o que o diagnóstico precisa distinguir.
  let droppedBad = 0;
  let droppedDead = 0;
  let droppedLie = 0;
  let droppedMiss = 0;
  streams = streams.filter((s) => {
    if (!s.infoHash) return true;
    if (magnetdb.isBad(adapter.id, trustApiKey, s.infoHash)) {
      // Autocorreção tardia do dano F3: um ramo antigo marcava `bad` no hash
      // que o Real-Debrid recusou por lei (HTTP 451/error_code 35). Recusa
      // legal não é magnet quebrado, e NoVideoError legítimo não grava
      // `blocked`; logo `bad + blocked` neste adapter só pode ser aquela
      // escrita equivocada. Limpa e deixa o stream seguir: fora do cachedOnly
      // volta como P2P/sem ⚡; no cachedOnly o corte ternário o remove logo
      // abaixo pelo próprio ledger.
      if (config.debrid.rdLedger.enabled && adapter.id === 'realdebrid' && rdLedger.peek(s.infoHash) === 'blocked') {
        if (magnetdb.forgetBad(adapter.id, trustApiKey, s.infoHash)) {
          metrics.count('magnetdb.bad.clearedBlocked');
          log.info(`[debrid] bad RD de recusa legal recuperado (${String(s.infoHash).slice(0, 8)})`);
        }
        return true;
      }
      droppedBad += 1;
      return false;
    }
    if (s._lied || magnetdb.isLie(adapter.id, trustApiKey, s.infoHash)) {
      droppedLie += 1;
      return false;
    }
    // Prova fina do índice: este hash já provou NÃO servir ESTE episódio
    // (play ou tail). Só vale com s/e + obra na busca — filme e série sem
    // episódio não têm o que conferir.
    if (season != null && episode != null && imdbId && releaseIndex.isMissing(imdbId, { season, episode }, s.infoHash)) {
      droppedMiss += 1;
      return false;
    }
    if (autofetch.isDead(adapter.id, trustScope, s.infoHash)) {
      droppedDead += 1;
      return false;
    }
    return true;
  });
  if (droppedBad + droppedDead + droppedLie + droppedMiss > 0) {
    // O agregado magnetdb.dropped soma SÓ bad/dead/lie de propósito: miss é
    // marca do release-index (não do banco de magnets) e conta em separado,
    // como search.idx.miss.dropped — o diagnóstico não pode culpar o lado errado.
    metrics.count('magnetdb.dropped', droppedBad + droppedDead + droppedLie);
    if (droppedBad) metrics.count('magnetdb.dropped.bad', droppedBad);
    if (droppedDead) metrics.count('magnetdb.dropped.dead', droppedDead);
    if (droppedLie) metrics.count('magnetdb.dropped.lie', droppedLie);
    if (droppedMiss) metrics.count('search.idx.miss.dropped', droppedMiss);
    log.info(`[debrid] ${droppedBad + droppedDead + droppedLie + droppedMiss} magnet(s) com histórico ruim descartado(s) antes da checagem (${droppedBad} bad, ${droppedDead} dead, ${droppedLie} lie, ${droppedMiss} miss)`);
  }
  if (streams.length === 0) {
    // O filtro pré-checagem esvaziou a lista: sem reportar, o aviso sairia como
    // "fora do cache", culpando a checagem pelo que foi histórico ruim.
    if (onCacheResult) onCacheResult({ known: true, needsFullRefresh: false, autofetchCount: 0, trustDropped: droppedBad + droppedDead + droppedLie + droppedMiss });
    return streams;
  }

  // Só quem ainda é torrent tem hash pra consultar; stream já resolvido não entra no lote.
  const hashes = streams.flatMap((s) => s.infoHash ? [s.infoHash] : []);
  if (hashes.length === 0) return streams;

  // A escolha dos candidatos vem antes da checagem (cada hold protege o hash da
  // limpeza); o disparo, depois — só aí sabemos se falta dublado em cache.
  const candidates = autoFetchCandidates(streams, {
    season,
    imdbId: imdbId || undefined,
    searchKey: searchKey || undefined,
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
  // O RD não expõe mais instantAvailability. O oráculo consulta fontes que
  // conhecem o CDN e registra somente as respostas autoritativas no ledger;
  // hash ausente no Torrentio continua desconhecido, nunca vira miss.
  if (adapter.id === 'realdebrid' && adapter.cacheCheck && imdbId && hashes.length > 0) {
    const oracleBudget = remainingCheckBudget(deadlineAt, Date.now(), config.debrid.checkFormatMargin);
    if (oracleBudget == null || oracleBudget > 0) {
      const limit = Math.min(hashes.length, 500);
      const oracleHashes = [...new Set(hashes.map((hash) => String(hash).toLowerCase()))].slice(0, limit);
      const type = season != null || episode != null ? 'series' as const : 'movie' as const;
      const id = type === 'series' ? `${imdbId}:${season ?? 0}:${episode ?? 0}` : imdbId;
      const verdicts = await rdOracle.check({
        hashes: oracleHashes,
        type,
        id,
        timeoutMs: oracleBudget == null ? config.debrid.rdOracle.timeoutMs : Math.min(oracleBudget, config.debrid.rdOracle.timeoutMs),
      }, trustApiKey);
      const hits: string[] = [];
      for (const [hash, cachedByOracle] of verdicts) {
        if (cachedByOracle) hits.push(hash);
        else rdLedger.noteMiss(hash);
      }
      if (hits.length) rdLedger.noteHit(hits);
    }
  }
  // A etapa do oráculo também consome o deadline: recalcula o teto antes de
  // chamar o adapter, para não transformar o último milissegundo em atraso HTTP.
  const adapterTimeoutMs = remainingCheckBudget(deadlineAt, Date.now(), config.debrid.checkFormatMargin);
  const { cached, known, unusable } = await debrid.checkCached(
    hashes,
    adapterTimeoutMs != null ? { timeoutMs: adapterTimeoutMs } : {},
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
    return streams;
  }

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

  // Dedupe por inventário para adaptadores sem cacheCheck (Real-Debrid / Debrid-Link)
  let cachedForAutofetch = cached;
  let knownForAutofetch = known;
  // O inventario da conta respondeu? So com ele em maos o corte do cachedOnly
  // pode rodar num adaptador sem cacheCheck — com memo frio o conjunto vem
  // vazio e o corte apagaria a lista inteira.
  let accountKnown = false;
  if (!adapter.cacheCheck && adapter.autofetchSource) {
    const peek = debrid.inventoryPeek(adapter, opts().debridApiKey);
    if (peek) {
      cachedForAutofetch = new Set(peek.map((i) => String(i.infoHash || '').toLowerCase()));
      knownForAutofetch = true;
      // O que ja esta PRONTO na conta toca na hora — isso e ⚡ de verdade, e o
      // unico que sobrou desde que o Real-Debrid aposentou o
      // /torrents/instantAvailability. Sem isto o inventario so alimentava o
      // autofetch e a lista inteira saia [RD Download] mesmo com o arquivo
      // baixado. `known` fica como esta de proposito: a conta nao responde pelo
      // cache GLOBAL do servico, entao o corte do cachedOnly continua sem base
      // para descartar o resto.
      let fromInventory = 0;
      for (const hash of cachedForAutofetch) {
        if (cached.has(hash)) continue;
        cached.add(hash);
        fromInventory += 1;
      }
      if (fromInventory) metrics.count('debrid.instant.fromInventory', fromInventory);
      // Inventário pronto é uma observação gratuita do CDN do RD. O magnetdb
      // continua por conta; o ledger é global porque o cache é do serviço.
      if (adapter.id === 'realdebrid') rdLedger.noteHit([...cachedForAutofetch]);
      accountKnown = true;
    } else {
      knownForAutofetch = false;
      debrid.inventory().catch((err: unknown) =>
        log.warn(`[${adapter.id}] aquecimento de inventário em fundo falhou:`, log.errorMessage(err)),
      );
    }
  }

  // Historico duravel desta conta: hash que JA tocou pelo /resolve volta com ⚡.
  // O markAlive grava no play bem-sucedido (TTL de 7 dias) e o `bad`/`lie`, mais
  // recentes e mais especificos, vencem sobre ele no filtro la de cima — o que
  // provou quebrar ja saiu da lista antes de chegar aqui.
  //
  // So para adaptador SEM cacheCheck: onde a checagem de cache funciona de
  // verdade (AllDebrid) ela e a autoridade, e sobrepor com memoria antiga criaria
  // ⚡ falso justamente onde existe resposta melhor. Isto tambem NAO liga
  // `accountKnown`: e conhecimento pontual, nao um retrato completo da conta,
  // entao nao pode autorizar o corte do cachedOnly a descartar o resto.
  if (!adapter.cacheCheck && trustApiKey) {
    let doHistorico = 0;
    const aliveHashes: string[] = [];
    for (const s of streams) {
      const hash = String(s.infoHash || '').toLowerCase();
      if (!hash || cached.has(hash)) continue;
      if (magnetdb.isAlive(adapter.id, trustApiKey, hash)) {
        cached.add(hash);
        doHistorico += 1;
        aliveHashes.push(hash);
      }
    }
    if (adapter.id === 'realdebrid') rdLedger.noteHit(aliveHashes);
    if (doHistorico) {
      metrics.count('debrid.instant.fromHistory', doHistorico);
      log.info(`[debrid] ${doHistorico} stream(s) com ⚡ pelo histórico de play desta conta`);
    }
  }

  const autofetchCount = autoFetchBrDubbed(streams, candidates, {
    cached: cachedForAutofetch,
    known: knownForAutofetch,
    season,
    episode,
    imdbId,
    searchKey,
  });
  // Warmer RD em fundo (F3): enfileira os top-N desconhecidos sem rede nem atraso na resposta.
  if (config.debrid.rdWarm.enabled && (adapter.id === 'realdebrid' || config.debrid.service === 'realdebrid')) {
    // A config selada na URL nunca chega ao .env; sem registrar a chave vista
    // aqui, o warmer ficaria inerte nesta instalacao.
    if (adapter.id === 'realdebrid' && trustApiKey) rdWarmer.noteCredential(trustApiKey);
    const cachedSet = new Set([...cached].map((h) => String(h).toLowerCase()));
    const topN = 10;
    const brCands = pickBrDubbedCandidates(streams, cachedSet, topN)
      .map((s) => String(s.infoHash || '').toLowerCase())
      .filter(Boolean);
    if (brCands.length) rdWarmer.enqueue(brCands, 100);

    const anyDubbedCands = pickAnyDubbedCandidates(streams, cachedSet, topN)
      .map((s) => String(s.infoHash || '').toLowerCase())
      .filter(Boolean);
    if (anyDubbedCands.length) rdWarmer.enqueue(anyDubbedCands, 50);

    const topSeededCands = pickTopSeededCandidates(streams, cachedSet, topN, { minSeeders: 1 })
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
    // Pack multi-obra: o /resolve precisa saber que aqui NÃO vale cair no maior
    // arquivo. Vai dentro da dica, então está coberto pela assinatura.
    // `d` prova a promessa feita NA listagem e `i` permite que o play grave a
    // evidência no índice da obra. Campos opcionais ficam dentro do hint já
    // assinado; URLs antigas sem eles continuam verificando normalmente.
    // O `i` entra SEMPRE que a obra é conhecida, não só em filme ou dublado.
    // Medido: um pack BR não marcado como dublado chegava ao /resolve sem
    // dica, o play provava o episódio errado com evidência do arquivo e a
    // prova era jogada fora por não haver obra onde gravá-la — a fonte morta
    // só saía da lista quando o tail chegasse nela (2 por busca, e só em
    // cacheado). O clique do usuário é a evidência mais forte que existe;
    // desperdiçá-la mantinha na tela uma fonte que jamais tocaria.
    const hint = workHint || s._dubbed || imdbId
      ? {
        ...(workHint || {}),
        ...(workHint && s._multiWork ? { p: 1 } : {}),
        ...(s._dubbed ? { d: 1 } : {}),
        ...(imdbId ? { i: imdbId } : {}),
      }
      : null;
    const hintJson = hint ? JSON.stringify(hint) : '';
    // Assinatura cobre hash + temporada/episódio + dica: sem ela o /resolve
    // rejeita, então conhecer a PUBLIC_URL e um hash não basta pra gastar o
    // debrid — nem pra adulterar a escolha de arquivo.
    const sig = signResolve(s.infoHash, ep, hintJson);
    return {
      ...s,
      // Formato do Torrentio: [AD⚡] toca na hora, [AD download] ainda baixa.
      name: markDebridName(s.name, adapter.short || adapter.id, instant),
      url:
        `${publicUrl}${prefix()}/resolve/${s.infoHash}${ep}${ep ? '&' : '?'}` +
        `${hintJson ? `w=${encodeURIComponent(hintJson)}&` : ''}sig=${sig}`,
      infoHash: undefined,
      sources: undefined,
    };
  };

  // Serviço que não sabe informar cache (Real-Debrid, Debrid-Link) ou resposta
  // incompleta (lote perdido no timeout): filtrar por "somente em cache"
  // esconderia a lista inteira. Mandamos tudo pelo debrid — a resolução no play
  // dirá se toca ou não. O ⚡ vai só em quem foi confirmado: numa resposta
  // parcial os demais são "não perguntei", não "não tem", e viram "download".
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
      });
      if (corte.visibleBr.size) {
        log.info(`[debrid] ${corte.visibleBr.size} fonte(s) BR fora do cache mantida(s) como P2P`);
      }
      log.info(
        `[debrid] cachedOnly: ${corte.streams.length}/${streams.length} stream(s) com play instantaneo na conta ${adapter.label}`,
      );
      return corte.streams.map((s) => viaDebrid(s, Boolean(s.infoHash && cached.has(s.infoHash))));
    }
    return streams.map((s) => viaDebrid(s, Boolean(s.infoHash && cached.has(s.infoHash))));
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
  });
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
    if (s.infoHash && cached.has(s.infoHash)) {
      out.push(viaDebrid(s, true));
      continue;
    }
    // Fora do cache o padrão é devolver o torrent puro: não gasta a conta do
    // usuário sem ele pedir. Só que cliente que não toca infoHash descarta
    // esses streams, e num título sem nada em cache a lista inteira some da
    // tela. Com resolveUncached eles saem pelo /resolve, marcados
    // "[AD download]" — o play é quem adiciona o magnet.
    if (config.debrid.resolveUncached) {
      out.push(viaDebrid(s, false));
      continue;
    }
    out.push(s);
  }
  return out;
}

// Fase D da auditoria de áudio: candidatos ⚡ dublados confirmados em cache
// nesta busca. A prova (paths reais dos vídeos) só existe no debrid; esperar
// o play descobrir entrega inglês sob selo DUB BR uma vez por hash — o tail
// prova ANTES, grava a mesma evidência do play e a próxima lista já nasce
// honesta. Fila curta de propósito: sobra de busca sem tail não acumula.
type DubAuditCandidate = {
  hash: string;
  season: number | null;
  episode: number | null;
  imdbId: string | null;
  work?: WorkHint;
  dubbed: boolean;
  key?: string | null;
  extraKeys?: string[];
};
const dubAuditPending: DubAuditCandidate[] = [];

/** ⚡ em cache = o que o usuário vai tocar; é isso que o tail interrogará.
 * Dois grupos: (1) dublados — provam a promessa de áudio; (2) em série, os
 * que NÃO nomeiam o episódio pedido — pack de temporada pode conter outra
 * coisa (caso True Detective). Dedupe por hash preserva a variante dublada. */
export function collectAuditCandidates(
  list: Stream[],
  cached: Set<string>,
  { season, episode, imdbId, workHint }: Pick<ApplyDebridOptions, 'season' | 'episode' | 'imdbId' | 'workHint'>,
) {
  const work = (s: Stream): WorkHint | undefined => (workHint ? { names: workHint.n, year: workHint.y, pack: Boolean(s._multiWork) } : undefined);
  const byHash = new Map<string, DubAuditCandidate>();
  for (const s of list) {
    if (!s.infoHash || !s._dubbed || !cached.has(s.infoHash)) continue;
    byHash.set(String(s.infoHash), {
      hash: String(s.infoHash),
      season: season ?? null,
      episode: episode ?? null,
      imdbId: imdbId || null,
      work: work(s),
      dubbed: true,
    });
  }
  if (season != null && episode != null) {
    for (const s of list) {
      if (!s.infoHash || !cached.has(s.infoHash)) continue;
      const hash = String(s.infoHash);
      // A variante dublada já interrogará este hash — e o resultado dela vale
      // para os dois grupos (a prova é sobre o conteúdo, não sobre o selo).
      if (byHash.has(hash)) continue;
      if (nomeiaEpisodio(s.title || s.name || '', season, episode)) continue;
      byHash.set(hash, {
        hash,
        season,
        episode,
        imdbId: imdbId || null,
        work: work(s),
        dubbed: false,
      });
    }
  }
  return [...byHash.values()];
}

export function queueDubAudit(adapterId: string, apiKey: string, candidates: DubAuditCandidate[], searchKey: string | null = null) {
  if (!config.audioAudit.enabled || config.debrid.dubAuditTailMax <= 0) return;
  let added = false;
  for (const cand of candidates) {
    // Já condenado nesta conta não gasta consulta de novo.
    if (magnetdb.isLie(adapterId, apiKey, cand.hash)) continue;
    // Já está na fila para o MESMO episódio: busca repetida não pode duplicar
    // o interrogatório. Temporada/episódio entram na comparação porque o
    // MESMO pack serve episódios diferentes (navegação E01 → E02 enfileira de
    // novo, com a própria chave de lista). Se a candidatura repete com chave
    // de busca diferente, acumula a chave extra: a prova invalida TODAS as
    // listas afetadas, não só a primeira.
    const candHash = String(cand.hash || '').toLowerCase();
    const prev = dubAuditPending.find((p) => String(p.hash || '').toLowerCase() === candHash
      && p.season === cand.season && p.episode === cand.episode);
    if (prev) {
      if (cand.key && prev.key && cand.key !== prev.key) {
        prev.extraKeys = prev.extraKeys || [];
        if (!prev.extraKeys.includes(cand.key)) prev.extraKeys.push(cand.key);
      }
      continue;
    }
    // Já provou não servir ESTE episódio (play ou tail anterior).
    if (cand.imdbId && cand.season != null && cand.episode != null
      && releaseIndex.isMissing(cand.imdbId, { season: cand.season, episode: cand.episode }, cand.hash)) continue;
    dubAuditPending.push({ ...cand, key: searchKey });
    added = true;
  }
  if (dubAuditPending.length > 50) dubAuditPending.splice(0, dubAuditPending.length - 50);
  // A drenagem é agendada NO enfileiramento, de propósito: os candidatos BR
  // costumam chegar pelo passe tardio, DEPOIS do ponto da busca que responderia
  // — e a busca seguinte pode sair do cache sem rodar doSearch de novo. O
  // setImmediate criado AQUI herda o AsyncLocalStorage da requisição que
  // enfileirou (opts() continua vendo a conta certa), e cada drenagem leva
  // consigo a chave da lista para invalidar quem provou mentira.
  if (added) {
    const handle = setImmediate(async () => {
      try {
        const r = await runDubAudit();
        if (r.audited > 0) log.info(`[audit] tail: ${r.audited} candidato(s) provado(s), ${r.lies} mentira(s), ${r.wrongEpisodes} episódio(s) errado(s)`);
      } catch (err) {
        log.warn('[audit] drenagem falhou:', err?.message || err);
      }
    });
    handle.unref?.();
  }
}

/**
 * Prova os candidatos pendentes no debrid; mentira vira a MESMA evidência do
 * play (mag lie + idx.lied). Falha de rede/credencial não é evidência — o
 * candidato volta a entrar na próxima busca. O link resolvido é descartado:
 * aqui não é play, é interrogatório.
 */
export async function runDubAudit(limit = config.debrid.dubAuditTailMax) {
  const batch = dubAuditPending.splice(0, Math.max(0, Math.trunc(Number(limit) || 0)));
  let lies = 0;
  let wrongEpisodes = 0;
  const liedKeys = new Set<string>();
  for (const cand of batch) {
    try {
      await debrid.resolveLink(cand.hash, { season: cand.season, episode: cand.episode, work: cand.work, dubbed: Boolean(cand.dubbed) });
    } catch (err) {
      if (isDubLieError(err)) {
        lies += 1;
        const adapter = debrid.current() as DebridAdapter | null;
        if (adapter) magnetdb.markLie(adapter.id, opts().debridApiKey, cand.hash);
        if (cand.imdbId) releaseIndex.markLied(cand.imdbId, { season: cand.season, episode: cand.episode }, cand.hash);
        if (cand.key) liedKeys.add(cand.key);
        for (const extra of cand.extraKeys || []) if (extra) liedKeys.add(extra);
        metrics.count('debrid.audit.lie.tail');
        log.warn(`[audit] tail provou mentira ${String(cand.hash).slice(0, 8)}${err.evidence?.matchedGroup ? ` (${err.evidence.matchedGroup})` : ''}`);
      } else if (isEpisodePickError(err)) {
        // Ambiguidade (SEM evidência): o throw multi-vídeo diz "não
        // identifiquei", não "é outro episódio" — loga para observabilidade
        // e segue sem gravar nada nem invalidar lista.
        if (!err.evidence) {
          log.warn(
            `[audit] tail: episódio não identificado em ${String(cand.hash).slice(0, 8)} (ambiguidade, sem prova)` +
            `${err.context ? ` — ${err.context.videoCount} vídeo(s): ${err.context.samples.join(' | ')}` : ''}`,
          );
          continue;
        }
        // Prova MEDIDA (com evidência): o nome do arquivo declarou outro s/e.
        // NÃO é mentira de áudio nem magnet quebrado: markLie/markLied ficam
        // de fora — a evidência é fina, só o episódio pedido está errado.
        wrongEpisodes += 1;
        metrics.count('debrid.audit.episode');
        if (cand.imdbId && cand.season != null && cand.episode != null) {
          releaseIndex.markMissing(cand.imdbId, { season: cand.season, episode: cand.episode }, cand.hash);
        }
        if (cand.key) liedKeys.add(cand.key);
        for (const extra of cand.extraKeys || []) if (extra) liedKeys.add(extra);
        log.warn(`[audit] tail provou episódio errado ${String(cand.hash).slice(0, 8)} (declara S${err.evidence.declaredSeasons.join(',') || '?'}E${err.evidence.declaredEpisodes.join(',') || '?'})`);
      }
    }
  }
  // A lista corrente ainda carrega o candidato provado-ruim: invalida para a
  // próxima busca nascer limpa, sem esperar TTL nem play de ninguém.
  for (const key of liedKeys) cache.forget(key);
  return { audited: batch.length, lies, wrongEpisodes };
}

/** O título NOMEIA este episódio? Pack de temporada casa o episódio no
 * `matchesEpisode` de propósito (ele contém o episódio), mas não o NOMEIA —
 * e a diferença decide quem pode sustentar a cobertura do índice. */
export function nomeiaEpisodio(title: string, season: number, episode: number) {
  const { seasons, episodes } = parseTitleSeasonEpisode(String(title || ''));
  return episodes.includes(episode) && (seasons.length === 0 || seasons.includes(season));
}
