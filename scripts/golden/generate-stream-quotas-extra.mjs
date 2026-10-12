// Gerador do golden de stream-quotas-extra.
// Executar com: node scripts/golden/generate-stream-quotas-extra.mjs

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UNKNOWN_QUALITY = 'sem resolução';
const QUALITY_KEYS = ['2160p', '1080p', '720p', '480p', 'SD', UNKNOWN_QUALITY];

// ─── qualityFromTitle ───────────────────────────────────────────────────────

const TAG_BLOB_VOCAB = new Set([
  '480p','540p','576p','720p','1080p','1440p','2160p','4k','uhd','sd','fullhd',
]);
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9+]/g, '');

function stripQualityTagBlob(title = '') {
  const raw = String(title || '');
  if (!raw.includes(',')) return raw;
  let cut = raw.length, tags = 0;
  for (;;) {
    const m = raw.slice(0, cut).match(/[,;]\s*([A-Za-z0-9][A-Za-z0-9+.\-]*)\s*$/);
    if (!m || !TAG_BLOB_VOCAB.has(norm(m[1]))) break;
    cut = m.index; tags++;
  }
  if (tags < 2) return raw;
  const before = raw.slice(0, cut);
  const head = before.match(/(?:^|\s)([A-Za-z0-9][A-Za-z0-9+.\-]*)$/);
  if (head && TAG_BLOB_VOCAB.has(norm(head[1]))) return before.slice(0, before.length - head[1].length).trimEnd();
  return before.trimEnd();
}

function qualityFromTitle(title = '') {
  const t = stripQualityTagBlob(title).toUpperCase().replace(/_/g, ' ')
    .replace(/(RIP|DL|WEB|HDTV)(?=(?:2160|1080|720|480)P\b)/g, '$1 ');
  if (/\b(2160P|4K|UHD)\b/.test(t)) return '2160p';
  if (/\b1080P\b/.test(t)) return '1080p';
  if (/\b720P\b/.test(t)) return '720p';
  if (/\b480P\b/.test(t)) return '480p';
  if (/\b(576P|540P|360P|240P|SDTV|DVD5|DVD9|DVD[- ]?R|DVD[- ]?(?:RIP|SCR)|VHS[- ]?RIP|TS|TC|CAM[- ]?RIP|CAM)\b/.test(t)) return 'SD';
  return UNKNOWN_QUALITY;
}

const streamQuality = (s) => s?._quality || qualityFromTitle(s?.title || s?.name || '');

// ─── limitByQuality ─────────────────────────────────────────────────────────

function limitByQuality(streams, qualityLimits = {}) {
  const counts = new Map();
  return streams.filter((s) => {
    const q = streamQuality(s);
    const raw = qualityLimits[q];
    const lim = raw == null || raw >= 100 ? Infinity : Math.max(0, Math.trunc(raw));
    const c = counts.get(q) || 0;
    if (c >= lim) return false;
    counts.set(q, c + 1); return true;
  });
}

// ─── limitByQualityAndIndexer ───────────────────────────────────────────────

function limitByQualityAndIndexer(streams, qualityLimits, maxPerIndexer, exempt, indexerLimits, reservedBr = new Set()) {
  const qc = new Map(), ic = new Map();
  const gl = Math.max(0, Math.trunc(Number(maxPerIndexer) || 0));
  return streams.filter((s) => {
    const q = streamQuality(s);
    const rl = qualityLimits[q];
    const ql = rl == null || rl >= 100 ? Infinity : Math.max(0, Math.trunc(rl));
    const qn = qc.get(q) || 0;
    const res = reservedBr.has(s);
    if (!res && qn >= ql) return false;
    const src = String(s?._indexer || '').trim().toLowerCase();
    const sn = src ? (ic.get(src) || 0) : 0;
    const sl = src && Object.prototype.hasOwnProperty.call(indexerLimits, src)
      ? Math.max(0, Math.trunc(Number(indexerLimits[src]) || 0)) : gl;
    if (src && !exempt.has(s) && sl && sn >= sl) return false;
    if (!res) qc.set(q, qn + 1);
    if (src) ic.set(src, sn + 1);
    return true;
  });
}

// ─── selectQualityCandidates ────────────────────────────────────────────────

function selectQualityCandidates(streams, {
  maxResults = 40, qualityLimits = {}, brReservedSlots = 0,
  brReservedPerQuality = 0, candidateFactor = 1, brFirst = true,
} = {}) {
  const poolSize = Math.max(0, Math.trunc(maxResults));
  const custom = QUALITY_KEYS.filter((q) => Number(qualityLimits[q]) < 100);
  const customSet = new Set(custom);
  const buckets = new Map(custom.map((q) => [q, []]));
  for (const s of streams) { const b = buckets.get(streamQuality(s)); if (b) b.push(s); }
  const selected = new Set();
  const positions = new Map(custom.map((q) => [q, 0]));
  const counts = new Map(custom.map((q) => [q, 0]));
  const factor = Math.max(1, Math.trunc(candidateFactor));
  const targets = new Map(custom.map((q) => [q, Math.max(0, Math.trunc(Number(qualityLimits[q]) || 0)) * factor]));
  const brTarget = brFirst ? poolSize : Math.max(0, Math.trunc(Number(brReservedSlots) || 0));
  const perFaixa = Math.max(0, Math.trunc(Number(brReservedPerQuality) || 0));
  if (perFaixa > 0) {
    const fc = new Map();
    for (const s of streams) {
      if (selected.size >= poolSize || selected.size >= brTarget) break;
      if (!s._br || s._lied || selected.has(s)) continue;
      const q = streamQuality(s), u = fc.get(q) || 0;
      if (u >= perFaixa) continue;
      if (customSet.has(q) && counts.get(q) >= targets.get(q)) continue;
      fc.set(q, u + 1); selected.add(s);
      if (customSet.has(q)) counts.set(q, counts.get(q) + 1);
    }
  }
  for (const s of streams) {
    if (selected.size >= poolSize || selected.size >= brTarget) break;
    if (!s._br || s._lied || selected.has(s)) continue;
    const q = streamQuality(s);
    if (customSet.has(q) && counts.get(q) >= targets.get(q)) continue;
    selected.add(s); if (customSet.has(q)) counts.set(q, counts.get(q) + 1);
  }
  let progressed = true;
  while (selected.size < poolSize && progressed) {
    progressed = false;
    for (const q of custom) {
      const bucket = buckets.get(q); let pos = positions.get(q);
      while (pos < bucket.length && selected.has(bucket[pos])) pos++;
      positions.set(q, pos);
      if (counts.get(q) >= targets.get(q) || pos >= bucket.length) continue;
      selected.add(bucket[pos]); positions.set(q, pos + 1);
      counts.set(q, counts.get(q) + 1); progressed = true;
      if (selected.size >= poolSize) break;
    }
  }
  for (const s of streams) {
    if (selected.size >= poolSize) break;
    if (selected.has(s) || customSet.has(streamQuality(s))) continue;
    selected.add(s);
  }
  return streams.filter((s) => selected.has(s));
}

// ─── Geração de casos ───────────────────────────────────────────────────────

let n = 0;
const nid = () => `sqe-${String(++n).padStart(3, '0')}`;
const cases = [];
const add = (op, input, expected) => cases.push({ id: nid(), input: JSON.stringify({ op, ...input }), expected: JSON.stringify(expected) });

// qualityFromTitle
for (const [title, exp] of [
  ['Movie 2024 1080p BluRay', '1080p'], ['Movie 720p WEB-DL', '720p'],
  ['Movie 2160p UHD BluRay', '2160p'], ['Movie 4K HDR', '2160p'],
  ['Movie 480p DVDRip', '480p'], ['Movie SDTV', 'SD'], ['Movie DVD5', 'SD'],
  ['Movie CAM', 'SD'], ['Movie TS', 'SD'], ['Movie 576P', 'SD'],
  ['Movie 360P', 'SD'], ['Filme BR', UNKNOWN_QUALITY],
  ['Nome qualquer', UNKNOWN_QUALITY], ['Movie WEB-DLRip1080p x264', '1080p'],
  ['Movie_2024_720P_BluRay', '720p'], ['UHD Movie 2024', '2160p'],
  ['Movie 1080p, 2160p, 720p, HD, WEB-DL', '1080p'],
  ['Movie 720P 1080p, 2160p, 720p, HD', '720p'],
]) add('quality', { title }, qualityFromTitle(title));

// limitByQuality
for (const [limits, desc] of [
  [{ '1080p': 2 }, 'cota-1080p-2'], [{ '1080p': 1, '720p': 1 }, 'multi-cota'],
  [{}, 'sem-cota'], [{ '1080p': 100 }, 'cota-100'],
]) {
  const ss = [
    { title: 'A', _quality: '1080p' }, { title: 'B', _quality: '1080p' },
    { title: 'C', _quality: '1080p' }, { title: 'D', _quality: '720p' },
    { title: 'E', _quality: '720p' },
  ];
  const kept = limitByQuality(ss, limits);
  add('limitQuality', { streams: ss.map(s => ({ quality: s._quality })), limits }, kept.map(s => ss.indexOf(s)));
}

// limitByQualityAndIndexer
{
  const ss = [
    { title: 'A', _quality: '1080p', _indexer: 'yts' },
    { title: 'B', _quality: '1080p', _indexer: 'yts' },
    { title: 'C', _quality: '720p', _indexer: 'rarbg' },
    { title: 'D', _quality: '1080p', _indexer: 'bludv' },
    { title: 'E', _quality: '720p', _indexer: 'yts' },
  ];
  const kept = limitByQualityAndIndexer(ss, { '1080p': 2 }, 1, new Set(), {}, new Set());
  add('limitQualityIndexer', {
    streams: ss.map(s => ({ quality: s._quality, indexer: s._indexer })),
    qualityLimits: { '1080p': 2 }, maxPerIndexer: 1, exempt: [], indexerLimits: {}, reservedBr: [],
  }, kept.map(s => ss.indexOf(s)));
}
{
  const ss = [
    { title: 'A', _quality: '1080p', _indexer: 'yts', _br: true },
    { title: 'B', _quality: '1080p', _indexer: 'yts' },
    { title: 'C', _quality: '1080p', _indexer: 'yts' },
    { title: 'D', _quality: '720p', _indexer: 'rarbg' },
  ];
  const rBr = new Set([ss[0]]);
  const kept = limitByQualityAndIndexer(ss, { '1080p': 1 }, 0, new Set(), {}, rBr);
  add('limitQualityIndexer', {
    streams: ss.map(s => ({ quality: s._quality, indexer: s._indexer, isBr: !!s._br })),
    qualityLimits: { '1080p': 1 }, maxPerIndexer: 0, exempt: [], indexerLimits: {}, reservedBr: [0],
  }, kept.map(s => ss.indexOf(s)));
}

// selectQualityCandidates
{
  const ss = [
    { title: 'A 1080p', _quality: '1080p', _br: false, _lied: false },
    { title: 'B 1080p', _quality: '1080p', _br: false, _lied: false },
    { title: 'C 720p', _quality: '720p', _br: false, _lied: false },
    { title: 'D 2160p', _quality: '2160p', _br: false, _lied: false },
    { title: 'E 1080p BR', _quality: '1080p', _br: true, _lied: false },
  ];
  const kept = selectQualityCandidates(ss, { maxResults: 3, qualityLimits: { '1080p': 2, '720p': 1 }, brFirst: false, brReservedSlots: 1 });
  add('selectCandidates', {
    streams: ss.map(s => ({ quality: s._quality, isBr: s._br, isLied: s._lied })),
    maxResults: 3, qualityLimits: { '1080p': 2, '720p': 1 }, brFirst: false, brReservedSlots: 1,
  }, kept.map(s => ss.indexOf(s)));
}
{
  const ss = [
    { title: 'A 1080p', _quality: '1080p', _br: false, _lied: false },
    { title: 'B 720p BR', _quality: '720p', _br: true, _lied: false },
    { title: 'C 1080p BR', _quality: '1080p', _br: true, _lied: false },
    { title: 'D 2160p', _quality: '2160p', _br: false, _lied: false },
  ];
  const kept = selectQualityCandidates(ss, { maxResults: 3, qualityLimits: { '1080p': 2 }, brFirst: true });
  add('selectCandidates', {
    streams: ss.map(s => ({ quality: s._quality, isBr: s._br, isLied: s._lied })),
    maxResults: 3, qualityLimits: { '1080p': 2 }, brFirst: true,
  }, kept.map(s => ss.indexOf(s)));
}
{
  const ss = [
    { title: 'A 1080p', _quality: '1080p', _br: false, _lied: false },
    { title: 'B 1080p', _quality: '1080p', _br: false, _lied: false },
    { title: 'C 1080p', _quality: '1080p', _br: false, _lied: false },
    { title: 'D 720p', _quality: '720p', _br: false, _lied: false },
    { title: 'E 720p BR', _quality: '720p', _br: true, _lied: false },
    { title: 'F 2160p', _quality: '2160p', _br: false, _lied: false },
  ];
  const kept = selectQualityCandidates(ss, { maxResults: 4, qualityLimits: { '1080p': 2, '720p': 1 }, brFirst: true, brReservedPerQuality: 1 });
  add('selectCandidates', {
    streams: ss.map(s => ({ quality: s._quality, isBr: s._br, isLied: s._lied })),
    maxResults: 4, qualityLimits: { '1080p': 2, '720p': 1 }, brFirst: true, brReservedPerQuality: 1,
  }, kept.map(s => ss.indexOf(s)));
}

// Write
const outPath = resolve(__dirname, '../../rust/golden/stream-quotas-extra.jsonl');
writeFileSync(outPath, cases.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf8');
console.log(`Gerado: ${outPath} (${cases.length} casos)`);
