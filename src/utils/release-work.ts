// Roteamento de OBRA de uma release: em QUAL busca ela deve ser recuperável.
// Módulo puro (sem engine/cache) extraído do `destinoDe` do release-index para
// que o banco de magnets vivo grave a MESMA cobertura que o índice roteia.
//
// Por que existe: a captura do Jackett grava `magnet_work` para a obra da
// BUSCA (season/episode do contexto). Um pack de temporada encontrado na busca
// de um episódio precisa ficar recuperável para QUALQUER episódio daquela
// temporada — senão o fallback da Etapa 4 só acharia o pack se a busca repetisse
// exatamente o episódio original. Aqui a release vira uma LISTA de obras:
// a do pedido (quando a release CABE nele) + a que o TÍTULO declara, quando é
// pack/coleção.
//
// "Cabe" é o ponto que já sujou o banco: os indexers BR buscam só o nome da
// série e devolvem TODAS as temporadas. Gravar tudo na obra do pedido deixou
// 217 de 419 releases de OUTRA temporada no True Detective S01E01 (medido em
// 2026-09-24), e o fallback lia e aplicava os tetos sobre elas antes do filtro
// de episódio. Release que declara outra temporada/episódio vai para a obra
// DELA (`routeWorkLocation`), não para a do pedido.
//
// Espelha `releaseIndex.destinoDe` de propósito (mesma régua): pack de uma
// temporada → (S,-1); série inteira/faixa → (-1,-1).
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

/** A release declarada (já escolhida entre título e dn) cobre o pedido? */
function parsedFitsRequest(parsed: EpisodeParse, request: WorkTarget): boolean {
  if (request?.season == null || parsed.complete || parsed.seasons.length === 0) return true;
  if (!parsed.seasons.includes(request.season)) return false;
  if (request.episode == null || parsed.episodes.length === 0) return true;
  return parsed.episodes.includes(request.episode);
}

/**
 * A release pode servir o pedido? Falso só com PROVA de outra obra: título/dn
 * sem temporada, pack da temporada e série completa cabem. Mesma escolha
 * título×dn do roteamento — um post "1ª Temporada" cujo magnet é `S01E01` não
 * serve o E02.
 */
export function releaseFitsRequest(request: WorkTarget, title: string, dn?: string): boolean {
  if (request?.season == null) return true;
  return parsedFitsRequest(chooseEpisodeParse(title, dn), request);
}

/**
 * Obras em que a release deve ser recuperável: o pedido quando ela cabe nele,
 * senão a obra que ela declara; para pack de temporada/série completa
 * acrescenta a obra declarada quando ela difere do pedido. Filme (pedido sem
 * temporada) devolve só o pedido. `dn` opcional: mesma regra de especifidade
 * do índice.
 */
export function releaseWorkTargets(title: string, request: WorkTarget, dn?: string): WorkTarget[] {
  const asked: WorkTarget = { season: request?.season ?? null, episode: request?.episode ?? null };
  if (request?.season == null) return [asked];
  const parsed = chooseEpisodeParse(title, dn);
  const out: WorkTarget[] = [parsedFitsRequest(parsed, request) ? asked : routeWorkLocation(request, title, dn)];
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
