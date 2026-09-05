import autofetchLive from '../utils/autofetch-live.js';
import {
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  extractInfoHash,
  qualityFromTitle,
  audioFromTitle,
  explicitPtAudio,
} from '../utils/format.js';
import * as metrics from '../utils/metrics.js';
import { nomeiaEpisodio } from './debrid-pipeline.js';

/**
 * Normaliza releases (tanto do índice quanto itens crus/debrid) e verifica se
 * cobrem os requisitos de pool.
 *
 * Se requireDubbed for true:
 *   - BR dublado -> global dublado.
 * Se requireDubbed for false:
 *   - BR dublado -> global dublado -> melhor swarm saudável (pickTopSeededCandidates).
 */
export function poolCovered(
  items: any[],
  { season, requireDubbed = false }: { season?: number | null; requireDubbed?: boolean } = {},
) {
  if (!Array.isArray(items) || items.length === 0) return false;
  const pseudo = items.map((r) => {
    const title = String(r.title || r.Title || r.name || '').trim();
    const isBr = Boolean(r.isBr);
    const dubbed = r.dubbed !== undefined
      ? Boolean(r.dubbed)
      : isBr
        ? ['Dublado', 'Dual', 'Nacional'].includes(String(audioFromTitle(title)))
        : explicitPtAudio(title);
    const quality = r.quality || qualityFromTitle(title);
    const seeders = Number(r.seeders ?? r.Seeders ?? r._seeders ?? 0) || 0;
    const hash = String(r.hash || extractInfoHash(r.infoHash || r.magnet || '') || '').toLowerCase();

    return {
      title,
      name: title,
      infoHash: hash,
      _seeders: seeders,
      _quality: quality,
      _br: isBr,
      // O degrau "dublado global" do pool lê este flag: sem ele anyDubbedPool
      // devolveria vazio SEMPRE e o degrau seria código morto.
      _dubbed: dubbed,
      season: r.season,
      episode: r.episode,
    };
  });

  if (pickBrDubbedCandidates(pseudo as any, new Set(), 1).length > 0) return true;
  if (pickAnyDubbedCandidates(pseudo as any, new Set(), 1).length > 0) return true;
  if (requireDubbed) return false;
  return pickTopSeededCandidates(pseudo as any, new Set(), 1, {
    minSeeders: autofetchLive.effective().autoFetchMinSeeders,
  }).length > 0;
}

/**
 * "Índice cobre" NUNCA é contagem pura. Uma temporada indexada só com
 * legendado não pode impedir a busca BR dublada de rodar — então o critério é
 * a MESMA noção de pool que o autofetch já usa: BR dublado → global dublado →
 * melhor swarm saudável. Qualquer um desses pools com candidato serve.
 *
 * E, em busca de EPISÓDIO, pack de temporada não decide sozinho. O caso
 * medido: "True Detective 2ª Temporada [1080p DUBLADO 22.41 GB]" sustentava a
 * cobertura de S02E01, a busca era servida do índice, e o dublado DO EPISÓDIO
 * que a coleta ao vivo traria nunca aparecia — o pack promete a temporada, não
 * a faixa de áudio daquele episódio, e quem descobre a diferença é o usuário
 * no play. Mesmo princípio do `isSeasonPackFillEligible`: pack só vale como
 * promessa quando prova o que promete.
 *
 * O pack continua ENTRANDO na lista (ele é fonte tocável de verdade); ele só
 * não decide mais que o Jackett pode ficar de fora.
 */
export function idxPoolCovered(
  releases: any[],
  { season = null, episode = null }: { season?: number | null; episode?: number | null } = {},
) {
  if (season != null && episode != null) {
    const nomeados = releases.filter((r) => nomeiaEpisodio(r?.title, season, episode));
    if (nomeados.length === 0) {
      metrics.count('search.idx.packOnly');
      return false;
    }
  }
  return poolCovered(releases, { season, requireDubbed: false });
}

/** Release do índice → item cru no formato que o buildStreams já consome. */
export function idxReleasesToRaw(releases: any[]) {
  return releases.map((r) => ({
    title: r.title,
    infoHash: r.hash,
    seeders: r.seeders,
    size: r.size ?? undefined,
    indexer: r.indexer,
    tracker: r.indexer,
    isBr: r.isBr,
    dubbed: r.dubbed,
    lied: Boolean(r.lied),
  }));
}
