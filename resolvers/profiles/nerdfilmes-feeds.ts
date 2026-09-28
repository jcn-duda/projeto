// Apresentação do perfil NerdFilmes: o que o site PUBLICA para o cardigann e
// para o torznab. Extraído de `nerdfilmes.ts` pela catraca de 400 linhas — as
// três fábricas de `release-format.ts` (`createReleaseTitle`,
// `createSearchPageHtml`, `createRssXml`) são montadas aqui com as particularidades
// do nerd, e o profile só as recebe prontas. Nada aqui faz rede nem conhece
// protetor: é o único pedaço do perfil que é PURO, e por isso virou módulo.
//
// O que é particularidade DESTE site (o resto é o default das fábricas):
//   - `releaseTitle` usa o `cleanPostTitle` do próprio profile (a variante
//     curta) e os defaults de tag: qualidade, `source`, áudio DUBLADO/LEGENDADO
//     e tamanho. A página de TEMPORADA entra por aqui: o botão traz `Ep 01` e o
//     título da release sai com `E01` — é de onde vem a evidência de que o site
//     publica por episódio.
//   - `searchPageHtml` põe a DATA do post entre size e description (rowExtras) e
//     escapa com `escapeXml` (mesmo algoritmo do escapeHtml do tema).
//   - `pubDate` sem data explícita cai no ANO do título do post, e não na data
//     de hoje: um feed com pubDate de leitura mente sobre a idade da release.
//   - `rssXml` é multilinha e SEM `<enclosure>` (defaults da fábrica).
import { escapeXml } from '../text.js';
import { capsXml as sharedCapsXml } from '../torznab.js';
import {
  createReleaseTitle, createSearchPageHtml, createRssXml,
} from '../release-format.js';

const CHANNEL_TITLE = 'NerdFilmesTorrent / XNerdFilmes';

export interface NerdfilmesFeedsOptions {
  /** URL base do próprio resolver (usada em `/resolve` e `/dl` do card). */
  selfUrl: string;
  /** Limpeza do título do post: a variante curta que o profile injeta. */
  cleanPostTitle: (title: string | null | undefined) => string;
}

export function createNerdfilmesFeeds({ selfUrl, cleanPostTitle }: NerdfilmesFeedsOptions) {
  const releaseTitle = createReleaseTitle({ cleanTitle: cleanPostTitle });

  // Página compacta com a data do post entre size e description (rowExtras);
  // o nerd escreve a página com escapeXml (mesmo algoritmo do escapeHtml hoje).
  const searchPageHtml = createSearchPageHtml({
    selfUrl,
    escape: escapeXml,
    releaseTitle,
    rowExtras: (post) => (post.date ? `<div class="date">${escapeXml(post.date)}</div>` : ''),
  });

  function pubDate(post: { date?: string | null; title?: string | null }): string {
    const explicit = new Date(post.date || '');
    if (!Number.isNaN(explicit.getTime())) return explicit.toUTCString();
    const year = String(post.title || '').match(/\b((?:19|20)\d{2})\b/)?.[1];
    return new Date(Date.UTC(Number(year || 2000), 0, 1)).toUTCString();
  }

  function capsXml(): string {
    return sharedCapsXml(CHANNEL_TITLE);
  }

  // Feed multilinha sem description nem <enclosure> — defaults da factory comum.
  const rssXml = createRssXml({
    selfUrl,
    channelTitle: CHANNEL_TITLE,
    titleOf: ({ post, link }) => releaseTitle(post.title, link),
    pubDateOf: ({ post }) => pubDate(post),
  });

  return { releaseTitle, searchPageHtml, pubDate, capsXml, rssXml };
}
