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
import { parseTitleSeasonEpisode } from './episode-matching.js';

export type WorkTarget = { season: number | null; episode: number | null };

/**
 * Obras em que a release deve ser recuperável. Sempre inclui o pedido; para
 * pack de temporada/série completa acrescenta a obra declarada quando ela
 * difere do pedido. Filme (pedido sem temporada) devolve só o pedido.
 */
export function releaseWorkTargets(title: string, request: WorkTarget): WorkTarget[] {
  const out: WorkTarget[] = [{ season: request?.season ?? null, episode: request?.episode ?? null }];
  if (request?.season == null) return out;
  const parsed = parseTitleSeasonEpisode(String(title || ''));
  let declared: WorkTarget | null = null;
  // Mesma regra do `destinoDe`: série inteira/faixa cobre qualquer episódio;
  // uma temporada com pack/mais de um episódio é chave da temporada.
  if (parsed.complete || parsed.seasons.length > 1) declared = { season: null, episode: null };
  else if (parsed.seasons.length === 1 && parsed.episodes.length !== 1) {
    declared = { season: parsed.seasons[0], episode: null };
  }
  if (!declared) return out;
  const same = out.some((t) => t.season === declared!.season && t.episode === declared!.episode);
  if (!same) out.push(declared);
  return out;
}
