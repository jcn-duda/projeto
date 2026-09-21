import config from '../config.js';
import type { RawItem, Stream } from '../../types/domain.js';
import {
  decodeEntities,
  resolveSearchNames,
  filterRelevantRaw,
  isMultiWorkCollection,
  looksPtBr,
  normalizeTitle,
  UNKNOWN_QUALITY,
  toStremioStream,
  extractInfoHash,
  sortAndLimit,
} from '../utils/format.js';
import debrid from '../debrid/index.js';
import * as magnetdb from '../utils/magnetdb.js';
import * as releaseIndex from '../utils/release-index.js';
import { opts } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { stageTrace, dropTrace } from '../utils/stream-trace.js';
import type { StreamTraceState, TraceReason } from '../utils/stream-trace.js';
import type { RelevanceRejectReason } from '../utils/release-filters.js';
import { admitsMultiWorkPack } from '../utils/multiwork-pack.js';
import { applyProbedQuality } from './probed-quality.js';
import { applyPtTitleDual } from './pt-title-dual.js';
import { markBankFilterOutcome } from './magnet-bank-hook.js';
import { filterSeriesEpisodeRaw } from './stream-builder-episode-filter.js';
import type { MultiWorkCollection } from '../../types/domain.js';

// Indexer id vindo da config do usuario (URL) precisa validar antes de
// entrar em query, limite por id ou desempate -- id fora do padrao e
// descartado silenciosamente, nunca interpolado.
export const SAFE_INDEXER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

import { applyFileEvidence } from './stream-file-evidence.js';

export { applyFileEvidence };

export interface PrepareCandidatesOptions {
  meta?: { name?: string | null; title?: string; year?: number | string | null } | null;
  titles?: { original?: string | null; pt?: string | null; en?: string | null; year?: number | string | null } | null;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  isDemo?: boolean;
  /** Opt-in multiobra: contexto da coleção (TMDB) para admissão do pack. */
  multiWork?: MultiWorkCollection | null;
  trace?: StreamTraceState | null;
}

export interface CandidatePoolResult {
  streams: Stream[];
  workHint: { n: string[]; y: number | null } | null;
  safeIndexerLimits: Record<string, number>;
  qualityLimits: Record<string, number | undefined>;
  brReservedSlots: number;
  maxResults: number;
  brOnly: boolean;
  brFirst: boolean;
  maxPerIndexer: number;
  preferDubbed: boolean;
}

/**
 * Normaliza o lote cru de entradas, aplica filtros de relevância, descarta
 * packs multi-obra inválidos, filtra por episódio (com URI do magnet-bank
 * quando o índice não traz magnet), grava no releaseIndex o que sobreviveu,
 * calcula limites de indexer e cotas de qualidade, mapeia e pré-ordena os
 * candidatos que seguirão para a etapa de checagem do debrid.
 */
export function prepareCandidateStreams(
  rawInput: RawItem[],
  { meta, titles, imdbId, season, episode, isDemo, multiWork = null, trace }: PrepareCandidatesOptions = {},
): CandidatePoolResult {
  // P5 — primeiro estágio do funil: o lote cru que ENTROU na build. O ledger é
  // observacional: contar aqui não muda nada, e o que os cortes abaixo tirarem
  // fica registrado com o motivo exato.
  stageTrace(trace, 'raw', rawInput.length);
  // Entidade HTML some AQUI, onde todas as origens já se juntaram — Jackett,
  // resolvedores BR, índice e o inventário da conta do debrid. Decodificar só
  // na saída (toStremioStream) deixava a DECISÃO com a entidade crua: medido
  // no "Dois Homens e Meio 4&ordf; Temporada Completa", que o parser lia como
  // pack SEM temporada declarada — e pack sem temporada casa qualquer
  // episódio, então os packs da 4ª, 5ª e 6ª entravam na lista do S01E01.
  // O inventário da conta é o que obriga a normalização a ficar aqui: o nome
  // dele vem do torrent, nunca passou pelo provider.
  let raw = rawInput.map((item) => {
    const title = item?.title ?? item?.Title;
    if (typeof title !== 'string' || !title.includes('&')) return item;
    const limpo = decodeEntities(title);
    return limpo === title ? item : { ...item, title: limpo, ...(item.Title ? { Title: limpo } : {}) };
  });

  // No modo demo, se não for BBB, lista vazia (esperado)
  if (isDemo && raw.length === 0) {
    log.info('[search] modo demo: só tt1254207 (Big Buck Bunny) tem stream de teste');
  }

  // Aceita qualquer um dos nomes: release BR vem como "Coringa", a do Jackett
  // como "Joker" — filtrar só pelo inglês jogaria fora a fonte dublada.
  // As releases BR passam pelo filtro mais estrito (`matchesBrTitle`): os
  // buscadores WordPress devolvem posts "parecidos" ("Missão: Impossível –
  // Efeito Fallout" numa busca por "Fallout") que disputavam as vagas
  // reservadas com a fonte real.
  //
  // O gate é a existência de ALGUM nome, não do Cinemeta: quando ele volta 404
  // mas o TMDB responde, os nomes estão ali e o filtro precisa rodar. Preso a
  // `meta?.name` ele se desligava inteiro e a lista saía sem corte nenhum.
  const { names, year: catalogYear } = resolveSearchNames({ meta, titles });
  if (names.length && !isDemo) {
    const before = raw.length;
    // Itens do inventário da conta já passaram pelo filtro DELES no provider
    // (estrito + exceção de franquia, `filterInventoryRelevant`): re-aplicar
    // o estrito aqui mataria justamente o pack de franquia que a exceção
    // deixou passar ("FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS" para Star
    // Trek). Os nomes são os mesmos do matchContext que filtrou lá.
    const fromAccount = raw.filter((r) => r.fromAccount);
    const titleCtx = { names, year: catalogYear, isSeries: season != null, multiWork };
    const antesTitulo = raw;
    // Motivos específicos (named-sequel) no ledger; o resto continua title-filter.
    const rejectReasons = new Map<RawItem, RelevanceRejectReason>();
    const noteReject = (item: RawItem, reason: RelevanceRejectReason) => {
      rejectReasons.set(item, reason);
    };
    raw = fromAccount.length
      ? [...fromAccount, ...filterRelevantRaw(raw.filter((r) => !r.fromAccount), titleCtx, noteReject)]
      : filterRelevantRaw(raw, titleCtx, noteReject);
    // "(M BR)" deixa explícito se o descarte do título tocou BR — M=0 aponta
    // o culpado para outro elo (ex.: cachedOnly), não para matchesBrTitle.
    if (before !== raw.length) {
      const vivos = new Set(raw);
      const droppedBr = antesTitulo.filter((item) => {
        if (vivos.has(item)) return false;
        const title = String(item.title || item.Title || '');
        return Boolean(item.isBr) || looksPtBr(title);
      }).length;
      log.info(
        `[search] ${before - raw.length} resultado(s) fora do título descartado(s) (${droppedBr} BR)`,
      );
      // P5 — cada descarte pelo título leva o motivo real no ledger. O diff é
      // por referência de objeto: itens do inventário e sobreviventes são os
      // MESMOS objetos antes/depois.
      if (trace) {
        for (const item of antesTitulo) {
          if (vivos.has(item)) continue;
          const reason = rejectReasons.get(item);
          const mapped: TraceReason = reason === 'named-sequel' ? 'named-sequel' : 'title-filter';
          dropTrace(trace, item, mapped);
        }
      }
    }
    // Banco de magnets vivo: o resultado do filtro de título escreve
    // `passed_filter` 0/1 na obra (última observação; só work já capturada).
    markBankFilterOutcome(antesTitulo, raw, { imdbId, season, episode });
  }

  // Pack multiobra admitido (feature BR_MULTIWORK_PACKS): marca antes das
  // retenções; o record do índice roda DEPOIS do corte de episódio — senão
  // E03/E06 do Apache (título genérico "4ª Temporada") entravam sob S4E1.
  const multiWorkAdmitted = multiWork
    ? new Set(raw.filter((item) => admitsMultiWorkPack(item, { multiWork, year: catalogYear, isSeries: season != null, names })))
    : null;
  // Clona o admitido ao marcar: o item pode vir do raw cache (L1/L2)
  // compartilhado, e mutá-lo persistiria `_multiWorkAdmitted` no registro. A
  // marca é interna do Stream — `_multiWork` genérico NÃO basta.
  if (multiWorkAdmitted?.size) {
    raw = raw.map((item) => (multiWorkAdmitted.has(item) ? { ...item, _multiWorkAdmitted: true } : item));
  }

  // Guarda de coleção: pack multi-obra ("Todos os filmes 1979-2016") só é
  // oferecido quando alguém sabe escolher o arquivo certo dentro dele. Com
  // debrid, a dica de obra viaja assinada na URL e o pickFile escolhe; em P2P
  // o cliente baixaria o torrent inteiro e tocaria o MAIOR arquivo — quase
  // sempre o filme errado. Sem escolha por arquivo, o pack fica de fora.
  // Sem ano de catálogo, a dica assinada não consegue selecionar uma obra
  // dentro de uma coleção mesmo com debrid; retenha o pack nesse caso também.
  if (season == null && !isDemo && (!debrid.current() || !catalogYear)) {
    const beforePack = raw.length;
    const antesPack = raw;
    raw = raw.filter((r) => !isMultiWorkCollection(r.title || r.Title || ''));
    if (beforePack !== raw.length) {
      log.info(`[search] ${beforePack - raw.length} pack(s) multi-obra retido(s) sem escolha por arquivo`);
      // P5 — "retido" no vocabulário do pipeline: o pack SAIU da lista porque
      // ninguém saberia escolher o arquivo dentro dele.
      if (trace) { const vivos = new Set(raw); for (const item of antesPack) if (!vivos.has(item)) dropTrace(trace, item, 'multiwork-retained'); }
    }
  }

  // Dica de obra para o pickFile no play (só filme): nomes + ano limpo. O ano
  // do catálogo vem sujo ("2024–" para série em andamento); sem extrair o
  // primeiro token de 4 dígitos a dica levaria NaN e o casamento falharia.
  const workHint = season == null && names.length
    ? {
      n: names.slice(0, 4),
      y: Number(String(catalogYear || '').match(/(?:19|20)\d{2}/)?.[0] || 0) || null,
    }
    : null;

  // H2 (feature-scoped): com a feature ativa, pack de coleção sem dica de obra (nomes)
  // não vai à lista — o /resolve cairia no maior arquivo. Sem `multiWork` nada
  // muda; `_multiWork` genérico segue o caminho antigo.
  if (multiWork && season == null && !isDemo && !workHint) {
    raw = raw.filter((r) => !r._multiWorkAdmitted && !isMultiWorkCollection(r.title || r.Title || ''));
  }

  // Série: o indexer responde a "Nome S01E01" com a temporada inteira, então
  // sem este corte a lista do E01 vinha cheia de E03/E04/E09. Packs (título com
  // a temporada e sem episódio) passam — o debrid escolhe o arquivo no play.
  //
  // `filterRelevantRaw` (título, acima) roda SEM season/episode de propósito
  // — os itens da conta (`fromAccount`) já vieram filtrados pelo provider com
  // a exceção de franquia, e season/episode ali re-aplicaria a mesma checagem
  // duas vezes. Por isso a guarda de franquia-sem-marcador
  // (`matchesGlobalSeriesNoMarker`) mora AQUI, onde season/episode são reais:
  // medido no addon, "Demon Slayer: Infinity Castle" (filme, sem SxxEyy)
  // sobrevivia ao filtro de título (mesma franquia, sem homônimo parcial) e
  // ao `matchesEpisode` de baixo (abstém sem marcador) — as duas guardas
  // OMITEM exatamente o mesmo caso, e nenhuma das duas sozinha decide.
  const seriesUniverse = names.flatMap((n) => normalizeTitle(n).split(' ').filter(Boolean));
  if (season != null && episode != null && !isDemo) {
    const before = raw.length;
    const { kept, dropped } = filterSeriesEpisodeRaw(raw, season, episode, seriesUniverse);
    raw = kept;
    if (before !== raw.length) {
      log.info(`[search] ${before - raw.length} resultado(s) de outro episódio descartado(s)`);
      // P5 — outro episódio/temporada é o corte mais traiçoeiro de diagnosticar
      // ("o S03E04 publicado como S04"); no ledger ele fica com o título.
      if (trace) for (const item of dropped) dropTrace(trace, item, 'episode-mismatch');
    }
  }

  // Fase 2: alimenta o índice com o que SOBREVIVEU ao corte de episódio (e às
  // retenções multiobra acima). Record antes indexava E03/E06 sob S4E1.
  // Idempotente (merge por hash); pack multiobra admitido e fallback ficam fora.
  if (!isDemo && imdbId) {
    releaseIndex.record(imdbId, { season, episode }, raw.filter((item) => !item._multiWorkAdmitted && !item.fromFallback));
  }

  // Pool maior que MAX_RESULTS: o corte final é DEPOIS do debrid, senão fontes
  // sem seeders publicados (BLUDV) e não-cacheados ocupariam as vagas e sumiriam.
  const {
    minSeeders,
    maxResults,
    qualities,
    preferDubbed,
    dubbedOnly,
    excludeCam,
    maxSizeGb,
    max2160p,
    max1080p,
    max720p,
    max480p,
    maxSd,
    maxUnknown,
    maxPerIndexer,
    indexerLimits,
    brReservedSlots,
    brOnly,
    brFirst,
    indexerPriority,
  } = opts();
  const safeIndexerPriority = indexerPriority
    .filter((id: string) => SAFE_INDEXER_ID.test(String(id)))
    .slice(0, 100);
  const safeIndexerLimits: Record<string, number> = {};
  for (const [rawId, rawLimit] of Object.entries(indexerLimits || {}).slice(0, 100)) {
    const id = String(rawId).toLowerCase();
    if (!SAFE_INDEXER_ID.test(id)) continue;
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit)) continue;
    safeIndexerLimits[id] = Math.min(20, Math.max(0, Math.trunc(limit)));
  }
  const qualityLimits = {
    '2160p': max2160p,
    '1080p': max1080p,
    '720p': max720p,
    '480p': max480p,
    SD: maxSd,
    // Balde separado do SD: as fontes BR não publicam resolução e zerar SD não
    // pode desligar a prioridade brasileira junto.
    [UNKNOWN_QUALITY]: maxUnknown,
  };
  // Tipado como Stream[] de propósito: é este array que `applyNoticeOrigin`
  // fecha como item de aviso e entrega ao Stremio. Um item sem `url`/`infoHash`/
  // `externalUrl` (e sem a marca interna `notice`) morre fora da união — o que
  // deixa explícito na origem o aviso que nenhum cliente renderizava.
  // Proven quality/audio + ptTitleDual (DUAL global com título TMDB pt) antes do map.
  const evidencia = applyPtTitleDual(applyProbedQuality(applyFileEvidence(raw), { season, episode, workHint }), { titles, trace });
  const mappedStreams = evidencia.map((item) => {
    const stream = toStremioStream(item);
    // P5 — `toStremioStream` devolve NULL para item sem infoHash (link que
    // nenhum resolvedor abriu). Registrado UMA vez aqui, com o título bruto:
    // é o único ponto onde o item ainda tem nome — depois disto ele é null e
    // o sortAndLimit o pula em silêncio (sem re-registrar, para não duplicar).
    if (!stream) dropTrace(trace, item, 'no-hash');
    return stream;
  });
  // Histórico durável do banco de magnets: quem o debrid desta conta comprovou
  // como play instantâneo ganha desempate acima dos seeders no sort.
  const aliveAdapter = debrid.current();
  const aliveApiKey = opts().debridApiKey;
  const liedHashes = new Set(
    raw
      .filter((item) => item.lied)
      .map((item) => String(extractInfoHash(item.infoHash || item.magnet || '') || '').toLowerCase())
      .filter(Boolean),
  );
  // `toStremioStream` devolve NULL para item sem infoHash (link que nenhum
  // resolvedor abriu), e `sortAndLimit` recebe `(Stream | null)[]` de propósito
  // — o buraco tem que ser filtrado ANTES do acesso, senão um único resultado
  // sem hash derruba a lista inteira com TypeError.
  // Item já PRONTO na conta (memo dinv quente) é a mesma evidência medida do
  // alive: sem contá-lo aqui, o item do inventário com seeders baixos perde
  // para os globais dentro do balde e morre no pool de candidatos, ANTES do
  // debrid — a fonte que tocava na hora sumia da lista por aposta de seeders.
  const inventoryReady = new Set(
    (debrid.inventoryPeek(aliveAdapter, aliveApiKey) || [])
      .map((item) => String(item.infoHash || '').toLowerCase())
      .filter(Boolean),
  );
  const instantSet = aliveAdapter && aliveApiKey
    ? new Set(mappedStreams.flatMap((s) => s?.infoHash ? [s.infoHash] : [])
        .filter((h: string) =>
          (magnetdb.isAlive(aliveAdapter.id, aliveApiKey, h) ||
           inventoryReady.has(String(h).toLowerCase()) ||
           debrid.knownInstant(h)) &&
          !magnetdb.isLie(aliveAdapter.id, aliveApiKey, h) &&
          !liedHashes.has(String(h).toLowerCase())))
    : null;
  const liedSet = aliveAdapter && aliveApiKey
    ? new Set(mappedStreams.flatMap((s) => s?.infoHash ? [s.infoHash] : [])
        .filter((h: string) => liedHashes.has(String(h).toLowerCase()) || magnetdb.isLie(aliveAdapter.id, aliveApiKey, h)))
    : liedHashes;
  const markedStreams = mappedStreams.map((stream) =>
    stream && liedSet.has(String(stream.infoHash || '').toLowerCase())
      ? { ...stream, _lied: true, _dubbed: false }
      : stream,
  );
  const streams: Stream[] = sortAndLimit(markedStreams, {
    minSeeders,
    maxResults: maxResults * config.candidatePoolFactor,
    qualityFilter: qualities,
    season,
    episode,
    preferDubbed,
    dubbedOnly,
    excludeCam,
    maxSizeGb,
    qualityLimits,
    brReservedSlots,
    brReservedPerQuality: config.brReservedPerQuality,
    candidateFactor: config.candidatePoolFactor,
    brFirst,
    indexerPriority: safeIndexerPriority,
    instant: instantSet ? (h: string) => instantSet.has(String(h).toLowerCase()) : undefined,
    trace,
  });
  // P5 — segundo estágio: o que sobrou da ordenação/dedupe/pool pré-debrid.
  stageTrace(trace, 'afterSort', streams.length);

  return {
    streams,
    workHint,
    safeIndexerLimits,
    qualityLimits,
    brReservedSlots,
    maxResults,
    brOnly,
    brFirst,
    maxPerIndexer,
    preferDubbed,
  };
}
