// Tamanho <= 1 KB é o sentinela de "desconhecido" dos indexers BR (ver
// UNKNOWN_SIZE nos resolvedores), não um torrent de verdade.
const UNKNOWN_SIZE_MAX = 1024;

// Resolução que o título não informa. Balde e cota próprios, separados do SD.
const UNKNOWN_QUALITY = 'sem resolução';

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

/**
 * "Não sei" é diferente de "é ruim". Título sem resolução vira UNKNOWN_QUALITY,
 * não SD: os sites BR quase nunca publicam resolução ("Nome (2026) [opção 3]"),
 * e enquanto isso caía no balde do SD, zerar a cota de SD desligava a
 * prioridade brasileira inteira — inclusive as vagas reservadas.
 * SD agora exige uma marca explícita de baixa qualidade.
 */
function qualityFromTitle(title = '') {
  const t = title.toUpperCase();
  if (/\b(2160P|4K|UHD)\b/.test(t)) return '2160p';
  if (/\b1080P\b/.test(t)) return '1080p';
  if (/\b720P\b/.test(t)) return '720p';
  if (/\b480P\b/.test(t)) return '480p';
  // 576p/540p são resoluções SD de verdade (PAL), não "não sei".
  if (/\b(576P|540P|360P|240P|SDTV|DVD[- ]?(?:RIP|SCR)|VHS[- ]?RIP|TS|TC|CAM[- ]?RIP|CAM)\b/.test(t)) return 'SD';
  return UNKNOWN_QUALITY;
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

/**
 * Áudio é a informação que mais importa neste addon (foco em dublado) e os
 * sites BR a escrevem no título. Sem ela o usuário abre o torrent pra descobrir.
 */
function audioFromTitle(title = '') {
  const t = title.toUpperCase();
  if (/\b(DUAL|DOUBLE)\b/.test(t)) return 'Dual';
  if (/DUBLAD/.test(t)) return 'Dublado';
  if (/LEGENDAD/.test(t)) return 'Legendado';
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
  const rawSize = Number(item.size ?? item.Size);
  // Os indexers BR mandam 1 KB quando o post não publica tamanho: o Jackett
  // descarta release sem tamanho, então o sentinela é o preço de não perder a
  // release. Aqui ele volta a ser "desconhecido" — nenhum vídeo tem 1 KB.
  const knownSize = Number.isFinite(rawSize) && rawSize > UNKNOWN_SIZE_MAX ? rawSize : 0;
  const size = bytesToSize(knownSize);
  const tracker = item.tracker || item.Tracker || item.Indexer || item.indexer || '';
  const quality = qualityFromTitle(title);
  const source = sourceFromTitle(title);
  const audio = audioFromTitle(title);

  // Convenção do Torrentio: 👤 seeders, 💾 tamanho, ⚙️ indexer. Os clientes
  // (Stremio e Power Movie) reconhecem esses marcadores e montam a linha de
  // metadados a partir deles — com "•" eles não exibiam seeds nem a fonte.
  const bits = [
    `👤 ${seeders}`,
    size ? `💾 ${size}` : null,
    tracker ? `⚙️ ${tracker}` : null,
    audio || null,
    source || null,
  ].filter(Boolean);

  return {
    // O Power Movie renderiza o `name` literal na linha do stream (\n vira
    // espaço) e deriva os badges do nome do arquivo — por isso o título da
    // release tem que estar aqui, senão a linha só mostra a marca. A 2ª linha
    // leva qualidade/áudio/seeds pro cliente Stremio padrão, que não deriva.
    // Resolução desconhecida não vira rótulo: "sem resolução" no lugar do
    // "1080p" only atrapalha a linha do cliente. Fica só áudio + seeds.
    name: `${title}\n${quality === UNKNOWN_QUALITY ? '' : quality}${audio ? `${quality === UNKNOWN_QUALITY ? '' : ' '}${audio}` : ''}${seeders ? ` · 👤 ${seeders}` : ''}`.replace('\n ', '\n'),
    title: `${title}\n${bits.join(' ')}`,
    infoHash,
    sources: TRACKERS.map((t) => `tracker:${t}`),
    behaviorHints: {
      // Binge de uma release sem resolução não pode cair no grupo do SD.
      bingeGroup: `powerm-${quality === UNKNOWN_QUALITY ? 'na' : quality}-${source || 'any'}`,
    },
    _seeders: seeders,
    _quality: quality,
    // 0 = desconhecido, e o filtro de tamanho máximo já trata 0 como "passa".
    _size: knownSize,
    _dubbed: audio === 'Dublado' || audio === 'Dual',
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

/**
 * Extrai temporada/episódio do título da release. Cobre os formatos que os
 * indexers usam de fato: "S01E04", "S01E01-E10", "1x04", "S01" (pack) e as
 * variações pt-BR dos sites BR ("1ª Temporada", "Temporada 1", "Episódio 4").
 */
function parseTitleSeasonEpisode(title = '') {
  const t = normalizeTitle(title);
  const seasons = new Set();
  const episodes = new Set();

  // "s01e04", "s01 e04", "s01e01 e10" (intervalo), "s01e01e02"
  for (const m of t.matchAll(/s(\d{1,2})((?:\s?e\s?\d{1,3})+)/g)) {
    seasons.add(Number(m[1]));
    const eps = [...m[2].matchAll(/e\s?(\d{1,3})/g)].map((x) => Number(x[1]));
    if (eps.length >= 2) {
      // Intervalo ("E01-E10" chega como "e01 e10"): tudo entre o menor e o maior.
      const lo = Math.min(...eps);
      const hi = Math.max(...eps);
      for (let i = lo; i <= hi; i += 1) episodes.add(i);
    } else {
      eps.forEach((e) => episodes.add(e));
    }
  }

  // "1x04"
  for (const m of t.matchAll(/(\d{1,2})x(\d{1,3})/g)) {
    seasons.add(Number(m[1]));
    episodes.add(Number(m[2]));
  }

  // Pack: "s01", "s01 s03" (multi-temporada), "season 1", "1 temporada", "temporada 1"
  for (const m of t.matchAll(/s(\d{1,2})(?![\de])/g)) seasons.add(Number(m[1]));
  for (const m of t.matchAll(/(?:season|temporada)\s?(\d{1,2})/g)) seasons.add(Number(m[1]));
  for (const m of t.matchAll(/(\d{1,2})\s?(?:a|ª)?\s?temporada/g)) seasons.add(Number(m[1]));

  // Episódio solto em pt-BR só conta quando a temporada já apareceu; senão
  // "Episódio II" de filme (Star Wars) viraria episódio de série.
  if (seasons.size && episodes.size === 0) {
    for (const m of t.matchAll(/epis[oó]dio\s?(\d{1,3})/g)) episodes.add(Number(m[1]));
  }

  return { seasons: [...seasons], episodes: [...episodes] };
}

/**
 * O indexer devolve a temporada inteira quando a busca é por "Nome S01E01" —
 * sem este filtro a lista de E01 vinha recheada de E03, E04, E06, E09.
 * Pack de temporada (sem episódio no título) continua valendo: é dele que o
 * debrid tira o arquivo certo, e é o formato que as fontes BR publicam.
 */
function matchesEpisode(title, { season, episode } = {}) {
  if (season == null || episode == null) return true;
  const { seasons, episodes } = parseTitleSeasonEpisode(title);

  // Nenhuma pista de temporada/episódio: não dá pra afirmar que é errado
  // (release BR costuma vir só como "Nome Dublado"), então passa.
  if (seasons.length === 0 && episodes.length === 0) return true;

  if (seasons.length && !seasons.includes(season)) return false;
  if (episodes.length && !episodes.includes(episode)) return false;
  return true;
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
    best.set(s.infoHash, {
      ...winner,
      _br: winner._br || s._br || prev._br,
      _dubbed: winner._dubbed || s._dubbed || prev._dubbed,
    });
  }
  return [...best.values()];
}

const QUALITY_KEYS = ['2160p', '1080p', '720p', '480p', 'SD', UNKNOWN_QUALITY];

function streamQuality(stream) {
  return stream?._quality || qualityFromTitle(stream?.title || stream?.name || '');
}

/**
 * Separa espaço no pool pré-debrid para cada qualidade configurada. Sem isso,
 * centenas de 4K poderiam ocupar o pool inteiro e impedir que a cota pedida de
 * 1080p tivesse candidatos para sobreviver ao filtro de cache.
 */
function selectQualityCandidates(
  streams,
  {
    maxResults = 40,
    qualityLimits = {},
    brReservedSlots = 0,
    candidateFactor = 1,
    brFirst = true,
  } = {},
) {
  const poolSize = Math.max(0, Math.trunc(maxResults));
  const custom = QUALITY_KEYS.filter((quality) => Number(qualityLimits[quality]) < 100);
  const customSet = new Set(custom);
  const buckets = new Map(custom.map((quality) => [quality, []]));
  for (const stream of streams) {
    const bucket = buckets.get(streamQuality(stream));
    if (bucket) bucket.push(stream);
  }

  const selected = new Set();
  const positions = new Map(custom.map((quality) => [quality, 0]));
  const counts = new Map(custom.map((quality) => [quality, 0]));
  const factor = Math.max(1, Math.trunc(candidateFactor));
  const targets = new Map(
    custom.map((quality) => [
      quality,
      Math.max(0, Math.trunc(Number(qualityLimits[quality]) || 0)) * factor,
    ]),
  );

  // A reserva precisa existir também quando a qualidade está em 100. Se os BR
  // forem considerados só no corte final, seeders globais podem preencher o
  // pool ampliado antes deles chegarem ao debrid.
  const brTarget = brFirst ? poolSize : brReservedSlots;
  for (const stream of streams) {
    if (selected.size >= poolSize || selected.size >= brTarget) break;
    if (!stream._br) continue;
    const quality = streamQuality(stream);
    if (customSet.has(quality) && counts.get(quality) >= targets.get(quality)) continue;
    selected.add(stream);
    if (customSet.has(quality)) counts.set(quality, counts.get(quality) + 1);
  }

  // Round-robin evita que a primeira qualidade consuma todo o pool quando a
  // soma das cotas configuradas ultrapassa o máximo global.
  let progressed = true;
  while (selected.size < poolSize && progressed) {
    progressed = false;
    for (const quality of custom) {
      const bucket = buckets.get(quality);
      let position = positions.get(quality);
      while (position < bucket.length && selected.has(bucket[position])) position += 1;
      positions.set(quality, position);
      if (counts.get(quality) >= targets.get(quality) || position >= bucket.length) continue;
      selected.add(bucket[position]);
      positions.set(quality, position + 1);
      counts.set(quality, counts.get(quality) + 1);
      progressed = true;
      if (selected.size >= poolSize) break;
    }
  }

  // Qualidades em 100 são ilimitadas e preenchem o espaço restante sem tomar
  // as vagas já separadas para as cotas explícitas.
  for (const stream of streams) {
    if (selected.size >= poolSize) break;
    if (selected.has(stream)) continue;
    if (customSet.has(streamQuality(stream))) continue;
    selected.add(stream);
  }

  // A seleção reserva espaço, mas a ordem original de qualidade/seeders segue
  // intacta para a listagem e para o debrid.
  return streams.filter((stream) => selected.has(stream));
}

/** Aplica as cotas na lista pós-debrid, quando só os streams reais são contados. */
function limitByQuality(streams, qualityLimits = {}) {
  const counts = new Map();
  return streams.filter((stream) => {
    const quality = streamQuality(stream);
    const rawLimit = qualityLimits[quality];
    const limit = rawLimit == null || rawLimit >= 100 ? Infinity : Math.max(0, Math.trunc(rawLimit));
    const count = counts.get(quality) || 0;
    if (count >= limit) return false;
    counts.set(quality, count + 1);
    return true;
  });
}

/**
 * O que mandar o debrid baixar quando NÃO existe fonte BR dublada tocável.
 * `null` = não faça nada, e é o retorno na maioria das buscas.
 *
 * Cuidado deliberado aqui, porque o efeito é escrever na conta do usuário:
 * - só olha o que tem infoHash (stream já resolvido não tem o que enfileirar);
 * - se QUALQUER candidato BR já está em cache, não baixa nada — já dá play;
 * - `streams` chega ordenado, então o primeiro é o melhor candidato;
 * - BR sem marca de áudio no título entra como dublado só quando nenhum
 *   candidato tiver a marca: é o padrão dos sites BR ("Nome (2026) [opção 3]"),
 *   mas um "LEGENDADO" explícito nunca é tratado como dublado.
 */
function brDubbedPool(streams = []) {
  const br = streams.filter((s) => s && s._br && s.infoHash);
  if (br.length === 0) return [];
  const tagged = br.filter((s) => s._dubbed);
  return tagged.length
    ? tagged
    : br.filter((s) => !/LEGENDAD/i.test(String(s.name || s.title || '')));
}

/** Melhor candidato BR dublado, sem olhar cache. `streams` já vem ordenado. */
function pickBrDubbedCandidate(streams = []) {
  return brDubbedPool(streams)[0] || null;
}

/** Já existe fonte BR dublada tocável na hora? Então não há o que baixar. */
function hasCachedBrDubbed(streams = [], cachedHashes = new Set()) {
  return brDubbedPool(streams).some((s) => cachedHashes.has(s.infoHash));
}

/** Reserva origem BR, aplica as cotas finais e remove todos os campos internos. */
function limitReservingBr(
  streams,
  {
    brReservedSlots = 0,
    maxResults = 40,
    brOnly = false,
    qualityLimits = {},
    brFirst = true,
  } = {},
) {
  const pool = brOnly ? streams.filter((stream) => stream._br) : streams;
  const eligible = limitByQuality(pool, qualityLimits);
  const brStreams = eligible.filter((stream) => stream._br);
  let selected;

  if (brFirst) {
    selected = [...brStreams, ...eligible.filter((stream) => !stream._br)].slice(0, maxResults);
  } else {
    // Sem prioridade visual, as vagas continuam garantidas: entram no lugar
    // dos últimos globais e preservam sua posição natural na ordem original.
    const reserved = brStreams.slice(0, brReservedSlots);
    const chosen = new Set(eligible.slice(0, maxResults));
    for (const stream of reserved) {
      if (chosen.has(stream)) continue;
      const replace = [...chosen].reverse().find((item) => !item._br);
      if (replace) chosen.delete(replace);
      if (chosen.size < maxResults) chosen.add(stream);
    }
    selected = eligible.filter((stream) => chosen.has(stream)).slice(0, maxResults);
  }

  return selected
    .map(({ _br, _seeders, _quality, _size, _dubbed, ...stream }) => stream);
}

function sortAndLimit(
  streams,
  {
    minSeeders = 0,
    maxResults = 40,
    qualityFilter = [],
    season = null,
    episode = null,
    preferDubbed = false,
    excludeCam = false,
    maxSizeGb = 0,
    qualityLimits = {},
    brReservedSlots = 0,
    candidateFactor = 1,
    brFirst = true,
  } = {},
) {
  // Release que nomeia o episódio pedido vem antes do pack da temporada: o pack
  // serve, mas quem pediu o E01 quer ver o E01 no topo da lista.
  const exact = (s) =>
    season != null && episode != null &&
    parseTitleSeasonEpisode(s.title).episodes.includes(episode)
      ? 1
      : 0;
  const dubbed = (s) => (s._dubbed ? 1 : 0);
  const maxSizeBytes = maxSizeGb > 0 ? maxSizeGb * 1024 ** 3 : 0;

  const ordered = dedupeByHash(streams)
    .filter((s) => (s._seeders || 0) >= minSeeders)
    .filter((s) => matchesQualityFilter(s.title, qualityFilter))
    .filter((s) => !excludeCam || sourceFromTitle(s.title) !== 'CAM')
    // Tamanho ausente não é tratado como zero real: sem dado confiável, o
    // stream continua visível em vez de ser descartado silenciosamente.
    .filter((s) => !maxSizeBytes || !s._size || s._size <= maxSizeBytes)
    .sort((a, b) => {
      const ed = exact(b) - exact(a);
      if (ed !== 0) return ed;
      // Sem resolução fica acima do SD e abaixo do 720p: é quase sempre um
      // WEB-DL BR que não anuncia resolução, não uma cópia ruim.
      const qOrder = { '2160p': 5, '1080p': 4, '720p': 3, [UNKNOWN_QUALITY]: 2, '480p': 1, SD: 0 };
      const qd = (qOrder[b._quality] || 0) - (qOrder[a._quality] || 0);
      if (qd !== 0) return qd;
      if (preferDubbed) {
        const ad = dubbed(b) - dubbed(a);
        if (ad !== 0) return ad;
      }
      return (b._seeders || 0) - (a._seeders || 0);
    });

  return selectQualityCandidates(ordered, {
    maxResults,
    qualityLimits,
    brReservedSlots,
    candidateFactor,
    brFirst,
  })
    // `_quality` e `_br` precisam sobreviver ao debrid: as cotas e a reserva
    // são aplicadas só depois que cachedOnly remove os streams indisponíveis.
    .map(({ _seeders, _size, _dubbed, ...rest }) => rest);
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
  UNKNOWN_QUALITY,
  QUALITY_KEYS,
  bytesToSize,
  extractInfoHash,
  qualityFromTitle,
  sourceFromTitle,
  audioFromTitle,
  toStremioStream,
  sortAndLimit,
  parseStremioId,
  buildSearchQuery,
  matchesQualityFilter,
  matchesName,
  matchesEpisode,
  parseTitleSeasonEpisode,
  dedupeByHash,
  selectQualityCandidates,
  limitByQuality,
  limitReservingBr,
  pickBrDubbedCandidate,
  hasCachedBrDubbed,
  normalizeTitle,
  decodeEntities,
};
