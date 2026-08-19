// @ts-check
const config = require('../config');
const indexerStatus = require('./indexer-status');
const log = require('../utils/logger');

let cached = null;
let cachedAt = 0;
let inFlight = null;

function attrs(text) {
  const out = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
  let match;
  while ((match = re.exec(text))) out[match[1].toLowerCase()] = decodeXml(match[3]);
  return out;
}

function safeId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(id || ''));
}

function labelFor(id) {
  return String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function decodeXml(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  // Uma passagem só evita decodificar duas vezes `&#38;amp;`. Entidade numérica
  // inválida fica literal em vez de derrubar todo o catálogo com RangeError.
  return String(text || '').replace(/&(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity) => {
    const body = entity.slice(1, -1).toLowerCase();
    if (named[body] != null) return named[body];
    const value = body.startsWith('#x') ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      return entity;
    }
    return String.fromCodePoint(value);
  });
}

function tag(body, name) {
  const match = String(body || '').match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '').trim()) : '';
}

function parseXml(xml) {
  const items = [];
  const re = /<(?:indexer|torznab:indexer)\b([^>]*)>([\s\S]*?)<\/(?:indexer|torznab:indexer)>/gi;
  let match;
  while ((match = re.exec(String(xml || '')))) {
    const a = attrs(match[1]);
    const id = String(a.id || a.identifier || '').toLowerCase();
    if (!safeId(id)) continue;
    const language = a.language || a.languages || tag(match[2], 'language');
    items.push({
      id,
      label: String(a.name || a.label || tag(match[2], 'title') || id),
      language: String(language),
      // A mesma lista governa query pt-BR, timeout e marca de origem. Inferir
      // por idioma aqui criaria uma classificação paralela e inconsistente.
      isBr: config.jackett.ptBrIndexers.includes(String(id)),
    });
  }
  return items;
}

function fallback() {
  const ids = [
    ...config.jackett.indexers,
    ...config.jackett.ptBrIndexers,
    ...config.jackett.slowIndexers,
  ];
  const seen = new Set();
  return ids.filter(safeId).filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((id) => ({
    id,
    label: labelFor(id),
    language: config.jackett.ptBrIndexers.includes(id) ? 'pt-BR' : '',
    isBr: config.jackett.ptBrIndexers.includes(id),
  }));
}

async function load() {
  if (cached && Date.now() - cachedAt < config.jackett.catalogTtl * 1000) {
    return indexerStatus.decorate(cached);
  }
  if (inFlight) return inFlight.then(indexerStatus.decorate);
  inFlight = (async () => {
    try {
      if (!config.jackett.apiKey) return fallback();
      const endpoint = new URL(`${config.jackett.url}/api/v2.0/indexers/all/results/torznab/api`);
      endpoint.searchParams.set('apikey', config.jackett.apiKey);
      endpoint.searchParams.set('t', 'indexers');
      endpoint.searchParams.set('configured', 'true');
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/xml,text/xml', 'User-Agent': 'stremio-adom/1.0' },
        signal: AbortSignal.timeout(config.jackett.indexerTimeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseXml(await res.text());
      return parsed.length ? parsed : fallback();
    } catch (err) {
      log.warn('[jackett] catálogo indisponível:', err.message);
      return fallback();
    }
  })().then((items) => {
    cached = items;
    cachedAt = Date.now();
    return items;
  }).finally(() => { inFlight = null; });
  return inFlight.then(indexerStatus.decorate);
}

module.exports = { load, parseXml, fallback };
