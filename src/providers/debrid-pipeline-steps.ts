import config from '../config.js';
import type { DebridAdapter, Stream } from '../../types/domain.js';
import debrid from '../debrid/index.js';
import { peekDavail } from '../debrid/cache-check.js';
import { reuploadBlocked } from '../debrid/alldebrid-reupload.js';
import { accountScope } from '../utils/request-key.js';
import * as magnetdb from '../utils/magnetdb.js';
import * as rdLedger from '../debrid/rd-ledger.js';
import * as rdOracle from '../debrid/rd-oracle.js';
import * as autofetch from './autofetch.js';
import * as releaseIndex from '../utils/release-index.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { remainingCheckBudget } from '../utils/deadline.js';
import type { FirstObserverState } from './stream-builder.js';
import { dropTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';

// I0 — observabilidade do funil da primeira resposta BR no corte do debrid.
// O brFound agora é contado no buildStreams (funil pré-debrid); aqui ficam
// apenas brCached/brHidden (ESTAGIADOS no estado para a finalização coerente
// no `onSelected`) e o aviso do cachedOnly. Métricas first só na passada
// reclamada (`observeFirstPass`); o aviso, porém, vale em TODOS os passes,
// inclusive nos tardios — é transparência do corte, não diagnóstico de
// primeira resposta. Estes contadores não mudam comportamento; só observam os
// pontos de corte que já existem.
export function countFirstBr(
  streams: Stream[],
  cached: Set<string>,
  after: Stream[],
  observeFirstPass: boolean,
  firstObserver: FirstObserverState | null | undefined,
  showCachedOnly: { cachedOnly: boolean; showUncachedBr: boolean },
) {
  const isBr = (s: Stream) => Boolean((s as any)._br);
  const brEntered = streams.filter(isBr).length;
  if (!brEntered) return;
  // Normaliza o lote de cache para minúsculo antes de comparar: o hash do CDN
  // pode chegar em caixa mista e o `infoHash` do stream já vem normalizado.
  const cachedLc = new Set([...cached].map((h) => String(h).toLowerCase()));
  const brCached = streams.filter((s) => isBr(s) && s.infoHash && cachedLc.has(String(s.infoHash).toLowerCase())).length;
  const brSurvived = after.filter(isBr).length;
  const hidden = brEntered - brSurvived;
  // pendingBrHidden alimenta o log da entrada do corte e o notice de UI em
  // TODO passe — não só o first. Sempre sobrescreve (inclusive com 0) para
  // um passe que deixou de ocultar BR não herdar o N do passe anterior.
  // As métricas search.first.* continuam gateadas pelo observeFirstPass.
  if (firstObserver) firstObserver.pendingBrHidden = hidden;
  if (observeFirstPass && firstObserver && !firstObserver.firstCounted) {
    firstObserver.pendingBrCached = brCached;
  }
  // I1 — transparência do corte cachedOnly. "Sumiu o dublado" é a queixa mais
  // comum e sem esta mensagem é indistinguível de "não existe dublado no
  // acervo". O conserto não é código, é escolha de config, então o log aponta
  // a página e o switch. Só informa quando o corte realmente removeu BR fora
  // do cache e o usuário não optou por mostrá-los como P2P. Roda em TODO passe.
  if (showCachedOnly.cachedOnly && !showCachedOnly.showUncachedBr && hidden > 0) {
    log.warn(
      `[debrid] ${hidden} fonte(s) BR fora do cache ocultada(s) pelo cachedOnly ` +
      `(${brCached} em cache); ligue "Mostrar BR ainda fora do cache" para vê-las como P2P`,
    );
  }
}

/** Resultado do filtro pré-checagem: a lista viva e o total descartado
 * (bad+dead+lie+miss) que o `onCacheResult` precisa reportar quando a lista
 * esvazia. */
export type BrokenPrune = {
  streams: Stream[];
  trustDropped: number;
};

/**
 * Filtro pré-checagem: o que já PROVOU estar quebrado sai ANTES de gastar lote
 * (nem upload, na AllDebrid) com fracasso conhecido. Emite as métricas e o log
 * de descarte — o applyDebrid só precisa do resultado.
 */
export function pruneKnownBroken(
  streams: Stream[],
  adapterId: string,
  { apiKey, trustScope, season, episode, imdbId, trace }: {
    apiKey: string;
    trustScope: string;
    season?: number | null;
    episode?: number | null;
    imdbId?: string | null;
    /** P5 — ledger observacional: cada descarte leva o motivo real (bad, dead,
     * lie ou idx-miss) e o título, ANTES de gastar lote na checagem. */
    trace?: StreamTraceState | null;
  },
): BrokenPrune {
  // Banco de magnets + blacklist do autofetch: o que já PROVOU estar quebrado
  // sai ANTES da checagem — não se gasta lote (nem upload, na AllDebrid) com
  // fracasso conhecido. Só histórico desta conta: cache do debrid pertence a
  // ela, e um morto aqui pode estar vivo em outro serviço.
  // Contadores SEPARADOS por origem: bad é play sem vídeo (banco de magnets),
  // dead é estado terminal no recheck do autofetch. Somados escondem qual dos
  // dois corta — e é exatamente o que o diagnóstico precisa distinguir.
  let droppedBad = 0;
  let droppedDead = 0;
  let droppedLie = 0;
  let droppedMiss = 0;
  const kept = streams.filter((s) => {
    if (!s.infoHash) return true;
    if (magnetdb.isBad(adapterId, apiKey, s.infoHash)) {
      // Autocorreção tardia do dano F3: um ramo antigo marcava `bad` no hash
      // que o Real-Debrid recusou por lei (HTTP 451/error_code 35). Recusa
      // legal não é magnet quebrado, e NoVideoError legítimo não grava
      // `blocked`; logo `bad + blocked` neste adapter só pode ser aquela
      // escrita equivocada. Limpa e deixa o stream seguir: fora do cachedOnly
      // volta como P2P/sem ⚡; no cachedOnly o corte ternário o remove logo
      // abaixo pelo próprio ledger.
      if (config.debrid.rdLedger.enabled && adapterId === 'realdebrid' && rdLedger.peek(s.infoHash) === 'blocked') {
        if (magnetdb.forgetBad(adapterId, apiKey, s.infoHash)) {
          metrics.count('magnetdb.bad.clearedBlocked');
          log.info(`[debrid] bad RD de recusa legal recuperado (${String(s.infoHash).slice(0, 8)})`);
        }
        return true;
      }
      droppedBad += 1;
      dropTrace(trace, s, 'bad');
      return false;
    }
    if (s._lied || magnetdb.isLie(adapterId, apiKey, s.infoHash)) {
      droppedLie += 1;
      dropTrace(trace, s, 'lie');
      return false;
    }
    // Prova fina do índice: este hash já provou NÃO servir ESTE episódio
    // (play ou tail). Só vale com s/e + obra na busca — filme e série sem
    // episódio não têm o que conferir.
    if (season != null && episode != null && imdbId && releaseIndex.isMissing(imdbId, { season, episode }, s.infoHash)) {
      droppedMiss += 1;
      dropTrace(trace, s, 'idx-miss');
      return false;
    }
    if (autofetch.isDead(adapterId, trustScope, s.infoHash)) {
      droppedDead += 1;
      dropTrace(trace, s, 'dead');
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
  return { streams: kept, trustDropped: droppedBad + droppedDead + droppedLie + droppedMiss };
}

/**
 * Sonda do oráculo RD antes da checagem do adaptador: grava os veredictos no
 * ledger global para o `checkCached` poder afirmar `complete` sem rede extra.
 */
export async function probeRdOracle(
  hashes: string[],
  { adapter, season, episode, imdbId, deadlineAt, apiKey }: {
    adapter: DebridAdapter;
    season?: number | null;
    episode?: number | null;
    imdbId?: string | null;
    deadlineAt?: number | null;
    apiKey: string;
  },
): Promise<void> {
  // O RD não expõe mais instantAvailability. O oráculo consulta fontes que
  // conhecem o CDN e registra somente as respostas autoritativas no ledger;
  // hash ausente no Torrentio continua desconhecido, nunca vira miss.
  if (!(adapter.id === 'realdebrid' && adapter.cacheCheck && imdbId && hashes.length > 0)) return;
  const oracleBudget = remainingCheckBudget(deadlineAt, Date.now(), config.debrid.checkFormatMargin);
  if (!(oracleBudget == null || oracleBudget > 0)) return;
  const limit = Math.min(hashes.length, 500);
  const oracleHashes = [...new Set(hashes.map((hash) => String(hash).toLowerCase()))].slice(0, limit);
  const type = season != null || episode != null ? 'series' as const : 'movie' as const;
  const id = type === 'series' ? `${imdbId}:${season ?? 0}:${episode ?? 0}` : imdbId;
  const verdicts = await rdOracle.check({
    hashes: oracleHashes,
    type,
    id,
    timeoutMs: oracleBudget == null ? config.debrid.rdOracle.timeoutMs : Math.min(oracleBudget, config.debrid.rdOracle.timeoutMs),
  }, apiKey);
  const hits: string[] = [];
  for (const [hash, cachedByOracle] of verdicts) {
    if (cachedByOracle) hits.push(hash);
    else rdLedger.noteMiss(hash);
  }
  if (hits.length) rdLedger.noteHit(hits);
}

/** Resultado da complementação de ⚡ para adaptador sem `cacheCheck`. */
export type InstantEnrichment = {
  /** Conjunto que o autofetch enxerga (inventário quando ele responde). */
  cachedForAutofetch: Set<string>;
  /** `known` do chamador, salvo quando o inventário responde (aí é true). */
  knownForAutofetch: boolean;
  /** Retrato COMPLETO da conta obtido — é o que autoriza o corte cachedOnly. */
  accountKnown: boolean;
};

/**
 * Complementa o conjunto `cached` (cujo dono continua sendo o applyDebrid —
 * aqui só se ACRESCENTAM hits gratuitos) com duas fontes que só valem para
 * adaptador SEM `cacheCheck` (Real-Debrid / Debrid-Link): o inventário pronto
 * da conta e o histórico durável de play desta credencial.
 *
 * Apesar do nome, a função é também o ponto de gancho do atalho do histórico
 * em adaptador COM `cacheCheck` quando a checagem DEGRADA
 * (`DEBRID_ALIVE_AS_CACHE`): o núcleo do pipeline chama este passo para todo
 * adaptador, então a sobra da checagem mora aqui sem tocar o `debrid-pipeline-core.ts`.
 */
export function enrichInstantWithoutCacheCheck(
  adapter: DebridAdapter,
  streams: Stream[],
  cached: Set<string>,
  known: boolean,
  apiKey: string,
): InstantEnrichment {
  // Dedupe por inventário para adaptadores sem cacheCheck (Real-Debrid / Debrid-Link)
  let cachedForAutofetch: Set<string> = cached;
  let knownForAutofetch = known;
  // O inventario da conta respondeu? So com ele em maos o corte do cachedOnly
  // pode rodar num adaptador sem cacheCheck — com memo frio o conjunto vem
  // vazio e o corte apagaria a lista inteira.
  let accountKnown = false;
  if (!adapter.cacheCheck && adapter.autofetchSource) {
    const peek = debrid.inventoryPeek(adapter, apiKey);
    if (peek) {
      const inv = new Set(peek.map((i) => String(i.infoHash || '').toLowerCase()));
      knownForAutofetch = true;
      // O que ja esta PRONTO na conta toca na hora — isso e ⚡ de verdade, e o
      // unico que sobrou desde que o Real-Debrid aposentou o
      // /torrents/instantAvailability. Sem isto o inventario so alimentava o
      // autofetch e a lista inteira saia [RD Download] mesmo com o arquivo
      // baixado. `known` fica como esta de proposito: a conta nao responde pelo
      // cache GLOBAL do servico, entao o corte do cachedOnly continua sem base
      // para descartar o resto.
      let fromInventory = 0;
      for (const hash of inv) {
        if (cached.has(hash)) continue;
        cached.add(hash);
        fromInventory += 1;
      }
      if (fromInventory) metrics.count('debrid.instant.fromInventory', fromInventory);
      // Inventário pronto é uma observação gratuita do CDN do RD. O magnetdb
      // continua por conta; o ledger é global porque o cache é do serviço.
      if (adapter.id === 'realdebrid') rdLedger.noteHit([...inv]);
      accountKnown = true;
      return { cachedForAutofetch: inv, knownForAutofetch, accountKnown };
    }
    knownForAutofetch = false;
    debrid.inventory().catch((err: unknown) =>
      log.warn(`[${adapter.id}] aquecimento de inventário em fundo falhou:`, log.errorMessage(err)),
    );
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
  if (!adapter.cacheCheck && apiKey) {
    let doHistorico = 0;
    const aliveHashes: string[] = [];
    for (const s of streams) {
      const hash = String(s.infoHash || '').toLowerCase();
      if (!hash || cached.has(hash)) continue;
      if (magnetdb.isAlive(adapter.id, apiKey, hash)) {
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

  // DEBRID_ALIVE_AS_CACHE — sobra da checagem em adaptador COM cacheCheck
  // (AllDebrid na prática): a resposta do serviço é a autoridade e vale sobre
  // a memória; o que se faz aqui é completar, APENAS quando ela degrada
  // (`known:false` — prazo, lote perdido, hash omitido), os hashes que o
  // banco de magnets provou vivos (play desta conta, TTL 7d) e nenhum davail 0
  // fresco contradiz. Guardas do desenho, todas obrigatórias:
  //   - bad/lie venceram antes (pruneKnownBroken cortou na entrada) e markBad
  //     apaga o alive do mesmo hash — histórico ruim não ressuscita aqui;
  //   - peekDavail 0 fresco VETA: o play acabou de provar o hash frio;
  //   - accountKnown segue false — memória com TTL não é retrato da conta e
  //     não pode autorizar o corte do cachedOnly a descartar o resto;
  //   - o snapshot para o autofetch é capturado ANTES da inflação: ⚡ pintado
  //     por histórico não pode convencer o chupim de que o download já está
  //     pronto (ele decide com a evidência medida, que degradou);
  //   - nada é escrito (davail, magnetdb, ledger): falso positivo do atalho
  //     morre no TTL do alive, não se consolida; um play que se apoiar nele e
  //     voltar não-ready grava o negativo de 120s pelo noteUnavailable.
  if (adapter.cacheCheck && apiKey && config.debrid.aliveAsCache && !known) {
    cachedForAutofetch = new Set(cached);
    const account = accountScope(apiKey);
    let doHistorico = 0;
    for (const s of streams) {
      const hash = String(s.infoHash || '').toLowerCase();
      if (!hash || cached.has(hash)) continue;
      // O negativo só VETA quando negativos estão ligados (availNegTtl > 0):
      // 0 desliga a leitura/escrita negativa por contrato, então um 0 na chave
      // não é evidência — é lixo que o próprio sistema deixaria de escrever.
      const negativoFresco = config.debrid.availNegTtl > 0 && peekDavail(adapter.id, apiKey, hash) === 0;
      // 8.14 — hash marcado "não re-subir" não ganha ⚡ do atalho: o registro
      // diz que a limpeza INTENCIONAL o apagou, e pintá-lo de tocável ofereceria
      // um play que o serviço não tem (o enqueue dele já é recusado). Para
      // adaptador não-AD não há registro — a guarda é um peek síncrono, sem rede.
      if (reuploadBlocked(account, hash)) continue;
      if (magnetdb.isAlive(adapter.id, apiKey, hash) && !negativoFresco) {
        cached.add(hash);
        doHistorico += 1;
      }
    }
    if (doHistorico) {
      // Métrica PRÓPRIA, distinta do `fromHistory` legado (RD/DL por play):
      // misturar as duas semânticas esconderia qual fonte pintou o ⚡.
      metrics.count('debrid.instant.fromAliveAsCache', doHistorico);
      log.info(`[debrid] ${doHistorico} stream(s) com ⚡ pelo histórico (checagem degradada, alive-as-cache)`);
    }
  }
  return { cachedForAutofetch, knownForAutofetch, accountKnown };
}
