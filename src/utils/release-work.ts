// Roteamento de OBRA de uma release: em QUAL busca ela deve ser recuperável.
// Módulo puro (sem engine/cache) extraído do `destinoDe` do release-index para
// que o banco de magnets vivo grave a MESMA cobertura que o índice roteia.
//
// Por que existe: a captura do Jackett grava `magnet_work` para a obra da
// BUSCA (season/episode do contexto). Um pack de temporada encontrado na busca
// de um episódio precisa ficar recuperável para QUALQUER episódio daquela
// temporada — senão o fallback da Etapa 4 só acharia o pack se a busca repetisse
// exatamente o episódio original. Aqui a release vira uma LISTA de obras:
// a do pedido (nunca se perde) + a que o TÍTULO declara, quando é pack/coleção.
//
// Espelha `releaseIndex.destinoDe` de propósito (mesma régua): pack de uma
// temporada → (S,-1); série inteira/faixa → (-1,-1). Episódio solto fica só na
// obra do pedido — o fallback não precisa de work por episódio: a release foi
// encontrada para aquele episódio e é ele que a busca repete.
//
// O `dn=` do magnet vence o título quando é MAIS ESPECÍFICO (episódio único >
// pack temporada > série/faixa > nada): post BR titula "4ª Temporada" e o
// magnet carrega `…S04E03…` — o índice roteia para E03, e o banco não inventa
// cobertura de pack de temporada a partir do título genérico.
import { parseTitleSeasonEpisode } from './episode-matching.js';

export type WorkTarget = { season: number | null; episode: number | null };

type EpisodeParse = ReturnType<typeof parseTitleSeasonEpisode>;

/** Especifidade: episódio único (S+E) > pack temporada > série/faixa > nada. */
export function episodeParseSpecificity(p: EpisodeParse): number {
  if (p.complete || p.seasons.length > 1) return 1;
  if (p.seasons.length === 0) return 0;
  if (p.episodes.length === 1) return 3;
  return 2;
}

/** dn só substitui o título quando declara com mais precisão. */
export function chooseEpisodeParse(title: string, dn?: string): EpisodeParse {
  const fromTitle = parseTitleSeasonEpisode(String(title || ''));
  if (!dn) return fromTitle;
  const fromDn = parseTitleSeasonEpisode(String(dn));
  return episodeParseSpecificity(fromDn) > episodeParseSpecificity(fromTitle) ? fromDn : fromTitle;
}

/**
 * Onde a release PERTENCE (uma chave), pelo título/dn — mesma régua do
 * `destinoDe` do índice. Filme (pedido sem temporada) devolve o pedido.
 */
export function routeWorkLocation(request: WorkTarget, title: string, dn?: string): WorkTarget {
  if (request?.season == null) {
    return { season: request?.season ?? null, episode: request?.episode ?? null };
  }
  const parsed = chooseEpisodeParse(title, dn);
  if (parsed.complete || parsed.seasons.length > 1) return { season: null, episode: null };
  if (parsed.seasons.length === 0) {
    return { season: request.season ?? null, episode: request.episode ?? null };
  }
  const season = parsed.seasons[0];
  if (parsed.episodes.length === 1) return { season, episode: parsed.episodes[0] };
  return { season, episode: null };
}

/**
 * Obras em que a release deve ser recuperável. Sempre inclui o pedido; para
 * pack de temporada/série completa acrescenta a obra declarada quando ela
 * difere do pedido. Filme (pedido sem temporada) devolve só o pedido.
 * `dn` opcional: mesma regra de especifidade do índice.
 */
export function releaseWorkTargets(title: string, request: WorkTarget, dn?: string): WorkTarget[] {
  const out: WorkTarget[] = [{ season: request?.season ?? null, episode: request?.episode ?? null }];
  if (request?.season == null) return out;
  const parsed = chooseEpisodeParse(title, dn);
  let declared: WorkTarget | null = null;
  // Mesma regra do `destinoDe`: série inteira/faixa cobre qualquer episódio;
  // uma temporada com pack/mais de um episódio é chave da temporada.
  // Episódio único (mesmo via dn) NÃO acrescenta obra extra — o banco vivo
  // mantém só o pedido; o índice é quem roteia o episódio declarado.
  if (parsed.complete || parsed.seasons.length > 1) declared = { season: null, episode: null };
  else if (parsed.seasons.length === 1 && parsed.episodes.length !== 1) {
    declared = { season: parsed.seasons[0], episode: null };
  }
  if (!declared) return out;
  const same = out.some((t) => t.season === declared!.season && t.episode === declared!.episode);
  if (!same) out.push(declared);
  return out;
}
