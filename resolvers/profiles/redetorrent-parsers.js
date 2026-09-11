'use strict';

// Rede Torrent (www.redetorrent.xyz) — parsers puros do perfil. O site é um
// WordPress com tema próprio: a busca devolve cards em div.listagem e o post
// publica os magnets DIRETOS no HTML cru, em tabelas tbl-mv-list (uma por
// bloco de áudio: Dual Áudio / Legendado). Quando a página passa pelo
// FlareSolverr, o DOM renderizado troca as âncoras por tokens systemads
// (base64 do magnet) — o parser aceita as duas formas e nunca costura
// /resolve: o magnet é o próprio link da release.

const { decodeEntities, escapeXml, stripTags: stripTagsShared } = require('../text');
const {
  matchesResolverQuery,
  normalizeSeasonValue,
} = require('../matching');
const { createQualityRules, createSourceRules } = require('../release-rules');
const { createReleaseTitle, createNormalizeQuery } = require('../release-format');
// Validação do magnet reusa o helper canônico do bludv-parsers: só vale
// magnet com xt=urn:btih: de hash válido (40 hex) em QUALQUER posição —
// startsWith('magnet:') é fraco demais para HTML de terceiro.
const { isValidMagnetUri } = require('./bludv-parsers');

// Mirrors ativos do site: viram candidato do seletor E allowlist (o
// site-profile aceita o host de qualquer candidato sem restart).
const FALLBACK_SITE_SUFFIXES = ['redetorrent.xyz', 'redetorrent.com'];

// Hosts de protetor que aparecem nos anchors do DOM renderizado (o JS do tema
// reescreve o magnet para systemads). O token é decodificado no parse — nenhum
// fetch toca esses hosts; entram na allowlist por defesa, não por consumo.
const PROTECTOR_SUFFIXES = ['systemads.free.nf', 'systemads1.com', 'temreceita.com'];

const { normalizeQuality } = createQualityRules();
const { normalizeSource } = createSourceRules();

const stripTags = (value = '') => stripTagsShared(value, decodeEntities);

// O buscador WP do site zera com QUALQUER token extra ("Coringa 2019" → 0,
// medido na definição stock): o ano sai junto do SxxEyy.
const normalizeQuery = createNormalizeQuery({ dropYear: true });

function requestedSeasonFromQuery(value) {
  return String(value || '').match(/\b[Ss](\d{1,2})(?:[Ee]\d{1,2})?\b/i);
}

// Áudio pelo conjunto header + células de idioma/legenda. "Legendado" no
// header do bloco vence a legenda ptbr da linha (legenda PT em release
// legendada é o formato do site); sem header, ptbr na linha de idioma é dublado
// ou dual conforme haja outro idioma junto.
function classifyAudio(context) {
  const text = String(context || '').toUpperCase();
  if (/LEGENDAD/.test(text)) return 'legendado';
  const hasPt = /PTBR|PT-BR|PORTUGU[ÊE]S|DUBLAD|DUAL/.test(text);
  if (!hasPt) return null;
  const hasForeign = /\bENG\b|INGL[ÊE]S|ESPANHOL|JAPON[ÊE]S|LATINO|MULTI/.test(text);
  return hasForeign ? 'dual' : 'dublado';
}

// Temporada pedida casa com QUALQUER temporada do título: o post da série
// agrega "1ª 2ª Temporada" e casar só o último ordinal perderia a 1ª. Colete
// TODOS os ordinais (1ª/2ª/1º...) e todos os Sxx soltos.
function matchesSeasonSeason(post, requestedSeason) {
  const wanted = normalizeSeasonValue(requestedSeason);
  if (wanted == null) return true;
  const title = String(post?.title || '');
  const seasons = [];
  for (const m of title.matchAll(/(\d{1,2})\s*[ªº°]/g)) seasons.push(Number(m[1]));
  for (const m of title.matchAll(/\bS(\d{1,2})\b/gi)) seasons.push(Number(m[1]));
  return !seasons.length || seasons.includes(wanted);
}

// Cards da busca: div.listagem > div.item > a[href][title], com ano no título.
// baseUrl resolve href relativo (o site publica absoluto; o parâmetro cobre
// HTML sintético e mudanças futuras do tema). `type` sai do PATH do post:
// /filmes/ → Filme, /series/ → Série.
function parseSearchHtml(html, baseUrl) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const anchorRe = /<div class="item">\s*<a\s+href=["']([^"']+)["']\s+title=["']([^"']*)["']/gi;
  let match;
  while ((match = anchorRe.exec(String(html))) !== null) {
    let resolved;
    try { resolved = new URL(decodeEntities(match[1]), baseUrl || undefined).href; } catch { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const title = decodeEntities(match[2]).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const yearMatch = title.match(/\((\d{4})\)/);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    out.push({ url: resolved, title, year, poster: null, type: workTypeFromPath(resolved) });
  }
  return out;
}

function workTypeFromPath(url) {
  try {
    const path = new URL(url).pathname;
    if (/^\/filmes\//.test(path)) return 'Filme';
    if (/^\/series\//.test(path)) return 'Série';
  } catch {}
  return null;
}

// Token systemads: ?token=<base64> decodifica para o magnet (ou para um
// https de legenda, que não serve e é descartado).
function magnetFromSystemadsToken(href) {
  const raw = String(href || '');
  if (!/systemads/i.test(raw)) return null;
  const token = raw.match(/[?&]token=([^&"']+)/)?.[1];
  if (!token) return null;
  try {
    const decoded = Buffer.from(decodeURIComponent(token), 'base64').toString('utf8').trim();
    return isValidMagnetUri(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

// Âncora do post → magnet validado: magnet direto no href OU token systemads
// decodificado. Tudo que não passa no isValidMagnetUri é descartado.
function extractMagnetHref(href) {
  const value = decodeEntities(String(href || '').trim());
  if (isValidMagnetUri(value)) return value;
  return magnetFromSystemadsToken(value);
}

function magnetParams(magnet) {
  try {
    const url = new URL(magnet);
    return {
      dn: decodeURIComponent(url.searchParams.get('dn') || ''),
      xl: Number(url.searchParams.get('xl') || 0) || null,
    };
  } catch {
    return { dn: '', xl: null };
  }
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(2).replace(/\.?0+$/, '')} ${unit}`;
}

function cellText(row, className) {
  const cell = row.match(new RegExp(`<td class="${className}[^"]*"[^>]*>([\\s\\S]*?)</td>`, 'i'));
  if (!cell) return '';
  return stripTags(cell[1]);
}

function qualityFromText(text) {
  const match = String(text || '').match(/\b(\d{3,4})\s*p\b/i);
  return match ? normalizeQuality(match[0]) : null;
}

// Uma tabela tbl-mv-list por bloco de áudio; cada tr.tr-mv-list é uma release.
// `post` dá o contexto (contrato do perfil): url resolve href relativo — a
// tabela pode carregar âncora de legenda (opensubtitles) ANTES da do magnet,
// então TODAS as âncoras da linha são varridas até uma virar magnet.
function parsePostLinks(html, post) {
  if (!html) return [];
  const baseUrl = typeof post === 'string' ? post : post?.url;
  const links = [];
  const tableRe = /<table class="tbl-mv-list">[\s\S]*?<\/table>/gi;
  let table;
  while ((table = tableRe.exec(String(html))) !== null) {
    // Header do bloco: classes extras do tema ("tfs theme-dark") não podem
    // quebrar o casamento — qualquer class="tf..." serve.
    const headerText = stripTags(table[0].match(/<div class="tf[^"]*">([\s\S]*?)<\/div>/i)?.[1] || '');
    // Regex de linha NASCE por tabela: um /g reaproveitado carrega lastIndex
    // da tabela anterior e silencia a segunda (bug do post com 2+ blocos).
    const rowRe = /<tr class="tr-mv-list">([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(table[0])) !== null) {
      const body = row[1];
      let magnet = null;
      const hrefRe = /<a\s+[^>]*?href\s*=\s*["']([^"']+)["']/gi;
      let hrefMatch;
      while ((hrefMatch = hrefRe.exec(body)) !== null) {
        let href = hrefMatch[1];
        if (baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          try { href = new URL(href, baseUrl).href; } catch {}
        }
        magnet = extractMagnetHref(href);
        if (magnet) break;
      }
      if (!magnet) continue;
      const { dn, xl } = magnetParams(magnet);
      const qua = cellText(body, 'td-mv-qua');
      const res = cellText(body, 'td-mv-res');
      const tam = cellText(body, 'td-mv-tam');
      const idi = cellText(body, 'td-mv-idi');
      const leg = cellText(body, 'td-mv-leg');
      const seasonMatch = qua.match(/^S(\d{1,2})$/i);
      const size = /\d/.test(tam) ? tam : fmtSize(xl);
      links.push({
        url: magnet,
        quality: (res && /\d/.test(res) ? normalizeQuality(res) : null) ?? qualityFromText(dn),
        size: size && /kb/i.test(size) ? null : size,
        audio: classifyAudio(`${headerText} ${idi} ${leg}`),
        source: seasonMatch ? null : normalizeSource(`${qua} ${dn}`),
        episode: null,
        season: seasonMatch ? Number(seasonMatch[1]) : null,
        realTitle: null,
      });
    }
  }
  return links;
}

// Título limpo do post: o tema prefixa "Filme "/"Série " e sufixa
// "Torrent Download"; o sufixo " - Rede Torrent" é do <title>, não do post.
function cleanPostTitle(title = '') {
  let clean = decodeEntities(String(title || ''));
  clean = clean.replace(/\s*Torrent(?:s)?\s*(?:Download)?\s*/gi, ' ');
  clean = clean.replace(/^\s*(?:Filme|S[ée]rie|Baixar|Download)\s+/i, '');
  clean = clean.replace(/\s*[-–|]\s*Rede Torrent\s*$/i, '');
  return clean.replace(/\s+/g, ' ').trim();
}

const releaseTitle = createReleaseTitle({
  cleanTitle: cleanPostTitle,
  titleOf: (post, link) => link?.realTitle || (typeof post === 'string' ? post : post?.title) || '',
  audioTagOf: (link) =>
    link?.audio === 'dublado' ? 'DUBLADO'
      : link?.audio === 'dual' ? 'DUAL'
        : link?.audio === 'legendado' ? 'LEGENDADO' : null,
  withSize: true,
  seasonOf: (post, link) => (!link?.realTitle && link?.season != null)
    ? `S${String(link.season).padStart(2, '0')}` : '',
});

// Ordem de preferência: áudio PT primeiro, depois resolução.
function scoreLink(link) {
  const audio = link.audio === 'dual' || link.audio === 'dublado' ? 100_000
    : link.audio === 'legendado' ? 0 : 50_000;
  return audio + Number(link.quality || 0);
}

// Página sintética do card Cardigann: o href de cada linha É o magnet do post
// (magnet direto no HTML sintético, sem /resolve e sem download.before).
function createRedeSearchPageHtml(options = {}) {
  const escape = options.escape || escapeXml;
  const relTitle = options.releaseTitle || releaseTitle;
  return function searchPageHtml(items) {
    const rows = items.map(({ post, link, index }) => {
      const title = relTitle(post, link, index);
      // O post.url tem elemento PRÓPRIO com href: o details do cardigann lê
      // o atributo em vez de colar o magnet/texto — URL do post nunca sai
      // quebrada no Jackett. O magnet continua no href do título (download).
      return `<div class="release"><div class="title"><a href="${escape(link.url)}">${escape(title)}</a></div><div class="size">${escape(link.size || '1 KB')}</div><div class="post"><a href="${escape(post.url || '')}">${escape(post.url || '')}</a></div><div class="description">${escape(post.title || '')}</div><div class="seeders">1</div></div>`;
    }).join('');
    return `<!doctype html><html><body><div class="posts">${rows}</div></body></html>`;
  };
}

// Feed torznab: o link é o magnet do post (sem /dl do perfil).
function rssXml(items, category) {
  const body = items.map(({ post, link }) => {
    const size = (() => {
      const match = String(link.size || '').match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
      if (!match) return 0;
      const value = Number(match[1].replace(',', '.'));
      const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2].toUpperCase()];
      return Number.isFinite(value) ? Math.round(value * multiplier) : 0;
    })();
    return `<item><title>${escapeXml(releaseTitle(post, link))}</title><guid isPermaLink="false">${escapeXml(link.url)}</guid><link>${escapeXml(link.url)}</link><comments>${escapeXml(post.url)}</comments><pubDate>${escapeXml(post.date || new Date().toUTCString())}</pubDate><size>${size}</size><category>${category}</category><torznab:attr name="category" value="${category}"/><torznab:attr name="size" value="${size}"/><torznab:attr name="seeders" value="1"/><torznab:attr name="peers" value="1"/><torznab:attr name="downloadvolumefactor" value="0"/><torznab:attr name="uploadvolumefactor" value="1"/></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Rede Torrent</title>${body}</channel></rss>`;
}

module.exports = {
  FALLBACK_SITE_SUFFIXES, PROTECTOR_SUFFIXES,
  normalizeQuery, requestedSeasonFromQuery, classifyAudio,
  matchesSeasonSeason, matchesResolverQuery, normalizeQuality, normalizeSource,
  parseSearchHtml, extractMagnetHref, parsePostLinks,
  isValidMagnetUri,
  cleanPostTitle, releaseTitle, scoreLink, createRedeSearchPageHtml, rssXml,
  stripTags, decodeEntities, escapeXml,
};
