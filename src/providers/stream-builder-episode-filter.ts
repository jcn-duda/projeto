import type { RawItem } from '../../types/domain.js';
import { extractInfoHash } from '../utils/format.js';
import { magnetDisplayName } from '../utils/title-normalization.js';
import { bankRowsForMediaSource } from '../utils/release-index-media.js';
import { firstSeenMany } from '../utils/magnet-bank-query.js';
import { rustFilterSeriesEpisode } from '../utils/rust-episode-filter.js';
import config from '../config.js';

const hashOfRaw = (r: RawItem): string =>
  String(extractInfoHash(r.infoHash || r.magnet || '') || '').toLowerCase();

/**
 * Item sem marcador de série (título e `dn`) que ABRE com artigo ausente de
 * todos os nomes da obra nomeia outra obra: From é "Origem" no Brasil, e "A
 * Origem 4k 2160p Dual Audio" pronto na conta (é Inception) saía com ⚡ no
 * S01E02 (2026-09-30) — conta e BR pulam a guarda de precisão, e o artigo é
 * descartado na comparação de nome. "O Urso" (The Bear) passa: o nome pt tem o
 * artigo. Com marcador de série, o marcador decide e isto se cala.
 * (Portado para `adom_core::series_episode_filter::foreign_article`.)
 */

// Antes disto a data do indexer é lixo (epoch, ano zero), não evidência.
const SANE_DATE_MS = Date.parse('2000-01-01T00:00:00Z');

/**
 * Hashes que já existiam bem antes da estreia do episódio: torrent é imutável,
 * então o pack não o contém e a release que o nomeia é falsa. Medido em
 * Lanterns S01E08 (2026-10-04, estreia 05/10): sem a conta AllDebrid (que
 * mostra o `.exe`), RAWR/CAKES do LimeTorrents e MeGusta/CAKES do acervo
 * passavam — publicados de 2 a 6 dias antes — e o pack velho da conta voltava
 * com ⚡ dentro das 24h da trava pelo relógio. A data é a mais antiga entre o
 * `PublishDate` do Jackett e o `first_seen` do acervo (este nunca é anterior
 * ao real). BR fica de fora: o post do site é datado pela página da temporada,
 * não pelo episódio. Na conta só vale o `first_seen`: o item dela não traz
 * data de publicação, mas o hash é o mesmo torrent que o acervo já viu.
 */
function preAirReleases(raw: RawItem[], airAt: number): Set<string> {
  const margin = config.search.preAirReleaseMarginMs;
  const out = new Set<string>();
  if (!(margin > 0) || !Number.isFinite(airAt)) return out;
  const limit = airAt - margin;
  const candidates = raw.filter((r) => r && !r.isBr && hashOfRaw(r));
  if (!candidates.length) return out;
  const seen = firstSeenMany(candidates.map(hashOfRaw));
  for (const r of candidates) {
    const hash = hashOfRaw(r);
    const published = r.fromAccount ? NaN : Number(r.publishedAt);
    const dates = [published, seen.get(hash) ?? NaN].filter((d) => Number.isFinite(d) && d > SANE_DATE_MS);
    if (dates.length && Math.min(...dates) < limit) out.add(hash);
  }
  return out;
}

/**
 * Corta episódio/temporada errados. Índice entrega só hash (sem URI): sem dn=
 * o corte era fail-open e o pack Apache "4ª Temporada" com magnet S04E03
 * passava em S4E1. Enriquece em lote a partir do banco vivo — clone local.
 */
export function filterSeriesEpisodeRaw(
  items: RawItem[],
  season: number,
  episode: number,
  seriesUniverse: string[],
  { airDate = null, now = Date.now(), names = [] }: { airDate?: string | null; now?: number; names?: string[] } = {},
): { kept: RawItem[]; dropped: RawItem[] } {
  let raw = items;
  // Episódio que ainda não foi ao ar: pack da temporada ou série completa
  // publicado ANTES dele não pode contê-lo. Medido em Lanterns S01E08
  // (2026-09-30, estreia 05/10): o pack "Lanterns.S01.2160p" pronto na conta
  // entrava com ⚡ e o play morria no EpisodePickError. Só fica a release que
  // NOMEIA o episódio (vazamento existe). A margem (SEARCH_UNAIRED_MARGIN_MS,
  // 24h) cobre fuso e a estreia no streaming antes da TV.
  const airAt = Date.parse(String(airDate || ''));
  const margin = config.search.unairedMarginMs;
  const unaired = margin > 0 && Number.isFinite(airAt) && airAt - now > margin;
  const needBank = raw.flatMap((r) => {
    if (magnetDisplayName(r)) return [];
    const hash = String(extractInfoHash(r.infoHash || r.magnet || '') || '').toLowerCase();
    return hash ? [{ item: r, hash }] : [];
  });
  const preAir = preAirReleases(raw, airAt);
  const bankByHash = bankRowsForMediaSource(needBank);
  if (bankByHash.size) {
    raw = raw.map((r) => {
      if (magnetDisplayName(r)) return r;
      const hash = String(extractInfoHash(r.infoHash || r.magnet || '') || '').toLowerCase();
      const uri = hash ? bankByHash.get(hash)?.uri : null;
      return uri ? { ...r, magnet: uri } : r;
    });
  }
  // Laço de decisão por item, em lote no núcleo (uma chamada por busca):
  // matchesEpisode → magnetSeasonContradicts → unaired → artigo estrangeiro
  // (conta/BR) → matchesGlobalSeriesNoMarker. Só índices voltam; os rótulos
  // de motivo ficam em `outcome.labels` se algum caminho precisar deles.
  const outcome = rustFilterSeriesEpisode(
    raw,
    season,
    episode,
    seriesUniverse,
    names,
    unaired,
    [...preAir],
  );
  return {
    kept: outcome.kept.map((i) => raw[i]),
    dropped: outcome.rejected.map(({ index }) => raw[index]),
  };
}
