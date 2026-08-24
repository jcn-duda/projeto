import { priorityMap, compareIndexerPriority } from './indexer-priority.js';
import type { Stream, DebridAdapter } from '../../types/domain.js';
import { UNKNOWN_QUALITY, audioFromTitle, sourceFromTitle, editionFromTitle, hasExplicitForeignAudio, looksPtBr, hasPtSigns } from './audio-quality.js';
import { isSeasonPackRelease, parseTitleSeasonEpisode } from './episode-matching.js';
import { streamQuality, selectQualityCandidates } from './stream-quotas.js';
import { streamDisplayName, passesQualityFilter } from './search-names.js';

interface PoolsOptions {
  season?: number | null;
  minSeeders?: number;
  /**
   * Preferência PT no pool de swarm: candidato com sinal de português vence
   * a contagem bruta de seeders. É PREFERÊNCIA, não filtro — sem nenhum
   * candidato PT a ordenação por seeders continua valendo.
   */
  ptFirst?: boolean;
}

interface AutofetchOptions {
  autoFetchBr?: boolean;
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
function dedupeByHash(streams: any[], indexerPriority: string[] = []) {
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

// Peso de resolução dos pools de autofetch (BR e global): 1080p/720p vencem
// 2160p porque o download esquenta o cache para o play rápido, não para baixar
// o maior arquivo; SD fica por último.
const DUBBED_QUALITY_WEIGHT: Record<string, number> = {
  '1080p': 6,
  '720p': 5,
  '2160p': 4,
  [UNKNOWN_QUALITY]: 3,
  '480p': 2,
  SD: 1,
};

/**
 * O que mandar o debrid baixar quando NÃO existe fonte BR dublada tocável.
 * `null` = não faça nada, e é o retorno na maioria das buscas.
 *
 * Cuidado deliberado aqui, porque o efeito é escrever na conta do usuário:
 * - só olha o que tem infoHash (stream já resolvido não tem o que enfileirar);
 * - se QUALQUER candidato BR já está em cache, não baixa nada — já dá play;
 * - `streams` chega ordenado, então o primeiro é o melhor candidato;
 * - BR sem marca de áudio no título entra como dublado só quando nenhum
 *   candidato tiver a marca: é o padrão dos sites BR ("Nome (2026) [opção 3]"),
 *   mas um "LEGENDADO" explícito nunca é tratado como dublado.
 *
 */
function brDubbedPool(streams: Stream[] = [], { season }: PoolsOptions = {}) {
  const br = streams.filter(
    (s) => s && s.infoHash && s._br && sourceFromTitle(s.title || s.name || '') !== 'CAM',
  );
  if (br.length === 0) return [];
  const tagged = br.filter((s) => s._dubbed);
  const candidates = tagged.length
    ? tagged
    : br.filter((s) => audioFromTitle(s.title || s.name || '') !== 'Legendado');

  // Pré-computado uma vez: o sort consultaria o mesmo parse n·log n vezes.
  const packOf = season == null
    ? null
    : new Map(candidates.map((s) => [s, isSeasonPackRelease(s, season)]));

  return [...candidates].sort((a, b) => {
    // 1. Quem tem marcação explícita de dublado/dual/nacional
    const dubDiff = (b._dubbed ? 1 : 0) - (a._dubbed ? 1 : 0);
    if (dubDiff !== 0) return dubDiff;

    // 2. Pack da temporada pedida (só em busca de série): um download serve o
    // binge inteiro em vez de um episódio, e vale mais que resolução/seeders.
    if (packOf) {
      const packDiff = (packOf.get(b) ? 1 : 0) - (packOf.get(a) ? 1 : 0);
      if (packDiff !== 0) return packDiff;
    }

    // 3. Resolução ideal para download e playback rápido
    const qA = streamQuality(a);
    const qB = streamQuality(b);
    const qDiff = (DUBBED_QUALITY_WEIGHT[qB] || 0) - (DUBBED_QUALITY_WEIGHT[qA] || 0);
    if (qDiff !== 0) return qDiff;

    // 4. Mais seeders para o debrid baixar o torrent rapidamente
    return (b._seeders || 0) - (a._seeders || 0);
  });
}

/**
 * Pool do fallback global do autofetch: quando a busca não achou NENHUMA fonte
 * BR dublada, o que resta baixar são as releases com áudio dublado/dual/
 * nacional marcado no título (`_dubbed`). Sem a marca não entra — fora dos
 * sites BR o padrão é o contrário, legendado domina, e o fallback "sem marca
 * vale como dublado" do pool BR encheria a conta com o que o usuário não
 * pediu. (BR elegível aqui é impossível na prática: se existisse, o pool BR
 * já teria sido escolhido no lugar deste.)
 *
 */
function anyDubbedPool(streams: Stream[] = [], { season }: PoolsOptions = {}) {
  const candidates = streams.filter(
    (s) => s && s.infoHash && s._dubbed && sourceFromTitle(s.title || s.name || '') !== 'CAM',
  );
  // Mesmo bônus de pack do pool BR, pré-computado para o sort.
  const packOf = season == null
    ? null
    : new Map(candidates.map((s) => [s, isSeasonPackRelease(s, season)]));
  return [...candidates].sort((a, b) => {
    if (packOf) {
      const packDiff = (packOf.get(b) ? 1 : 0) - (packOf.get(a) ? 1 : 0);
      if (packDiff !== 0) return packDiff;
    }
    const qDiff =
      (DUBBED_QUALITY_WEIGHT[streamQuality(b)] || 0) - (DUBBED_QUALITY_WEIGHT[streamQuality(a)] || 0);
    if (qDiff !== 0) return qDiff;
    return (b._seeders || 0) - (a._seeders || 0);
  });
}

/**
 * Pool de segurança: prioriza o swarm, não a resolução, para o download terminar.
 *
 */
function topSeededPool(
  streams: Stream[] = [],
  { season, minSeeders = 0, ptFirst = true }: PoolsOptions = {},
) {
  const seedersOf = (s: any) => Number(s?._seeders ?? (String(s?.name || '').match(/👤\s*(\d+)/)?.[1] || 0));
  const candidates = streams.filter((s) =>
    s && s.infoHash && sourceFromTitle(s.title || s.name || '') !== 'CAM' &&
    seedersOf(s) >= minSeeders && !hasExplicitForeignAudio(s.title || s.name || ''),
  );
  const packOf = season == null ? null : new Map(candidates.map((s) => [s, isSeasonPackRelease(s, season)]));
  // Pré-computado uma vez, como o packOf: o sort consultaria o parse do mesmo
  // título n·log n vezes. Marca de áudio PT (looksPtBr) ou título que denuncia
  // português (hasPtSigns) — a rede de segurança baixava a release estrangeira
  // com mais pares e o usuário ficava sem dublagem mesmo havendo alternativa.
  const ptOf = ptFirst
    ? new Map(candidates.map((s) => {
      const t = String(s.title || s.name || '');
      return [s, looksPtBr(t) || hasPtSigns(t)];
    }))
    : null;
  return [...candidates].sort((a, b) => {
    if (packOf) {
      const packDiff = (packOf.get(b) ? 1 : 0) - (packOf.get(a) ? 1 : 0);
      if (packDiff) return packDiff;
    }
    // Entre o pack e os seeders: o candidato com sinal PT baixa primeiro.
    if (ptOf) {
      const ptDiff = (ptOf.get(b) ? 1 : 0) - (ptOf.get(a) ? 1 : 0);
      if (ptDiff) return ptDiff;
    }
    const seedDiff = seedersOf(b) - seedersOf(a);
    if (seedDiff) return seedDiff;
    return (DUBBED_QUALITY_WEIGHT[streamQuality(b)] || 0) - (DUBBED_QUALITY_WEIGHT[streamQuality(a)] || 0);
  });
}

/**
 * Set de hashes comparável com `stream.infoHash`.
 *
 * O conjunto de cacheados é sempre minúsculo (debrid/index.js normaliza na ida,
 * os adapters na volta), mas o infoHash do stream vem cru do Jackett — e o
 * Torznab devolve o btih em MAIÚSCULO. Comparar os dois direto erra silencioso:
 * o hash cacheado não é reconhecido e o autofetch baixa o que já estava pronto.
 */
function hashSet(hashes: Iterable<string> | null | undefined) {
  return new Set([...(hashes || [])].map((h) => String(h || '').toLowerCase()).filter(Boolean));
}

/**
 * Seleciona até `limit` candidatos de um pool JÁ ordenado (a ordem é a
 * prioridade), sem olhar cache:
 *
 * - dedupe de hash case-insensitive (indexers BR às vezes alternam a caixa do
 *   btih entre os posts que duplicam a mesma release);
 * - pula hashes já em cache — não há o que baixar para eles;
 * - no máximo `limit` candidatos.
 */
function pickFromPool(pool: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1) {
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  if (max === 0) return [];
  const cached = hashSet(cachedHashes);
  const seen = new Set();
  const out: Stream[] = [];
  for (const stream of pool) {
    if (!stream || !stream.infoHash) continue;
    const key = String(stream.infoHash).toLowerCase();
    if (seen.has(key) || cached.has(key)) continue;
    seen.add(key);
    out.push(stream);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Melhores candidatos BR dublados para o autofetch: o pool brDubbedPool já
 * ordena por marca de áudio, resolução e seeders.
 */
function pickBrDubbedCandidates(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1, options: PoolsOptions = {}) {
  return pickFromPool(brDubbedPool(streams, options), cachedHashes, limit);
}

/** Compatibilidade: o melhor candidato BR dublado, sem olhar cache. */
function pickBrDubbedCandidate(streams: Stream[] = [], cachedHashes: Set<string> = new Set()) {
  return pickBrDubbedCandidates(streams, cachedHashes, 1)[0] || null;
}

/** Candidatos do fallback global: mesmas regras do pick BR, sobre anyDubbedPool. */
function pickAnyDubbedCandidates(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1, options: PoolsOptions = {}) {
  return pickFromPool(anyDubbedPool(streams, options), cachedHashes, limit);
}

function pickTopSeededCandidates(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1, options: PoolsOptions = {}) {
  return pickFromPool(topSeededPool(streams, options), cachedHashes, limit);
}

/** Já existe fonte BR dublada tocável na hora? Então não há o que baixar. */
function hasCachedBrDubbed(streams: Stream[] = [], cachedHashes: Set<string> = new Set()) {
  const cached = hashSet(cachedHashes);
  return brDubbedPool(streams).some((s) => cached.has(String(s.infoHash || '').toLowerCase()));
}

function canAutoFetchBr({ autoFetchBr }: AutofetchOptions = {}, adapter?: DebridAdapter | null) {
  // cachedOnly não é mais trava: o objetivo do autofetch é justamente esquentar
  // o cache quando não há BR dublada pronta, independente do modo. As travas
  // reais são o toggle, o cacheCheck confiável ou fonte de autofetch por inventário (RD/DL).
  return Boolean(autoFetchBr && (adapter?.cacheCheck || adapter?.autofetchSource));
}

/**
 * Exceção explícita ao cachedOnly: as fontes globais continuam instantâneas,
 * mas as vagas reservadas BR não viram um vazio quando o dublado ainda não
 * chegou ao debrid. O stream fica como torrent P2P, sem selo ⚡.
 */
function uncachedBrHashes(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 0) {
  const selected = new Set();
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  // Mesmo pool do autofetch: a vaga P2P tem que ser o torrent que vamos baixar,
  // não um LEGENDADO que só estava mais acima na lista.
  for (const stream of brDubbedPool(streams)) {
    if (selected.size >= max) break;
    if (!cachedHashes.has(String(stream.infoHash))) selected.add(String(stream.infoHash));
  }
  return selected;
}

function filterKnownCache(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), {
  cachedOnly = true,
  showUncachedBr = false,
  brReservedSlots = 0,
} = {}) {
  const cachedBr = brDubbedPool(streams).filter((stream) =>
    cachedHashes.has(String(stream.infoHash)),
  ).length;
  const uncachedSlots = Math.max(0, Math.trunc(Number(brReservedSlots) || 0) - cachedBr);
  const visibleBr = cachedOnly && showUncachedBr
    ? uncachedBrHashes(streams, cachedHashes, uncachedSlots)
    : new Set();
  return {
    visibleBr,
    streams: streams.filter((stream) =>
      cachedHashes.has(String(stream.infoHash)) || !cachedOnly || visibleBr.has(String(stream.infoHash)),
    ),
  };
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
  } = {},
) {
  // Release que nomeia o episódio pedido vem antes do pack da temporada: o pack
  // serve, mas quem pediu o E01 quer ver o E01 no topo da lista.
  // O marcador é estático por stream; o comparador o lia via
  // parseTitleSeasonEpisode a cada comparação (~n·log n parses do mesmo
  // título), então ele é pré-computado uma vez antes do sort.
  const dubbed = (s: any) => (s._dubbed ? 1 : 0);
  const maxSizeBytes = maxSizeGb > 0 ? maxSizeGb * 1024 ** 3 : 0;
  const indexerRanks = priorityMap(indexerPriority);

  const candidates = dedupeByHash(streams, indexerPriority)
    .filter((s) => (s._seeders || 0) >= minSeeders)
    .filter((s) => passesQualityFilter(s, qualityFilter, qualityLimits))
    .filter((s) => !excludeCam || sourceFromTitle(s.title) !== 'CAM')
    // Tamanho ausente não é tratado como zero real: sem dado confiável, o
    // stream continua visível em vez de ser descartado silenciosamente.
    .filter((s) => !maxSizeBytes || !s._size || s._size <= maxSizeBytes);

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

  return selectQualityCandidates(ordered, {
    maxResults,
    qualityLimits,
    brReservedSlots,
    brReservedPerQuality,
    candidateFactor,
    brFirst,
  })
    // `_quality` e `_br` precisam sobreviver ao debrid: as cotas e a reserva
    // são aplicadas só depois que cachedOnly remove os streams indisponíveis.
    // `_dubbed` também precisa chegar ao autofetch: sem ele uma fonte BR sem
    // marca de áudio venceria mesmo quando existe uma explicitamente dublada.
    // `_indexer` idem, para a cota por indexador do corte final; quem apaga
    // todos os campos internos é `limitReservingBr`.
    .map(({ _seeders, _size, ...rest }: any) => rest);
}

export {
  dedupeByHash,
  pickBrDubbedCandidate,
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  topSeededPool,
  hasCachedBrDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
  sortAndLimit,
};
