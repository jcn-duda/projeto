'use strict';

// Formatação de release dos cinco perfis de resolver (PLANO_MELHORIAS §5.8,
// item 9, passo 4): limpeza do título do post, título da release, página HTML
// sintética do cardigann, feed torznab, normalizeQuery e o laço de fallback do
// resolve. Tudo factory ou função pura; as diferenças vivas entre os sites
// entram como PARÂMETRO, nunca como "conserto":
//   R-4 — o vaca re-injeta ano/temporada e tem audioTag DUAL; o bludv tira o
//   tamanho da tag (o card dele publica <div class="size">) e remove a fonte
//   do título limpo; o tdf é o único com <enclosure>; o nerd é o único com
//   normalizeQuery SEM fronteiras \b (variante histórica do handleApi).
//   R-7 — regex de caminho quente nasce no closure da factory, fora do laço:
//   o challenger-m2 tem orçamento de 100-200ms por vetor.
//
// Classificadores de qualidade/fonte, hooks de áudio, episódio/pack e a
// máquina de estados da âncora vivem no release-rules.js (irmão, sem ciclo).

const { buttonId } = require('./matching');
const { decodeEntities, parseSize, escapeXml } = require('./text');

// Tamanho desconhecido ("1 KB"): satisfaz o Jackett (que descarta release sem
// tamanho) e o addon o esconde em vez de exibir um tamanho inventado.
const UNKNOWN_SIZE = '1 KB';

// Limpeza do título do post em 7 passos (bludv/comandotorrents; as variantes
// curtas de nerd/tdf e a do vaca ficam nos perfis). Quem manda são os
// atributos do botão, então a vitrine do site (qualidades, codec, canais de
// áudio, termos de SEO) sai — senão tudo pareceria 4K/Dual Áudio pra quem
// consome.
function cleanPostTitle(title = '') {
  let clean = decodeEntities(String(title || ''));
  // 1. "Torrent(s)" e separador adjacente.  2. Resoluções.
  clean = clean.replace(/\s*Torrent(?:s)?\s*(?:[–\-—/|:&+]|&#8211;)?\s*/gi, ' ');
  clean = clean.replace(/\b(?:2160p|1080p|720p|576p|480p|\d{3,4}p|4K|8K|UHD|ULTRA\s*HD|FULL\s*HD|\bHD\b(?!\s*TV)|\bSD\b)\b/gi, ' ');
  // 3. Codecs de vídeo e fontes.  4. Canais de áudio (5.1, Atmos, ...).
  clean = clean.replace(/\b(?:BDREMUX|REMUX|BLU[- ]?RAY|BLURAY|BDRIP|BRRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM|IMAX|3D|REMASTERED|REMASTER|HDR(?:10\+?)?|DOLBY\s*VISION|DV)\b/gi, ' ');
  clean = clean.replace(/\b(?:5\.1|7\.1|2\.0|7\.2|DDP\s*5\.1|ATMOS)\b/gi, ' ');
  // 5. Tags de áudio e idioma.  6. Termos de vitrine / SEO.
  clean = clean.replace(/\b(?:Dublado|Dublada|Legendado|Legendada|Dual\s*[AÁ]udio|Nacional|Multi\s*[AÁ]udio|Tri\s*[AÁ]udio|[AÁ]udio\s*Original)\b/gi, ' ');
  clean = clean.replace(/\b(?:Download|Baixar|Gr[áa]tis|Online|Completo|Completa|Assistir)\b/gi, ' ');
  // 7. Separadores órfãos / múltiplos e aparas nas bordas.
  clean = clean.replace(/\s*[/|–\-—:&+]\s*([/|–\-—:&+]\s*)+/g, ' ');
  clean = clean.replace(/^[–\-—/|:&+\s]+/g, '');
  clean = clean.replace(/[–\-—/|:&+\s]+$/g, '');
  return clean.replace(/\s+/g, ' ').trim();
}

const DEFAULT_RELEASE_TITLE_OF = (input) => (typeof input === 'string' ? input : input?.title || '');
const DEFAULT_AUDIO_TAG_OF = (link) =>
  link?.audio === 'dublado' ? 'DUBLADO' : link?.audio === 'legendado' ? 'LEGENDADO' : null;

/**
 * Título da release: o título do post limpo + os atributos do botão na tag.
 * `stripSource` (bludv/comando) remove a fonte do título limpo pra não
 * duplicar; `withSize: false` (bludv) tira o tamanho da tag; os hooks
 * seasonOf/yearOf/episodeOf e o audioTagOf com DUAL são do vacatorrent (o
 * batch usa o título real e re-injeta o ano).
 */
function createReleaseTitle(cfg) {
  const {
    cleanTitle, titleOf = DEFAULT_RELEASE_TITLE_OF, audioTagOf = DEFAULT_AUDIO_TAG_OF,
    withSize = true, stripSource = false, seasonOf = null, yearOf = null, episodeOf = null,
  } = cfg;

  return function releaseTitle(post, link, index = null) {
    let clean = cleanTitle(titleOf(post, link));
    const epPart = episodeOf
      ? episodeOf(post, link)
      : link?.episode != null ? `E${String(link.episode).padStart(2, '0')}` : '';
    const audioTag = audioTagOf(link);
    const tags = [
      link?.quality ? `${link.quality}p` : null,
      link?.source,
      audioTag,
      withSize ? (link?.size || (index == null ? null : `opção ${index + 1}`)) : null,
    ].filter(Boolean);

    if (stripSource && link?.source) {
      const sourceEscaped = link.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-. ]?');
      clean = clean
        .replace(new RegExp(`\\b${sourceEscaped}\\b`, 'gi'), '')
        .replace(/[–\-—/|:&+\s]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const sePart = `${seasonOf ? seasonOf(post, link) : ''}${epPart}`;
    const base = `${clean}${yearOf ? yearOf(post, link) : ''}${sePart ? ` ${sePart}` : ''}`;
    return tags.length ? `${base} [${tags.join(' ')}]` : base;
  };
}

/**
 * Página HTML sintética consumida pelo card Cardigann do Jackett: cada BOTÃO
 * do post vira uma linha própria (qualidade/áudio/tamanho reais) e o href do
 * download já carrega o índice exato do botão, resolvido por /resolve?i= no
 * ato. Layout compacto (comando/vaca/nerd/tdf); o card multilinha do bludv é
 * próprio do perfil. `rowExtras` injeta poster/date entre size e description.
 */
function createSearchPageHtml(cfg) {
  const {
    selfUrl, escape, releaseTitle, rowExtras = () => '', descriptionOf = (post) => post.title,
  } = cfg;

  return function searchPageHtml(items) {
    const rows = items.map(({ post, link, index, count }) => {
      const download = `${selfUrl}/resolve?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
      return `<div class="release"><div class="title"><a href="${escape(download)}">${escape(releaseTitle(post, link, index))}</a></div><div class="size">${escape(link.size || UNKNOWN_SIZE)}</div>${rowExtras(post)}<div class="description">${escape(descriptionOf(post))}</div><div class="seeders">1</div></div>`;
    }).join('');
    return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
  };
}

/**
 * Feed torznab. Formato multilinha (bludv/nerd) ou compacto (tdf); extras por
 * perfil: description com o título do post e comentário dos seeds (bludv),
 * <enclosure> (tdf). Seeders "1" é neutro: nenhum dos sites publica seeds e 0
 * descartaria a release nos filtros.
 */
function createRssXml(cfg) {
  const {
    selfUrl, channelTitle, titleOf, pubDateOf,
    withDescription = false, seedersComment = null, withEnclosure = false, compact = false,
  } = cfg;

  return function rssXml(items, category) {
    const body = items.map(({ post, link, index, count }) => {
      const dl = `${selfUrl}/dl?url=${encodeURIComponent(post.url)}&i=${index}&h=${buttonId(link)}&n=${count}`;
      const size = parseSize(link.size) || 0;
      const fields = [
        `<title>${escapeXml(titleOf({ post, link }))}</title>`,
        `<guid isPermaLink="false">${escapeXml(dl)}</guid>`,
        `<link>${escapeXml(dl)}</link>`,
        `<comments>${escapeXml(post.url)}</comments>`,
        `<pubDate>${pubDateOf({ post })}</pubDate>`,
        `<size>${size}</size>`,
        withDescription ? `<description>${escapeXml(post.title)}</description>` : null,
        `<category>${category}</category>`,
        withEnclosure ? `<enclosure url="${escapeXml(dl)}" type="application/x-bittorrent" length="${size}"/>` : null,
        `<torznab:attr name="category" value="${category}"/>`,
        `<torznab:attr name="size" value="${size}"/>`,
        seedersComment,
        `<torznab:attr name="seeders" value="1"/>`,
        `<torznab:attr name="peers" value="1"/>`,
        `<torznab:attr name="downloadvolumefactor" value="0"/>`,
        `<torznab:attr name="uploadvolumefactor" value="1"/>`,
      ].filter(Boolean);
      return compact
        ? `<item>${fields.join('')}</item>`
        : ['    <item>', ...fields.map((field) => `      ${field}`), '    </item>'].join('\n');
    }).join(compact ? '' : '\n');

    if (compact) {
      return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>${channelTitle}</title>${body}</channel></rss>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>${channelTitle}</title>
${body}
  </channel>
</rss>`;
  };
}

// O feed usa escapeXml (o escape da PÁGINA HTML é parâmetro do
// createSearchPageHtml porque o nerd escreve a página com escapeXml e os
// demais com escapeHtml — mesmo algoritmo hoje, nomes diferentes por intenção).

/**
 * "Nome S01E01" → "Nome"; o buscador WordPress engasga com ":". As fronteiras
 * \b são obrigatórias: sem elas o strip comia pedaço de título com S+número
 * dentro de palavra ("S1m0ne" virava "m0ne" e a busca zerava). O vacatorrent
 * remove também o ano (o search_posts dele é LIKE sobre o título SEM ano) e o
 * nerdfilmes é o único SEM fronteiras — variante histórica do handleApi dele
 * (R-4: mudar aqui mudaria o resultado da busca).
 */
function createNormalizeQuery({ dropYear = false, boundary = true } = {}) {
  // Nascem no closure da factory: compiladas uma vez por instalação (R-7).
  const seasonRe = boundary
    ? /\bS\d{1,2}(?:E\d{1,2})?\b/gi
    : /[sS]\d{1,2}(?:[eE]\d{1,2})?/g;
  const yearRe = /\b(?:19|20)\d{2}\b/g;

  return function normalizeQuery(value) {
    let query = String(value || '').replace(seasonRe, ' ');
    if (dropYear) query = query.replace(yearRe, ' ');
    return query.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
  };
}

/**
 * Laço de fallback do resolve: tenta os botões em ordem de preferência e só
 * propaga o erro do ÚLTIMO tentado — protetor fora do ar num botão não pode
 * matar o post inteiro quando há alternativa. `emptyError` distingue o post
 * sem botão ('no_protector' em bludv/nerd) da ausência total de candidatos
 * ('no_magnet' nos demais), como nos laços originais.
 */
async function tryLinksInOrder(ordered, fetchOne, hooks = {}) {
  const { onError = null, emptyError = null } = hooks;
  let lastError;
  for (const link of ordered) {
    try {
      return await fetchOne(link);
    } catch (error) {
      // Degradação esperada: protetor morre com frequência. Segue o próximo.
      lastError = error;
      if (onError) onError(link, error);
    }
  }
  // Mesma forma dos laços originais (`throw lastError || new Error(...)`): um
  // erro falsy lançado pelo transporte não derruba o fallback do post inteiro.
  throw lastError || new Error(emptyError || 'no_magnet');
}

// Chave de cache do botão por índice (bludv/comando/nerd); o hash curto do
// href é a identidade estável quando o post mudou entre a busca e o resolve.
// O vacatorrent tem formato próprio (sufixo incondicional) e não usa isto.
function magnetButtonCacheKey(postUrl, index, hash) {
  return hash ? `magnet:${postUrl}:${index}:${hash}` : `magnet:${postUrl}:${index}`;
}

module.exports = {
  UNKNOWN_SIZE,
  cleanPostTitle,
  createReleaseTitle,
  createSearchPageHtml,
  createRssXml,
  createNormalizeQuery,
  tryLinksInOrder,
  magnetButtonCacheKey,
};
