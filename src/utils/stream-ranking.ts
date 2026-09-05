import { priorityMap, compareIndexerPriority } from './indexer-priority.js';
import type { Stream } from '../../types/domain.js';
import { UNKNOWN_QUALITY, audioFromTitle, sourceFromTitle, editionFromTitle } from './audio-quality.js';
import { parseTitleSeasonEpisode } from './episode-matching.js';
import { selectQualityCandidates } from './stream-quotas.js';
import { streamDisplayName, passesQualityFilter } from './search-names.js';
import { dropTrace } from './stream-trace.js';
import type { StreamTraceState, TraceReason } from './stream-trace.js';
import {
  DUBBED_QUALITY_WEIGHT,
  AUTOFETCH_TARGET_QUALITIES,
  isAutofetchTargetQuality,
  brDubbedPool,
  anyDubbedPool,
  topSeededPool,
} from './autofetch-pools.js';
import type { PoolsOptions, AutofetchTargetQuality } from './autofetch-pools.js';
import {
  hashSet,
  pickFromPool,
  pickBrDubbedCandidates,
  pickBrDubbedByTargetQualities,
  cachedBrDubbedTargetQualities,
  pickBrDubbedCandidate,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  hasCachedBrDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
} from './autofetch-picks.js';
import type { AutofetchOptions } from './autofetch-picks.js';

interface SortOptions {
  minSeeders?: number;
  maxResults?: number;
  qualityFilter?: string[];
  season?: number | null;
  episode?: number | null;
  preferDubbed?: boolean;
  excludeCam?: boolean;
  maxSizeGb?: number;
  qualityLimits?: Partial<Record<string, number>>;
  brReservedSlots?: number;
  brReservedPerQuality?: number;
  candidateFactor?: number;
  brFirst?: boolean;
  indexerPriority?: string[];
  instant?: ((hash: string) => boolean) | null;
  /** P5 — ledger observacional; os cortes desta função ficam registrados. */
  trace?: StreamTraceState | null;
}

/**
 * Reescreve a linha do vencedor BR quando o perdedor traz metadados melhores.
 * Origem e áudio pertencem ao post vencedor; só o post BR pode aproveitar o
 * título scene do perdedor, porque ele costuma ser esparso nesses campos.
 *
 * Fonte e corte saem do mesmo texto, pela mesma razão do áudio: reconstruir sem
 * eles apagava o "BluRay"/"Extended" que o rótulo já mostrava, e duas releases
 * do mesmo filme voltavam a ficar indistinguíveis depois do merge. Vale nos
 * dois modos: em `full` o texto é a release, em `compact` é o resumo — que
 * carrega os mesmos termos.
 */
function relabel(stream: any, { isBr, dubbedFrom }: { isBr?: boolean; dubbedFrom?: any }) {
  const [title = '', stats = ''] = String(stream.name || '').split('\n');
  const seeders = Number(String(stats).match(/👤\s*(\d+)/)?.[1] || stream._seeders || 0);
  const borrowedTitle = isBr ? dubbedFrom : '';
  const audio = audioFromTitle(title) || audioFromTitle(borrowedTitle);
  return streamDisplayName({
    title,
    quality: stream._quality,
    audio,
    source: sourceFromTitle(title) || sourceFromTitle(borrowedTitle),
    edition: editionFromTitle(title) || editionFromTitle(borrowedTitle),
    tracker: stream._tracker,
    isBr,
    seeders,
  });
}

/** Mesma release aparece em vários indexers; fica a de maior seeders. */
function dedupeByHash(streams: any[], indexerPriority: string[] = [], trace?: StreamTraceState | null) {
  const best = new Map();
  const ranks = priorityMap(indexerPriority);
  for (const s of streams) {
    if (!s) continue;
    const prev = best.get(s.infoHash);
    if (!prev) {
      best.set(s.infoHash, s);
      continue;
    }
    // Agregadores BR espelham magnets públicos: mesma hash não prova que o
    // arquivo global tenha áudio PT. Origem e áudio ficam com o post vencedor.
    const seedDiff = (s._seeders || 0) - (prev._seeders || 0);
    // Hash idêntico é a mesma release. Seeders continuam sendo a evidência
    // principal; no empate, a listagem com áudio PT declarado vence — é a
    // única informação que o espelho em inglês não carrega, e a varredura
    // pt-BR devolve justamente esse título para o MESMO hash. Sem o critério,
    // o merge ficava com a chegada mais antiga e o _br sumia junto.
    // Persistindo o empate, a preferência do usuário torna o merge estável.
    let winner;
    if (seedDiff > 0) winner = s;
    else if (seedDiff < 0) winner = prev;
    else if (Boolean(s._dubbed) !== Boolean(prev._dubbed)) winner = s._dubbed ? s : prev;
    else winner = compareIndexerPriority(s, prev, ranks) < 0 ? s : prev;
    const loser = winner === s ? prev : s;
    // P5 — o perdedor do merge some da lista em silêncio; no ledger fica o
    // título dele e de quem venceu não precisa: o item é o mesmo hash.
    dropTrace(trace, loser, 'dedupe');
    // O indexer BR priorizado pode omitir resolução/tamanho enquanto o global
    // traz metadados completos para o mesmo hash. A prioridade escolhe o rótulo
    // e a origem, mas não deve degradar cota, bingeGroup ou tamanho conhecido.
    const richerQuality = winner._quality === UNKNOWN_QUALITY && loser._quality !== UNKNOWN_QUALITY
      ? loser
      : winner;
    const merged = {
      ...winner,
      _quality: richerQuality._quality,
      _size: winner._size || loser._size || 0,
      behaviorHints: richerQuality.behaviorHints || winner.behaviorHints,
      _br: winner._br,
      _dubbed: winner._dubbed,
      _tracker: winner._tracker,
      // Hash idêntico tem o mesmo conteúdo: se QUALQUER listagem marcou como
      // pack, a marca precisa sobreviver ao merge — senão o perdedor BR com
      // título de coleção perderia o estrito para o vencedor EN sem marca.
      _multiWork: Boolean(winner._multiWork || loser._multiWork),
      _lied: Boolean(winner._lied || loser._lied),
    };
    if (merged._quality !== winner._quality) {
      merged.name = relabel(merged, {
        isBr: winner._br,
        dubbedFrom: winner._br ? String(loser.name || '').split('\n')[0] : '',
      });
    }
    best.set(s.infoHash, merged);
  }
  return [...best.values()];
}

function sortAndLimit(
  streams: (Stream | null)[],
  {
    minSeeders = 0,
    maxResults = 40,
    qualityFilter = [],
    season = null,
    episode = null,
    preferDubbed = false,
    excludeCam = false,
    maxSizeGb = 0,
    qualityLimits = {},
    brReservedSlots = 0,
    brReservedPerQuality = 0,
    candidateFactor = 1,
    brFirst = true,
    indexerPriority = [],
    instant = null as null | ((hash: string) => boolean),
    trace,
  }: SortOptions = {},
) {
  // Release que nomeia o episódio pedido vem antes do pack da temporada: o pack
  // serve, mas quem pediu o E01 quer ver o E01 no topo da lista.
  // O marcador é estático por stream; o comparador o lia via
  // parseTitleSeasonEpisode a cada comparação (~n·log n parses do mesmo
  // título), então ele é pré-computado uma vez antes do sort.
  const dubbed = (s: any) => (s._dubbed ? 1 : 0);
  const maxSizeBytes = maxSizeGb > 0 ? maxSizeGb * 1024 ** 3 : 0;
  const indexerRanks = priorityMap(indexerPriority);

  // P5 — aplica UM predicado e registra quem caiu com o motivo exato. Com o
  // trace desligado é um filter comum (o diff só roda quando há queda).
  const filtrar = (entrada: any[], motivo: TraceReason, predicado: (s: any) => boolean) => {
    const saida = entrada.filter(predicado);
    if (trace && saida.length !== entrada.length) {
      const vivos = new Set(saida);
      for (const s of entrada) if (!vivos.has(s)) dropTrace(trace, s, motivo);
    }
    return saida;
  };

  let candidates = dedupeByHash(streams, indexerPriority, trace);
  candidates = filtrar(candidates, 'min-seeders', (s) => (s._seeders || 0) >= minSeeders);
  candidates = filtrar(candidates, 'quality-filter', (s) => passesQualityFilter(s, qualityFilter, qualityLimits));
  candidates = filtrar(candidates, 'cam-excluded', (s) => !excludeCam || sourceFromTitle(s.title) !== 'CAM');
  // Tamanho ausente não é tratado como zero real: sem dado confiável, o
  // stream continua visível em vez de ser descartado silenciosamente.
  candidates = filtrar(candidates, 'size-limit', (s) => !maxSizeBytes || !s._size || s._size <= maxSizeBytes);

  const exactFlag = new Map();
  if (season != null && episode != null) {
    for (const s of candidates) {
      exactFlag.set(s, parseTitleSeasonEpisode(s.title).episodes.includes(episode) ? 1 : 0);
    }
  }

  const ordered = candidates
    .sort((a, b) => {
      const ed = (exactFlag.get(b) || 0) - (exactFlag.get(a) || 0);
      if (ed !== 0) return ed;
      // Sem resolução fica acima do SD e abaixo do 720p: é quase sempre um
      // WEB-DL BR que não anuncia resolução, não uma cópia ruim.
      const qOrder: Record<string, number> = { '2160p': 5, '1080p': 4, '720p': 3, [UNKNOWN_QUALITY]: 2, '480p': 1, SD: 0 };
      const qd = (qOrder[b._quality] || 0) - (qOrder[a._quality] || 0);
      if (qd !== 0) return qd;
      if (preferDubbed) {
        const ad = dubbed(b) - dubbed(a);
        if (ad !== 0) return ad;
      }
      // "Priorizar dublado" é uma escolha explícita mais específica que a
      // fonte preferida. Depois dela, o indexador desempata sem vencer qualidade.
      const pd = compareIndexerPriority(a, b, indexerRanks);
      if (pd !== 0) return pd;
      // Histórico durável do banco de magnets: hash que o debrid comprovou
      // como play instantâneo vence a aposta de seeders — evidência medida
      // contra probabilidade.
      if (instant) {
        const hd = (instant(b.infoHash) ? 1 : 0) - (instant(a.infoHash) ? 1 : 0);
        if (hd !== 0) return hd;
      }
      // A prova não muda qualidade/dublado/prioridade; só impede que seeders
      // deixem uma release mentirosa acima de uma alternativa desconhecida.
      const ld = (a._lied ? 1 : 0) - (b._lied ? 1 : 0);
      if (ld !== 0) return ld;
      return (b._seeders || 0) - (a._seeders || 0);
    });

  const selecionados = selectQualityCandidates(ordered, {
    maxResults,
    qualityLimits,
    brReservedSlots,
    brReservedPerQuality,
    candidateFactor,
    brFirst,
  });
  // P5 — o pool pré-debrid é maior que o que segue adiante (candidateFactor):
  // quem caiu aqui não é ruim, é excedente da ampliação.
  if (trace && selecionados.length !== ordered.length) {
    const vivos = new Set(selecionados);
    for (const s of ordered) if (!vivos.has(s)) dropTrace(trace, s, 'pool-cut');
  }
  return selecionados
    // `_quality` e `_br` precisam sobreviver ao debrid: as cotas e a reserva
    // são aplicadas só depois que cachedOnly remove os streams indisponíveis.
    // `_dubbed` também precisa chegar ao autofetch: sem ele uma fonte BR sem
    // marca de áudio venceria mesmo quando existe uma explicitamente dublada.
    // `_indexer` idem, para a cota por indexador do corte final; quem apaga
    // todos os campos internos é `limitReservingBr`.
    .map(({ _seeders, _size, ...rest }: any) => rest);
}

export {
  DUBBED_QUALITY_WEIGHT,
  AUTOFETCH_TARGET_QUALITIES,
  isAutofetchTargetQuality,
  brDubbedPool,
  anyDubbedPool,
  topSeededPool,
  hashSet,
  pickFromPool,
  pickBrDubbedCandidates,
  pickBrDubbedByTargetQualities,
  cachedBrDubbedTargetQualities,
  pickBrDubbedCandidate,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  hasCachedBrDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
  relabel,
  dedupeByHash,
  sortAndLimit,
};

export type { SortOptions, PoolsOptions, AutofetchOptions, AutofetchTargetQuality };
