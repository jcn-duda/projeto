// Percurso dos BOTÕES de um post do TorrentDosFilmes, extraído de
// `torrentdosfilmes.ts` pela catraca de 400 linhas — é a mesma divisão que
// `vaca-series.ts` faz com o ramo de série. Nenhuma rede fora do que o
// `fetchFollowingAllowed` do profile faz: este módulo só decide o que fazer com
// cada link que o coletor de botões devolveu.
//
// A diferença que manda neste site (medido 2026-09-28): o magnet vem DIRETO no
// `href` da âncora, sem salto de protetor. O laço do núcleo devolve a URI sem
// gastar rede quando a entrada já é `magnet:`, então `onRequest` só é chamado
// quando existe mesmo um salto — e é por isso que uma página de filme deste
// site custa 1 request, contra "página + 1 por botão" no NerdFilmes.
import type { RawItem } from '../../../types/domain.js';
import type { ResolverLink } from '../../../resolvers/types.js';
import type { ReleaseTitleInput } from '../../../resolvers/release-format.js';
import type { TorrentdosfilmesResolverSurface } from './torrentdosfilmes.js';
import * as log from '../../utils/logger.js';
import { magnetHash } from './shared.js';

/** id do card do Jackett (dedupe, `ji`/`jl`, reserva por indexer falho). */
export const TDF_SITE_ID = 'torrentdosfilmesv2';
/** Rótulo humano (card do painel, `tracker` da release). */
export const TDF_TRACKER_LABEL = 'TorrentDosFilmes';

/**
 * Botão sem torrent a colher — TERMINAL, não retentável: link de protetor
 * expirado ou destino que não é magnet. Os dois nomes vêm do `transport.ts`
 * (HTTP 400 com "Link inválido ou expirado", e a prova de download direto).
 * Demais 4xx/5xx seguem `http_*` e são retentáveis.
 */
function isTerminalButtonError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /protector_(?:link_expired|non_magnet)/i.test(message);
}

/** Botão resolvido → item cru no MESMO formato da busca (RawItem). */
function releaseToRawItem(
  surface: TorrentdosfilmesResolverSurface,
  postTitle: string,
  link: ResolverLink,
  magnet: string,
): RawItem {
  return {
    // `postTitle` é o `<h1>` CRU: quem limpa é o `releaseTitle` do profile, o
    // mesmo que limpa no card vivo. Limpar aqui também criaria uma terceira
    // régua de título, e o título da release é o que o filtro de qualidade e
    // de áudio do addon lê.
    title: surface.releaseTitle(postTitle, link),
    magnet,
    indexer: TDF_SITE_ID,
    tracker: TDF_TRACKER_LABEL,
    // Invariante 2: a origem BR é campo do provider (o tdf é card BR).
    isBr: true,
    // Invariante 3: fonte BR não publica swarm, e 1 é o valor neutro que
    // sobrevive ao MIN_SEEDERS.
    seeders: 1,
    size: surface.parseSize(link.size) ?? undefined,
  };
}

/** Desfecho do percurso dos botões — o que o `fetchWork` precisa para decidir
 *  entre `no-torrent`, erro retentável e `done`. */
export interface ButtonPass {
  releases: RawItem[];
  /** Botões que o transporte resolveu (o outro lado do denominador da sonda). */
  followed: number;
  /** Botões que falharam de forma TERMINAL (o resto é retentável). */
  terminalFails: number;
  otherFails: number;
  lastError: unknown;
}

export interface ButtonPassDeps {
  surface: TorrentdosfilmesResolverSurface;
  /** URL do post (o `referer` de cada salto). */
  workUrl: string;
  /** `<h1>` cru, para o `releaseTitle` do profile. */
  postTitle: string;
  /** Contador de custo por HOP (F3), compartilhado com a página. */
  countRequest: () => void;
  /** Chamado por botão que falhou, para o log do site. */
  onFailure?: (err: unknown) => void;
  /** Cerca do passo: expirado, o percurso para (o motor descarta o resultado). */
  isAborted?: () => boolean;
}

/**
 * Segue UM botão por vez, na ordem da página; falha de um não perde os demais.
 * O MESMO torrent em dois botões é um item só — medido no post real: 3 âncoras
 * e 2 btih, porque o site repete o botão do torrent.
 */
export async function passButton(
  deps: ButtonPassDeps,
  link: ResolverLink,
): Promise<{ magnet: string | null; release: RawItem | null }> {
  const { surface, workUrl, postTitle, countRequest } = deps;
  const finalHtml = await surface.fetchFollowingAllowed(link.url, workUrl, { onRequest: countRequest });
  const magnet = surface.extractMagnet(finalHtml);
  // Cadeia resolveu mas não há magnet: não inventa.
  if (!magnet) return { magnet: null, release: null };
  return { magnet, release: releaseToRawItem(surface, postTitle, link, magnet) };
}

/** Percurso completo dos botões `planned`, com dedupe por hash. */
export async function passButtons(deps: ButtonPassDeps, planned: ResolverLink[]): Promise<ButtonPass> {
  const releases: RawItem[] = [];
  const seen = new Set<string>();
  const out: ButtonPass = { releases, followed: 0, terminalFails: 0, otherFails: 0, lastError: null };
  for (const link of planned) {
    if (deps.isAborted?.()) break;
    try {
      const { magnet, release } = await passButton(deps, link);
      out.followed += 1;
      if (!release || !magnet) continue;
      const hash = magnetHash(magnet);
      if (hash && seen.has(hash)) continue;
      if (hash) seen.add(hash);
      releases.push(release);
    } catch (err) {
      out.lastError = err;
      if (isTerminalButtonError(err)) out.terminalFails += 1;
      else out.otherFails += 1;
      deps.onFailure?.(err);
      log.warn('[crawl] torrentdosfilmesv2: botão falhou:', log.errorMessage(err));
    }
  }
  return out;
}
