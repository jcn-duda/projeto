// Gerador do golden de stream-quotas-extra.
// Executar com: node scripts/golden/generate-stream-quotas-extra.mjs

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { qualityFromTitle, UNKNOWN_QUALITY } from '../../dist/src/utils/audio-quality.js';
import { limitByQuality, limitByQualityAndIndexer } from '../../dist/src/utils/stream-quotas.js';
import { selectQualityCandidates, QUALITY_KEYS } from '../../dist/src/utils/stream-quotas-candidate.js';

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
