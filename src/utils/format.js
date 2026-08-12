const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
];

function bytesToSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function extractInfoHash(magnetOrHash) {
  if (!magnetOrHash) return null;
  const raw = String(magnetOrHash).trim();

  if (/^[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  if (/^[A-Z2-7]{32}$/.test(raw)) return raw; // base32 — Stremio aceita em alguns casos

  const m = raw.match(/btih:([a-zA-Z0-9]{32,40})/i);
  if (m) return m[1].toLowerCase();
  return null;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
};

/**
 * Indexers que raspam WordPress devolvem o título com entidade crua — o BLUDV
 * e o Comando mandam "Episódio II &#8211; Ataque dos Clones". Sem decodificar,
 * a entidade aparece literal na lista do cliente.
 */
function decodeEntities(text = '') {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function qualityFromTitle(title = '') {
  const t = title.toUpperCase();
  if (/\b(2160P|4K|UHD)\b/.test(t)) return '2160p';
  if (/\b1080P\b/.test(t)) return '1080p';
  if (/\b720P\b/.test(t)) return '720p';
  if (/\b480P\b/.test(t)) return '480p';
  return 'SD';
}

function sourceFromTitle(title = '') {
  const t = title.toUpperCase();
  if (/\b(BLURAY|BLU-RAY|BDREMUX|BD\b)/.test(t)) return 'BluRay';
  if (/\bWEB[-. ]?DL\b/.test(t)) return 'WEB-DL';
  if (/\bWEB[-. ]?RIP\b/.test(t)) return 'WEBRip';
  if (/\bHDTV\b/.test(t)) return 'HDTV';
  if (/\bCAM\b/.test(t)) return 'CAM';
  return '';
}

function matchesQualityFilter(title, filters) {
  if (!filters || filters.length === 0) return true;
  const upper = String(title).toUpperCase();
  return filters.some((f) => upper.includes(String(f).toUpperCase()));
}

/**
 * Normaliza resultados de Jackett/Prowlarr/demo para o formato do Stremio.
 */
function toStremioStream(item) {
  const infoHash = extractInfoHash(item.infoHash || item.magnet || item.MagnetUri || item.Guid);
  if (!infoHash) return null;

  const title = decodeEntities(item.title || item.Title || 'Torrent');
  const seeders = Number(item.seeders ?? item.Seeders ?? 0) || 0;
  const size = bytesToSize(item.size ?? item.Size);
  const tracker = item.tracker || item.Tracker || item.Indexer || item.indexer || '';
  const quality = qualityFromTitle(title);
  const source = sourceFromTitle(title);

  // Convenção do Torrentio: 👤 seeders, 💾 tamanho, ⚙️ indexer. Os clientes
  // (Stremio e Power Movie) reconhecem esses marcadores e montam a linha de
  // metadados a partir deles — com "•" eles não exibiam seeds nem a fonte.
  const bits = [
    `👤 ${seeders}`,
    size ? `💾 ${size}` : null,
    tracker ? `⚙️ ${tracker}` : null,
    source || null,
  ].filter(Boolean);

  return {
    // Os seeds vão no `name` porque é o único bloco nosso que o Power Movie
    // renderiza literal: os badges da linha de baixo ele deriva do nome do
    // arquivo, então o 👤 do `title` (padrão Torrentio) não aparecia lá.
    name: `PowerM\n${quality}${seeders ? ` · 👤 ${seeders}` : ''}`,
    title: `${title}\n${bits.join(' ')}`,
    infoHash,
    sources: TRACKERS.map((t) => `tracker:${t}`),
    behaviorHints: {
      bingeGroup: `powerm-${quality}-${source || 'any'}`,
    },
    _seeders: seeders,
    _quality: quality,
    // Origem BR vem marcada pelo provider, não deduzida do título: releases de
    // comandotorrents/nerdfilmes/torrentdosfilmes não citam "BLUDV" nem
    // "DUBLADO" e ficavam de fora das vagas reservadas.
    _br: Boolean(item.isBr),
  };
}

function normalizeTitle(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Descarta resultados que claramente não são o título procurado — indexers
 * costumam devolver "parecidos" para queries curtas.
 */
function matchesName(title, name) {
  const wanted = normalizeTitle(name)
    .split(' ')
    .filter((w) => w.length > 2);
  if (wanted.length === 0) return true;
  const got = normalizeTitle(title);
  const hits = wanted.filter((w) => got.includes(w)).length;
  return hits / wanted.length >= 0.6;
}

/** Mesma release aparece em vários indexers; fica a de maior seeders. */
function dedupeByHash(streams) {
  const best = new Map();
  for (const s of streams) {
    if (!s) continue;
    const prev = best.get(s.infoHash);
    if (!prev) {
      best.set(s.infoHash, s);
      continue;
    }
    // A mesma release pode vir de um indexer global (com seeders) e de um BR.
    // Fica a de mais seeders, mas a marca de origem BR não pode se perder no
    // desempate, senão a vaga reservada deixa de proteger a fonte dublada.
    const winner = (s._seeders || 0) > (prev._seeders || 0) ? s : prev;
    best.set(s.infoHash, { ...winner, _br: winner._br || s._br || prev._br });
  }
  return [...best.values()];
}

function sortAndLimit(streams, { minSeeders = 0, maxResults = 40, qualityFilter = [] } = {}) {
  return dedupeByHash(streams)
    .filter((s) => (s._seeders || 0) >= minSeeders)
    .filter((s) => matchesQualityFilter(s.title, qualityFilter))
    .sort((a, b) => {
      const qOrder = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, SD: 0 };
      const qd = (qOrder[b._quality] || 0) - (qOrder[a._quality] || 0);
      if (qd !== 0) return qd;
      return (b._seeders || 0) - (a._seeders || 0);
    })
    .slice(0, maxResults)
    .map(({ _seeders, _quality, ...rest }) => rest);
}

function parseStremioId(id) {
  // movie: tt1234567 | series: tt1234567:1:2
  const parts = String(id).split(':');
  return {
    imdbId: parts[0],
    season: parts[1] ? Number(parts[1]) : null,
    episode: parts[2] ? Number(parts[2]) : null,
  };
}

function buildSearchQuery(meta, { season, episode } = {}) {
  const name = meta?.name || meta?.title || '';
  const year = meta?.year ? String(meta.year).slice(0, 4) : '';
  if (season != null && episode != null) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `${name} S${s}E${e}`.trim();
  }
  return [name, year].filter(Boolean).join(' ').trim();
}

module.exports = {
  TRACKERS,
  bytesToSize,
  extractInfoHash,
  qualityFromTitle,
  toStremioStream,
  sortAndLimit,
  parseStremioId,
  buildSearchQuery,
  matchesQualityFilter,
  matchesName,
  dedupeByHash,
  normalizeTitle,
  decodeEntities,
};
