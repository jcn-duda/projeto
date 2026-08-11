const config = require('../config');
const { TRACKERS } = require('../utils/format');
const { opts } = require('../runtime');

const API = 'https://www.premiumize.me/api';

function magnetFor(infoHash) {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}${trackers}`;
}

async function call(path, { method = 'GET', params = {}, body } = {}) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('apikey', opts().debridApiKey);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method,
    body,
    headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0' },
    signal: AbortSignal.timeout(config.debrid.timeout),
  });
  if (!res.ok) throw new Error(`premiumize HTTP ${res.status}`);

  const data = await res.json();
  if (data.status && data.status !== 'success') {
    throw new Error(data.message || 'premiumize retornou erro');
  }
  return data;
}

/**
 * Quais desses infoHashes já estão no cache do Premiumize (play instantâneo).
 * Retorna um Set com os hashes disponíveis.
 */
async function checkCached(infoHashes) {
  if (!opts().debridApiKey || infoHashes.length === 0) return new Set();

  const cached = new Set();
  // A API aceita lote; mantemos blocos pra não montar URLs gigantes.
  for (let i = 0; i < infoHashes.length; i += config.debrid.batchSize) {
    const batch = infoHashes.slice(i, i + config.debrid.batchSize);
    try {
      const data = await call('/cache/check', { params: { 'items[]': batch } });
      const flags = data.response || [];
      batch.forEach((hash, idx) => {
        if (flags[idx]) cached.add(hash);
      });
    } catch (err) {
      console.warn('[premiumize] cache/check:', err.message);
    }
  }
  return cached;
}

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i;
const SAMPLE = /(^|[^a-z])sample([^a-z]|$)/i;

function pickFile(files, { season, episode } = {}) {
  const videos = files.filter((f) => VIDEO_EXT.test(f.path || '') && !SAMPLE.test(f.path || ''));
  if (videos.length === 0) return null;

  if (season != null && episode != null) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const patterns = [
      new RegExp(`s${s}[\\s._-]*e${e}`, 'i'),
      new RegExp(`\\b${season}x${e}\\b`, 'i'),
      new RegExp(`\\b${s}${e}\\b`),
    ];
    const match = videos.find((f) => patterns.some((p) => p.test(f.path)));
    if (match) return match;
  }

  // Sem episódio pedido (ou sem casar): o maior arquivo é o filme/o conteúdo principal.
  return videos.reduce((a, b) => (Number(b.size || 0) > Number(a.size || 0) ? b : a));
}

/**
 * Resolve o link direto de reprodução — só na hora do play, porque o
 * directdl é caro demais pra rodar em cima da lista inteira de torrents.
 */
async function resolveLink(infoHash, { season, episode } = {}) {
  if (!opts().debridApiKey) return null;

  const body = new URLSearchParams({ src: magnetFor(infoHash) });
  const data = await call('/transfer/directdl', { method: 'POST', params: {}, body });
  const files = data.content || [];
  const file = pickFile(files, { season, episode });
  return file ? file.stream_link || file.link : null;
}

module.exports = { checkCached, resolveLink, magnetFor, pickFile };
