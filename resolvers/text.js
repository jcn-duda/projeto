'use strict';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
};

// Variante usada por BluDV e ComandoTorrents: os dois sites publicam entidades
// nomeadas e numéricas além das quatro formas históricas.
function decodeEntities(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

// NerdFilmes e TorrentDosFilmes mantêm esta semântica histórica de propósito:
// usar a variante rica mudaria o texto que chega ao matching desses perfis.
function decodeEntitiesBasic(value = '') {
  return String(value)
    .replace(/&#0?38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;|&#039;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function stripTags(value = '', decode = decodeEntities) {
  return decode(String(value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseSize(text) {
  const match = String(text || '').match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2].toUpperCase()];
  return Number.isFinite(value) ? Math.round(value * multiplier) : null;
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const escapeHtml = escapeXml;

function attribute(tag, name, { decode = (value) => value, allowWhitespace = false } = {}) {
  const equals = allowWhitespace ? '\\s*=\\s*' : '=';
  const raw = String(tag).match(new RegExp(`\\b${name}${equals}["']([^"']*)["']`, 'i'))?.[1] || null;
  return raw == null ? null : decode(raw);
}

module.exports = {
  decodeEntities,
  decodeEntitiesBasic,
  stripTags,
  parseSize,
  escapeXml,
  escapeHtml,
  attribute,
};
