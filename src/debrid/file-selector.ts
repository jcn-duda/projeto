import { normalizeTitle, parseTitleSeasonEpisode } from '../utils/format.js';
import type { MaybeError } from './common.js';
import type { PlayHint } from '../../types/domain.js';

/** Arquivo dentro de um torrent, como cada serviço o reporta. */
export type DebridFile = { path?: string; size?: number; [k: string]: any };

class WorkPickError extends Error {
  code = 'WORK_PICK';
  constructor() { super('não foi possível identificar a obra dentro do pack'); this.name = 'WorkPickError'; }
}
function isWorkPickError(error: MaybeError) { return error?.code === 'WORK_PICK'; }

class EpisodePickError extends Error {
  code = 'EPISODE_PICK';
  evidence?: { wantedSeason: number; wantedEpisode: number; declaredSeasons: number[]; declaredEpisodes: number[]; sample?: string };
  context?: { videoCount: number; samples: string[] };
  constructor(evidence?: { wantedSeason: number; wantedEpisode: number; declaredSeasons: number[]; declaredEpisodes: number[]; sample?: string }, context?: { videoCount: number; samples: string[] }) {
    super('não foi possível identificar o episódio dentro do pack'); this.name = 'EpisodePickError'; this.evidence = evidence; this.context = context;
  }
}
function isEpisodePickError(error: MaybeError) { return error?.code === 'EPISODE_PICK'; }

class NoVideoError extends Error {
  code = 'NO_VIDEO';
  constructor() { super('o torrent não contém nenhum arquivo de vídeo'); this.name = 'NoVideoError'; }
}
function isNoVideoError(error: MaybeError) { return error?.code === 'NO_VIDEO'; }

class DubLieError extends Error {
  code = 'DUB_LIE';
  evidence: { matchedGroup?: string; videoCount: number; sample?: string };
  constructor(evidence: { matchedGroup?: string; videoCount: number; sample?: string }) {
    super('o torrent anunciado como dublado contém release em inglês'); this.name = 'DubLieError'; this.evidence = evidence;
  }
}
function isDubLieError(error: MaybeError) { return error?.code === 'DUB_LIE'; }

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i;
const SAMPLE = /(^|[^a-z])sample([^a-z]|$)/i;
const EXTRA = /(^|[^a-z])(extras?|b[oô]nus|bonus|featurettes?|interviews?|entrevistas?|behind[ ._-]?the[ ._-]?scenes|trailers?|deleted[ ._-]?scenes?|cenas[ ._-]?deletadas|bloopers?|gags?|making[ ._-]?of)([^a-z]|$)/i;
function baseName(p: string) { return String(p || '').split(/[/\\]/).pop() || ''; }
const SITE_AD = /^(?:www[\s._-]+)?[a-z0-9][a-z0-9-]*\.(?:com|net|org|tv|to|me|cc|info|xyz|biz|br|io|se|ws)(?:\.[a-z]{2})?$/i;
function isSiteAd(path: string) {
  const name = baseName(path).replace(/\.[a-z0-9]{2,4}$/i, '');
  return SITE_AD.test(name.replace(/^[\s[\](){}._-]+|[\s[\](){}._-]+$/g, ''));
}

const WORK_COVERAGE_MIN = 0.7;
function workCoverage(fileName: string, name: string) {
  const tokens = normalizeTitle(name).split(' ').filter(Boolean);
  const longTokens = tokens.filter((w) => w.length > 2);
  const wanted = longTokens.length > 0 ? longTokens : tokens;
  if (wanted.length === 0) return 0;
  const bnGot = new Set(normalizeTitle(baseName(fileName)).split(' ').filter(Boolean));
  const bnHits = wanted.filter((w) => bnGot.has(w)).length;
  if (bnHits > 0) return bnHits / wanted.length;
  const fullGot = new Set(normalizeTitle(fileName).split(' ').filter(Boolean));
  return wanted.filter((w) => fullGot.has(w)).length / wanted.length;
}
function looksMultiWorkFiles(files: DebridFile[]) {
  const mains = files.filter((f) => VIDEO_EXT.test(f.path || '') && !SAMPLE.test(f.path || '') && !EXTRA.test(f.path || ''));
  if (mains.length <= 1) return false;
  const years = new Set<number>();
  for (const file of mains) {
    const match = String(baseName(file.path || '') || '').match(/(?:^|[^0-9])((?:19|20)\d{2})(?:$|[^0-9])/);
    if (match) years.add(Number(match[1]));
  }
  return years.size >= 2;
}
function pickWorkFile(files: DebridFile[], { names, year }: { names?: string[]; year?: number | string | null } = {}) {
  const cleanYear = Number(String(year || '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  const scored = files.map((file) => ({ file, cov: Math.max(...(names || []).map((name) => workCoverage(file.path || '', name))) })).filter((item) => item.cov >= WORK_COVERAGE_MIN);
  if (scored.length === 0) return null;
  if (scored.length === 1) return scored[0].file;
  if (cleanYear) {
    const yearRe = new RegExp(`(?<!\\d)${cleanYear}(?!\\d)`);
    const withYear = scored.filter((item) => yearRe.test(baseName(item.file.path || '')));
    if (withYear.length === 1) return withYear[0].file;
    if (withYear.length > 1) return withYear.reduce((a, b) => (Number(b.file.size || 0) > Number(a.file.size || 0) ? b : a)).file;
  }
  return null;
}
function pickFile(files: DebridFile[], { season, episode, work }: PlayHint = {}) {
  let videos = files.filter((file) => VIDEO_EXT.test(file.path || '') && !SAMPLE.test(file.path || ''));
  if (videos.length === 0) {
    if (files.length > 0) throw new NoVideoError();
    return null;
  }
  const semPropaganda = videos.filter((file) => !isSiteAd(file.path || ''));
  if (semPropaganda.length > 0 && semPropaganda.length < videos.length) videos = semPropaganda;
  if (season != null && episode != null) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const seasonForms = `(?:${s}|${season})`;
    const episodeForms = `(?:0{0,2}${episode})`;
    const pathHasSeason = (path: string) => new RegExp(`(?:\\bs${seasonForms}(?!\\d)|\\bt${seasonForms}(?!\\d)|\\bseason[\\s._-]*${seasonForms}(?!\\d)|\\b${seasonForms}x|\\b(?:temp|temporada)[\\s._-]*${seasonForms}(?!\\d)|\\b${seasonForms}ª?[\\s._-]*(?:temp|temporada)\\b)`, 'i').test(path);
    const pathHasAnySeason = /(?:\b[st]\d{1,2}(?!\d)|\bseason[\s._-]*\d|\b\d{1,2}x\d{1,2}\b|\b(?:temp|temporada)[\s._-]*\d|\b\d{1,2}ª?[\s._-]*(?:temp|temporada)\b)/i;
    const strongPatterns = [new RegExp(`\\bs${seasonForms}[\\s._-]*e${episodeForms}\\b`, 'i'), new RegExp(`\\bt${seasonForms}[\\s._-]*e${episodeForms}\\b`, 'i'), new RegExp(`\\b${seasonForms}x${episodeForms}\\b`, 'i'), new RegExp(`\\b${s}${e}\\b`)];
    const weakPatterns = [new RegExp(`\\b(?:epis[oó]dio|cap[ií]tulo|ep|cap)[\\s._-]*0{0,2}${episode}\\b`, 'i'), new RegExp(`\\be[\\s._-]*0{0,2}${episode}\\b`, 'i')];
    const bareEpisode = new RegExp(`(?:^|[\\s._-])0{0,2}${episode}(?:[\\s._-]|$|\\.[a-z0-9]+$)`, 'i');
    const epPath = (path: string) => path.replace(/(?<![\dst])[125678]\.[012](?!\d)/gi, ' ');
    const strong = videos.filter((file) => { const path = file.path || ''; const clean = epPath(path); return strongPatterns.some((pattern) => pattern.test(path)) || (pathHasSeason(path) && (weakPatterns.some((pattern) => pattern.test(clean)) || bareEpisode.test(clean))); });
    if (strong.length > 0) return strong[0];
    const ambiguousSeason = videos.some((file) => { const path = file.path || ''; return pathHasAnySeason.test(path) && !pathHasSeason(path); });
    if (!ambiguousSeason) {
      const weak = videos.find((file) => weakPatterns.some((pattern) => pattern.test(epPath(file.path || ''))));
      if (weak) return weak;
    }
    if (videos.length > 1) throw new EpisodePickError(undefined, { videoCount: videos.length, samples: videos.slice(0, 3).map((video) => baseName(video.path || '').slice(0, 70)) });
    const singleName = baseName(videos[0].path || '').replace(/\b\d{3,4}x\d{3,4}\b/g, ' ').replace(/[a-z]s\d{1,2}(?![\de])/gi, ' ');
    const declared = parseTitleSeasonEpisode(singleName);
    if (!declared.complete || declared.seasons.length > 0) {
      const wrongEpisode = declared.episodes.length > 0 && !declared.episodes.includes(episode);
      const wrongSeason = declared.seasons.length > 0 && !declared.seasons.includes(season);
      if (wrongEpisode || wrongSeason) throw new EpisodePickError({ wantedSeason: season, wantedEpisode: episode, declaredSeasons: [...declared.seasons], declaredEpisodes: [...declared.episodes], sample: baseName(videos[0].path || '').slice(0, 60) });
    }
  }
  if (work?.names?.length) {
    const mains = videos.filter((file) => !EXTRA.test(file.path || ''));
    const pool = mains.length > 0 ? mains : videos;
    if (pool.length === 1) return pool[0];
    if (!work.pack && !looksMultiWorkFiles(pool)) return pool.reduce((a, b) => (Number(b.size || 0) > Number(a.size || 0) ? b : a));
    const picked = pickWorkFile(pool, work);
    if (picked) return picked;
    throw new WorkPickError();
  }
  return videos.reduce((a, b) => (Number(b.size || 0) > Number(a.size || 0) ? b : a));
}

export { WorkPickError, isWorkPickError, EpisodePickError, isEpisodePickError, NoVideoError, isNoVideoError, DubLieError, isDubLieError, VIDEO_EXT, SAMPLE, EXTRA, isSiteAd, baseName, workCoverage, looksMultiWorkFiles, pickWorkFile, pickFile };
