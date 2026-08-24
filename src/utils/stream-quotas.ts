import type { Stream, StreamCandidate } from '../../types/domain.js';
import { UNKNOWN_QUALITY, qualityFromTitle } from './audio-quality.js';
import { isSeasonPackRelease } from './episode-matching.js';

const QUALITY_KEYS = ['2160p', '1080p', '720p', '480p', 'SD', UNKNOWN_QUALITY];
type QualityLimits = Partial<Record<string, number>>;

function streamQuality(stream: StreamCandidate) {
  return stream?._quality || qualityFromTitle(stream?.title || stream?.name || '');
}

/**
 * Separa espaço no pool pré-debrid para cada qualidade configurada. Sem isso,
 * centenas de 4K poderiam ocupar o pool inteiro e impedir que a cota pedida de
 * 1080p tivesse candidatos para sobreviver ao filtro de cache.
 */
function selectQualityCandidates(
  streams: StreamCandidate[],
  {
    maxResults = 40,
    qualityLimits = {} as QualityLimits,
    brReservedSlots = 0,
    brReservedPerQuality = 0,
    candidateFactor = 1,
    brFirst = true,
    indexerPriority = [],
  } = {},
) {
  const poolSize = Math.max(0, Math.trunc(maxResults));
  const custom = QUALITY_KEYS.filter((quality: string) => Number(qualityLimits[quality]) < 100);
  const customSet = new Set(custom);
  // Os mapas abaixo são populados para TODA qualidade de `custom` na criação,
  // então `.get(quality)` nunca devolve undefined quando `quality` pertence a
  // `custom`. O strictNullChecks não enxerga esse invariante; os casts
  // documentam a garantia sem mudar runtime.
  const buckets = new Map<string, StreamCandidate[]>(custom.map((quality) => [quality, []]));
  for (const stream of streams) {
    const bucket = buckets.get(streamQuality(stream));
    if (bucket) bucket.push(stream);
  }

  const selected = new Set();
  const positions = new Map<string, number>(custom.map((quality) => [quality, 0]));
  const counts = new Map<string, number>(custom.map((quality) => [quality, 0]));
  const factor = Math.max(1, Math.trunc(candidateFactor));
  const targets = new Map<string, number>(
    custom.map((quality) => [
      quality,
      Math.max(0, Math.trunc(Number(qualityLimits[quality]) || 0)) * factor,
    ]),
  );

  // A reserva precisa existir também quando a qualidade está em 100. Se os BR
  // forem considerados só no corte final, seeders globais podem preencher o
  // pool ampliado antes deles chegarem ao debrid.
  const brTarget = brFirst ? poolSize : brReservedSlots;

  // Reserva por faixa: sem ela, BR de 1080p abundante consumia as vagas BR na
  // ordem em que chegam e a faixa 4K/720p ficava sem BR no pool pré-debrid —
  // o corte final nunca vê candidato que aqui foi cortado.
  const perFaixa = Math.max(0, Math.trunc(Number(brReservedPerQuality) || 0));
  if (perFaixa > 0) {
    const faixaCounts = new Map<string, number>();
    for (const stream of streams) {
      if (selected.size >= poolSize || selected.size >= brTarget) break;
      if (!stream._br || selected.has(stream)) continue;
      const quality = streamQuality(stream);
      const usados = faixaCounts.get(quality) || 0;
      if (usados >= perFaixa) continue;
      if (customSet.has(quality) &&
        (counts.get(quality) as number) >= (targets.get(quality) as number)) continue;
      faixaCounts.set(quality, usados + 1);
      selected.add(stream);
      if (customSet.has(quality)) counts.set(quality, (counts.get(quality) as number) + 1);
    }
  }

  for (const stream of streams) {
    if (selected.size >= poolSize || selected.size >= brTarget) break;
    if (!stream._br || selected.has(stream)) continue;
    const quality = streamQuality(stream);
    if (customSet.has(quality) &&
      (counts.get(quality) as number) >= (targets.get(quality) as number)) continue;
    selected.add(stream);
    if (customSet.has(quality)) counts.set(quality, (counts.get(quality) as number) + 1);
  }

  // Round-robin evita que a primeira qualidade consuma todo o pool quando a
  // soma das cotas configuradas ultrapassa o máximo global.
  let progressed = true;
  while (selected.size < poolSize && progressed) {
    progressed = false;
    for (const quality of custom) {
      const bucket = buckets.get(quality) as StreamCandidate[];
      let position = positions.get(quality) as number;
      while (position < bucket.length && selected.has(bucket[position])) position += 1;
      positions.set(quality, position);
      if ((counts.get(quality) as number) >= (targets.get(quality) as number) ||
        position >= bucket.length) continue;
      selected.add(bucket[position]);
      positions.set(quality, position + 1);
      counts.set(quality, (counts.get(quality) as number) + 1);
      progressed = true;
      if (selected.size >= poolSize) break;
    }
  }

  // Qualidades em 100 são ilimitadas e preenchem o espaço restante sem tomar
  // as vagas já separadas para as cotas explícitas.
  for (const stream of streams) {
    if (selected.size >= poolSize) break;
    if (selected.has(stream)) continue;
    if (customSet.has(streamQuality(stream))) continue;
    selected.add(stream);
  }

  // A seleção reserva espaço, mas a ordem original de qualidade/seeders segue
  // intacta para a listagem e para o debrid.
  return streams.filter((stream) => selected.has(stream));
}

/**
 * Cota por indexador: teto de quantos streams cada fonte (YTS, BluDV, TheRARBG…)
 * pode ocupar na lista final. Sem isso um indexador com muitos resultados leva
 * quase todas as vagas e as outras fontes somem.
 *
 * `0` é SEM LIMITE, não "nenhum" — ao contrário das cotas por qualidade. Aqui o
 * default é desligado, e um 0 herdado de config antiga zerando a lista inteira
 * seria bem pior que um teto que não pega.
 *
 * `exempt` são as vagas reservadas BR: elas passam mesmo acima da cota, mas
 * continuam contando. Assim a reserva fura o teto sem ampliá-lo para os itens
 * seguintes da mesma fonte.
 */
function limitByIndexer(streams: StreamCandidate[], maxPerIndexer = 0, exempt: Set<StreamCandidate> = new Set(), indexerLimits: QualityLimits = {}) {
  const globalLimit = Math.max(0, Math.trunc(Number(maxPerIndexer) || 0));
  const hasOverrides = indexerLimits && typeof indexerLimits === 'object' &&
    Object.keys(indexerLimits).length > 0;
  if (!globalLimit && !hasOverrides) return streams;
  const counts = new Map();
  return streams.filter((stream) => {
    // Stream sem indexador conhecido não vira um balde comum com os outros:
    // eles se limitariam entre si por acidente de metadado ausente.
    const source = String(stream?._indexer || '').trim().toLowerCase();
    if (!source) return true;
    const ownLimit = Object.prototype.hasOwnProperty.call(indexerLimits, source)
      ? Math.max(0, Math.trunc(Number(indexerLimits[source]) || 0))
      : globalLimit;
    const count = counts.get(source) || 0;
    // A vaga reservada ESTOURA o teto, mas continua contando: se ela não
    // contasse, uma reserva de 2 com cota 1 deixaria passar um terceiro stream
    // da mesma fonte — a reserva ampliaria a cota em vez de só furá-la.
    if (exempt.has(stream)) {
      counts.set(source, count + 1);
      return true;
    }
    if (ownLimit && count >= ownLimit) return false;
    counts.set(source, count + 1);
    return true;
  });
}

/**
 * Aplica as duas cotas numa passada só. Se a cota individual rejeitar um item,
 * ele não pode consumir a vaga de qualidade — outra fonte precisa poder fazer
 * o backfill da lista final.
 */
function limitByQualityAndIndexer(
  streams: StreamCandidate[],
  qualityLimits: QualityLimits,
  maxPerIndexer: number,
  exempt: Set<StreamCandidate>,
  indexerLimits: QualityLimits,
  // Vagas reservadas para BR. Elas atravessam a cota do balde de qualidade E
  // não a consomem: "reservada" precisa significar vaga A MAIS, senão vira
  // apenas ordem de chegada dentro do mesmo teto -- que é o que era antes, e
  // fazia `brReservedSlots: 4` render 2 BR quando a cota de 1080p era 2.
  reservedBr: Set<StreamCandidate> = new Set(),
) {
  const qualityCounts = new Map();
  const indexerCounts = new Map();
  const globalLimit = Math.max(0, Math.trunc(Number(maxPerIndexer) || 0));

  return streams.filter((stream) => {
    const quality = streamQuality(stream);
    const rawQualityLimit = qualityLimits[quality];
    const qualityLimit = rawQualityLimit == null || rawQualityLimit >= 100
      ? Infinity
      : Math.max(0, Math.trunc(rawQualityLimit));
    const qualityCount = qualityCounts.get(quality) || 0;
    const reserved = reservedBr.has(stream);
    if (!reserved && qualityCount >= qualityLimit) return false;

    const source = String(stream?._indexer || '').trim().toLowerCase();
    const sourceCount = source ? indexerCounts.get(source) || 0 : 0;
    const sourceLimit = source && Object.prototype.hasOwnProperty.call(indexerLimits, source)
      ? Math.max(0, Math.trunc(Number(indexerLimits[source]) || 0))
      : globalLimit;
    if (source && !exempt.has(stream) && sourceLimit && sourceCount >= sourceLimit) return false;

    // A reservada não entra na conta do balde: as globais mantêm a cota inteira
    // delas e a lista cresce, no máximo, o tamanho da reserva. O teto real
    // continua sendo maxResults, aplicado no fim de limitReservingBr.
    if (!reserved) qualityCounts.set(quality, qualityCount + 1);
    if (source) indexerCounts.set(source, sourceCount + 1);
    return true;
  });
}

/** Aplica as cotas na lista pós-debrid, quando só os streams reais são contados. */
function limitByQuality(streams: StreamCandidate[], qualityLimits: QualityLimits = {}) {
  const counts = new Map();
  return streams.filter((stream) => {
    const quality = streamQuality(stream);
    const rawLimit = qualityLimits[quality];
    const limit = rawLimit == null || rawLimit >= 100 ? Infinity : Math.max(0, Math.trunc(rawLimit));
    const count = counts.get(quality) || 0;
    if (count >= limit) return false;
    counts.set(quality, count + 1);
    return true;
  });
}

interface LimitBrOptions {
  brReservedSlots?: number;
  brReservedPerQuality?: number;
  maxResults?: number;
  brOnly?: boolean;
  qualityLimits?: QualityLimits;
  brFirst?: boolean;
  maxPerIndexer?: number;
  indexerLimits?: QualityLimits;
  /** Temporada pedida: liga a cobertura de pack por faixa (Causa D). */
  season?: number | null;
}

/** Reserva origem BR, aplica as cotas finais e remove todos os campos internos. */
function limitReservingBr(
  streams: Stream[],
  {
    brReservedSlots = 0,
    brReservedPerQuality = 0,
    maxResults = 40,
    brOnly = false,
    qualityLimits = {},
    brFirst = true,
    maxPerIndexer = 0,
    indexerLimits = {},
    season = null,
  }: LimitBrOptions = {},
) {
  const pool = brOnly ? streams.filter((stream) => stream._br) : streams;

  // As cotas por qualidade contam as fontes BR ANTES das globais. Elas publicam
  // seeders=1, então chegam aqui no fim do próprio balde; com cota apertada
  // (max1080p=3) as três globais mais semeadas levavam as vagas e a fonte BR
  // era cortada AQUI — antes de `brFirst`/`brReservedSlots` terem chance de
  // agir. `selectQualityCandidates` já faz essa passada BR no pool pré-debrid;
  // sem o mesmo cuidado no corte final, a reserva não valia nada.
  const reserved = brFirst ? Infinity : Math.max(0, Math.trunc(Number(brReservedSlots) || 0));
  const priority = pool
    .filter((stream) => stream._br)
    .sort((a, b) => (b._dubbed ? 1 : 0) - (a._dubbed ? 1 : 0))
    .slice(0, reserved);
  const prioritized = new Set(priority);
  // A reserva é o TAMANHO DE brReservedSlots, não todo o pool BR: com brFirst
  // (default) `priority` é o BR inteiro, e isentá-lo por completo deixaria o
  // indexador BR sem teto nenhum — o oposto do que a cota faz. Mesmo critério
  // da reserva mais abaixo (`brStreams.slice`): `_br` puro. O pool dublado exige
  // infoHash, que um stream já resolvido no debrid não tem — usá-lo aqui
  // esvaziaria a isenção justamente na lista com play instantâneo.
  //
  // As MESMAS N streams atravessam os DOIS tetos: o por indexador e o por
  // qualidade. Enquanto só o primeiro existia, a página prometia "vagas
  // garantidas" e o balde de qualidade cortava em silêncio -- medido em Fallout
  // S02E04, com quatro BR dubladas disponíveis, cota 1080p em 2 e reserva em 4:
  // saíam 2. O teto real continua sendo maxResults, no fim desta função.
  const brSlots = Math.max(0, Math.trunc(Number(brReservedSlots) || 0));
  const reservedBr = new Set(
    pool
      .filter((stream) => stream._br)
      .sort((a, b) => (b._dubbed ? 1 : 0) - (a._dubbed ? 1 : 0))
      .slice(0, brSlots),
  );
  const kept = new Set(
    limitByQualityAndIndexer(
      [...priority, ...pool.filter((stream) => !prioritized.has(stream))],
      qualityLimits,
      maxPerIndexer,
      reservedBr,
      indexerLimits,
      reservedBr,
    ),
  );
  // Volta à ordem original: sem `brFirst` o corte final depende dela.
  const eligible = pool.filter((stream) => kept.has(stream));
  const brStreams = eligible
    .filter((stream) => stream._br)
    .sort((a, b) => (b._dubbed ? 1 : 0) - (a._dubbed ? 1 : 0));

  // Reserva por faixa: até `brReservedPerQuality` BR por balde de qualidade,
  // escolhidos dubbed-first. É o seguro contra a abundância de 1080p BR
  // empurrar a única BR 4K/720p para fora — na reserva global e no teto de
  // maxResults. Faixa sem candidato BR simplesmente não ganha vaga fantasma.
  //
  // Cobertura por pack (Causa D): quando a faixa não tem release dublada
  // PRÓPRIA, o pack dublado da temporada pedida preenche a vaga dela — o áudio
  // PT existe de verdade dentro do arquivo e o pickFile extrai o episódio.
  // Usa os mesmos primitivos do poolCovered/brDubbedPool (_br + _dubbed +
  // isSeasonPackRelease), então "cobertura" significa a mesma coisa nos dois
  // caminhos. O pack NÃO desloca dublado próprio: só entra em faixa que ficou
  // devendo, uma vez por faixa descoberta (o mesmo hash nunca ocupa duas
  // vagas), e na prioridade QUALITY_KEYS — 4K antes de 720p.
  const perFaixa = Math.max(0, Math.trunc(Number(brReservedPerQuality) || 0));
  const garantidas: Stream[] = [];
  if (perFaixa > 0) {
    const faixaCounts = new Map<string, number>();
    const comPropria = new Set<string>();
    for (const stream of brStreams) {
      const quality = streamQuality(stream);
      if ((faixaCounts.get(quality) || 0) >= perFaixa) continue;
      // Passada 1: só dublado próprio (não-pack). Packs são adiados para
      // cobrir exatamente as faixas que ficarem sem candidato próprio.
      if (season != null && isSeasonPackRelease(stream, season)) continue;
      comPropria.add(quality);
      faixaCounts.set(quality, (faixaCounts.get(quality) || 0) + 1);
      garantidas.push(stream);
    }
    if (season != null) {
      const usados = new Set(garantidas);
      for (const quality of QUALITY_KEYS) {
        if (comPropria.has(quality)) continue;
        const pack = brStreams.find(
          (stream) =>
            !usados.has(stream) &&
            streamQuality(stream) === quality &&
            isSeasonPackRelease(stream, season),
        );
        if (!pack) continue;
        usados.add(pack);
        comPropria.add(quality);
        garantidas.push(pack);
      }
    }
  }
  const encaixaGarantida = (selected: Stream[]) => {
    const dentro = new Set(selected);
    for (const stream of garantidas) {
      if (dentro.has(stream)) continue;
      if (selected.length < maxResults) {
        selected.push(stream);
        dentro.add(stream);
        continue;
      }
      // Troca o último global da lista: a garantia fura a ordem, não o teto.
      const posGlobal = selected.map((s) => !s._br).lastIndexOf(true);
      if (posGlobal === -1) break;
      dentro.delete(selected[posGlobal]);
      selected[posGlobal] = stream;
      dentro.add(stream);
    }
  };

  let selected: Stream[];

  if (brFirst) {
    selected = [...brStreams, ...eligible.filter((stream) => !stream._br)].slice(0, maxResults);
    if (garantidas.length) encaixaGarantida(selected);
  } else {
    // Sem prioridade visual, as vagas continuam garantidas: entram no lugar
    // dos últimos globais e preservam sua posição natural na ordem original.
    // As garantias por faixa vêm ANTES do resto da reserva, senão a abundância
    // de uma faixa consumia as vagas e elas não valiam nada.
    const garantidasSet = new Set(garantidas);
    const reserved = [...garantidas, ...brStreams.filter((stream) => !garantidasSet.has(stream))]
      .slice(0, Math.max(brReservedSlots, garantidas.length));
    const chosen = new Set(eligible.slice(0, maxResults));
    for (const stream of reserved) {
      if (chosen.has(stream)) continue;
      const replace = [...chosen].reverse().find((item) => !item._br);
      if (replace) chosen.delete(replace);
      if (chosen.size < maxResults) chosen.add(stream);
    }
    selected = eligible.filter((stream) => chosen.has(stream)).slice(0, maxResults);
    if (garantidas.length) encaixaGarantida(selected);
  }

  return selected
    .map(({ _br, _seeders, _quality, _size, _dubbed, _indexer, _tracker, _multiWork, _lied, ...stream }) => stream);
}

export {
  QUALITY_KEYS,
  streamQuality,
  selectQualityCandidates,
  limitByIndexer,
  limitByQualityAndIndexer,
  limitByQuality,
  limitReservingBr,
};
