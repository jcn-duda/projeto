import type { Stream } from '../../types/domain.js';
import type { QueueCandidate } from './autofetch.js';
import { isSeasonPackFillEligible } from '../utils/format.js';
import { seedsDownloadBytes } from './autofetch-policy.js';

// Fila persistente do Chupim: a SELEÇÃO do excedente e dos pools inferiores
// (br → any → seeds) é do Rust (`rust-autofetch.ts`); aqui fica só a forma do
// candidato persistido. O `drainNext` sobe o fallback somente no colapso
// COMPROVADO do primário (dead/stalled); quando o lote assenta, o
// `runRecheck` descarta a fila inteira e o fallback nunca baixa.

export type AutoFetchStream = Stream & { infoHash: string };

function hashOf(stream: AutoFetchStream) {
  return String(stream.infoHash).toLowerCase();
}

/** Candidato persistido da fila, com o POOL REAL — o dreno lê `next.pool`. */
export function toQueueCandidate(
  stream: AutoFetchStream,
  pool: string,
  { imdbId, season, episode, seasonFill, rare, slotLimit }:
  { imdbId?: string; season?: number | null; episode?: number | null; seasonFill: boolean; rare?: boolean; slotLimit?: number },
): QueueCandidate {
  // Pack de temporada: a identidade do teto por obra é a TEMPORADA, então o
  // episódio persistido vira nulo — dois packs da mesma temporada (E01/E02)
  // não podem ocupar vagas diferentes.
  const isPack = Boolean(seasonFill && isSeasonPackFillEligible(stream, season ?? null));
  return {
    // Identidade da SONDA separada da identidade do teto por obra: o pack tem
    // `episode` nulo para cap, mas a sonda é do EPISÓDIO solicitado — o dreno
    // precisa deferir o pack enquanto a sonda DAQUELE episódio está pendente.
    probeSeason: season ?? null,
    probeEpisode: episode ?? null,
    infoHash: hashOf(stream),
    name: stream.name,
    title: stream.title,
    quality: stream._quality,
    size: seedsDownloadBytes(stream) || undefined,
    seeders: stream._seeders,
    br: stream._br,
    dubbed: stream._dubbed,
    // A marca do banco atravessa a fila: o dreno é quem chama o protectBr no
    // AllDebrid, e sem ela o pack do acervo drenado nasceria sem retenção.
    ...(stream._bankDub ? { bankDub: true as const } : {}),
    lied: stream._lied,
    pool,
    imdbId,
    season,
    // O episódio viaja junto para o dreno reconstruir a MESMA identidade do
    // teto por obra (Fase 2) — sem ele o candidato de série cairia num balde
    // de temporada e não compartilharia a vaga com a busca que o enfileirou.
    episode: isPack ? null : (episode ?? null),
    isPack,
    ...(rare ? { rare: true } : {}),
    ...(slotLimit != null ? { slotLimit } : {}),
  };
}
