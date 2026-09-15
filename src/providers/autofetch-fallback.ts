import type { Stream } from '../../types/domain.js';
import type { QueueCandidate } from './autofetch.js';
import { pickAnyDubbedCandidates, isSeasonPackFillEligible } from '../utils/format.js';
import { pickSeedsPool } from './autofetch-seeds-pool.js';

// Reposição de pools inferiores do Chupim. O pool primário (br → any → seeds)
// continua definindo os disparos IMEDIATOS; os pools abaixo dele não entram na
// conta agora, mas ficam na fila persistente para o `drainNext` subir quando o
// primário colapsar COM EVIDÊNCIA (dead/stalled). Entrar em settle NÃO drena —
// política da Fase 0: sem prova de colapso, nada baixa. Serviços sem sinal de
// `stalled` (AllDebrid) só reportam morto via estado terminal, e a reposição
// deles no settle é a futura F3. O fluxo ready não toca nisso: quando o lote
// assenta, o `runRecheck` descarta a fila inteira e o fallback nunca baixa.

export type AutoFetchStream = Stream & { infoHash: string };

export type FallbackPool = 'any' | 'seeds';
export type FallbackPick = { stream: AutoFetchStream; pool: FallbackPool };
export type QueueEntry = { stream: AutoFetchStream; pool: string };

// Subconjunto de `autofetchLive.effective()` que a seleção de fallback lê.
// Mantém o módulo testável sem depender do objeto inteiro.
export type FallbackLive = {
  autoFetchAnyDubbed: boolean;
  autoFetchTopSeeds: boolean;
  autoFetchMinSeeders: number;
  autoFetchTopSeedsMax: number;
  autoFetchSeedsPtFirst: boolean;
  autoFetchRareMax: number;
  autoFetchRareThreshold: number;
  autoFetchRareMaxSeeders: number;
};

function isAutoFetchStream(stream: Stream): stream is AutoFetchStream {
  return typeof stream.infoHash === 'string' && stream.infoHash.length > 0;
}

function hashOf(stream: AutoFetchStream) {
  return String(stream.infoHash).toLowerCase();
}

/**
 * Fallback dos pools abaixo do primário, na ordem br → any → seeds:
 * - any só existe abaixo do br (e se o toggle `autoFetchAnyDubbed` permitir);
 * - seeds fica abaixo de br e any (e se `autoFetchTopSeeds` permitir);
 * - `excludeHashes` (o que o primário já escolheu) nunca reaparece — dedupe
 *   por hash case-insensitive, que o writeQueue reforça.
 * O pool seeds reusa o mesmo seletor do primário (piso, título raro,
 * complemento relaxado), então o fallback tem a mesma qualidade de escolha.
 */
export function pickLowerPoolFallbacks(
  liveStreams: Stream[],
  live: FallbackLive,
  {
    primaryPool,
    excludeHashes,
    season = null,
    viable,
  }: {
    primaryPool: string;
    excludeHashes: Iterable<string>;
    season?: number | null;
    viable: (s: Stream) => boolean;
  },
): FallbackPick[] {
  // seeds é o piso da cascata: não há pool abaixo para repor.
  if (primaryPool === 'seeds') return [];
  const exclude = new Set(
    [...excludeHashes].map((h) => String(h || '').toLowerCase()).filter(Boolean),
  );
  const out: FallbackPick[] = [];

  if (primaryPool === 'br' && live.autoFetchAnyDubbed) {
    // Pré-filtra por viabilidade ANTES do corte: com `limit=1`, um candidato
    // waived/inviável era o único devolvido e o filtro pós-pick o descartava,
    // escondendo o segundo dublado viável. Filtrar o pool inteiro primeiro
    // deixa o corte escolher o melhor ELEGÍVEL.
    // Pool inferior `any` é GLOBAL dublado. Um BR excedente precisa continuar
    // classificado como `br`, pois esse rótulo decide a proteção durável no
    // AllDebrid quando o candidato for drenado.
    const viableAny = liveStreams.filter((s) => !s._br && viable(s));
    const first = pickAnyDubbedCandidates(viableAny, exclude, 1, { season })[0];
    if (first && isAutoFetchStream(first)) {
      exclude.add(hashOf(first));
      out.push({ stream: first, pool: 'any' });
    }
  }

  if (live.autoFetchTopSeeds) {
    // Tira o que o primário (e o fallback any) já escolheu ANTES do corte: o
    // pool seeds ordena dublado BR à frente via pt-first e consumiria as vagas
    // limitadas, escondendo o swarm real — mesmo defeito do `limit=1` do any.
    const seedsInput = liveStreams.filter((s) => {
      const h = typeof s.infoHash === 'string' ? s.infoHash.toLowerCase() : '';
      return h.length > 0 && !s._br && !exclude.has(h);
    });
    const seeds = pickSeedsPool(
      seedsInput,
      {
        autoFetchMinSeeders: live.autoFetchMinSeeders,
        autoFetchTopSeedsMax: live.autoFetchTopSeedsMax,
        autoFetchSeedsPtFirst: live.autoFetchSeedsPtFirst,
      },
      {
        season,
        queueDepth: 0,
        viable,
        rare: {
          max: live.autoFetchRareMax,
          threshold: live.autoFetchRareThreshold,
          maxSeeders: live.autoFetchRareMaxSeeders,
        },
      },
    );
    for (const s of seeds.candidates) {
      exclude.add(hashOf(s));
      out.push({ stream: s, pool: 'seeds' });
    }
  }

  return out;
}

/**
 * Fila final: excedente do pool primário primeiro, fallbacks só ocupam a folga.
 * O Chupim não pode expulsar uma alternativa BR para reservar inglês; quando o
 * excedente primário preenche a fila, ele próprio é a reposição do lote. A
 * ordem entre pools é preservada e o writeQueue reforça dedupe e profundidade.
 */
export function composeQueueEntries(
  primarySurplus: QueueEntry[],
  fallbacks: FallbackPick[],
  depth: number,
): QueueEntry[] {
  const max = Math.max(0, Math.trunc(Number(depth) || 0));
  if (max === 0) return [];
  return [...primarySurplus, ...fallbacks].slice(0, max);
}

/** Candidato persistido da fila, com o POOL REAL — o dreno lê `next.pool`. */
export function toQueueCandidate(
  stream: AutoFetchStream,
  pool: string,
  { imdbId, season, seasonFill }: { imdbId?: string; season?: number | null; seasonFill: boolean },
): QueueCandidate {
  return {
    infoHash: hashOf(stream),
    name: stream.name,
    title: stream.title,
    quality: stream._quality,
    seeders: stream._seeders,
    br: stream._br,
    dubbed: stream._dubbed,
    lied: stream._lied,
    pool,
    imdbId,
    season,
    episode: null,
    isPack: Boolean(seasonFill && isSeasonPackFillEligible(stream, season ?? null)),
  };
}
