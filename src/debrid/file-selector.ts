import { normalizeTitle } from '../utils/format.js';
import { requireCore } from '../utils/rust-core.js';
import * as metrics from '../utils/metrics.js';
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
const SITE_AD_DOMAIN = '[a-z0-9][a-z0-9-]*\\.(?:com|net|org|tv|to|me|cc|info|xyz|biz|br|io|se|ws)(?:\\.[a-z]{2})?';
const SITE_AD = new RegExp(`^(?:www[\\s._-]+)?${SITE_AD_DOMAIN}$`, 'i');
// O nome do arquivo é SÓ o domínio ("www.BLUDV.com.mp4"), ou o domínio abre o
// nome e o resto é a propaganda ("1XBET.COM_promo_SHREK_dinheiro_livre.mp4",
// medido num pack real de House of the Dragon). O separador depois do TLD é
// `_`/`-`/espaço de propósito, NUNCA ponto: com ponto, "Filme.se.algo.mkv"
// (nome legítimo com um token que por acaso é TLD) seria classificado como
// propaganda e o arquivo real sairia do pool.
const SITE_AD_PREFIX = new RegExp(`^(?:www[\\s._-]+)?${SITE_AD_DOMAIN}[\\s_-]`, 'i');
function isSiteAd(path: string) {
  const name = baseName(path).replace(/\.[a-z0-9]{2,4}$/i, '');
  const trimmed = name.replace(/^[\s[\](){}._-]+|[\s[\](){}._-]+$/g, '');
  return SITE_AD.test(trimmed) || SITE_AD_PREFIX.test(trimmed);
}

const WORK_COVERAGE_MIN = 0.7;
// Ano que o NOME do arquivo declara. Só basename: um ano na pasta costuma ser
// da coleção ("Trilogia (2009-2011)/…"), não da release individual.
function declaredYears(filePath: string) {
  // 1920x1080/2048x1080 são dimensões, não anos declarados.
  const matches = String(baseName(filePath) || '').matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?![xX×]\d)(?=$|[^0-9])/g);
  return [...matches].map((match) => Number(match[1]));
}

function workCoverage(fileName: string, name: string) {
  const tokens = normalizeTitle(name).split(' ').filter(Boolean);
  const longTokens = tokens.filter((w) => w.length > 2);
  const wanted = longTokens.length > 0 ? longTokens : tokens;
  if (wanted.length === 0) return 0;
  // Caminho inteiro: a pasta COMPLETA o nome do arquivo. Medido na coleção
  // "FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR/13 - Jornada nas
  // Estrelas - Sem Fronteiras - 2016.mp4" (2026-09-14): "star trek" só existe
  // na pasta e "sem fronteiras" só no arquivo. Contar só o basename quando ele
  // tinha ALGUM token dava 2/4 para "Star Trek: Sem Fronteiras", abaixo do
  // mínimo, e o filme ficava sem escolha — WorkPickError no play e sem tamanho
  // na lista. O ANO continua vindo só do basename (`declaredYears`), então a
  // faixa de anos da pasta segue sem contaminar o desempate.
  const fullGot = new Set(normalizeTitle(fileName).split(' ').filter(Boolean));
  return wanted.filter((w) => fullGot.has(w)).length / wanted.length;
}
function looksMultiWorkFiles(files: DebridFile[]) {
  const mains = files.filter((f) => VIDEO_EXT.test(f.path || '') && !SAMPLE.test(f.path || '') && !EXTRA.test(f.path || ''));
  if (mains.length <= 1) return false;
  const years = new Set<number>();
  for (const file of mains) {
    // Preserve o contrato anterior: múltiplos anos no mesmo basename são
    // ambíguos e não transformam, sozinhos, um conjunto de encodes em pack.
    const [year] = declaredYears(file.path || '');
    if (year != null) years.add(year);
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
// ── Escolha do arquivo: decidida no Rust (`pickFile` do adom-napi) ─────────
// O TS da regra saiu do branch (oráculo no `esm`). Aqui só se traduz a lista e
// a dica, e a resposta volta para o objeto ORIGINAL da lista (o play precisa
// de `id`/`link`) ou para o erro de domínio que os plays já tratam.

type PickHintNapi = {
  season?: number;
  episode?: number;
  work?: { names?: string[]; year?: number; pack?: boolean };
};

type PickEvidenceNapi = {
  wantedSeason: number;
  wantedEpisode: number;
  declaredSeasons?: number[];
  declaredEpisodes?: number[];
  sample?: string | null;
};

type PickResultNapi = {
  kind?: string;
  path?: string | null;
  size?: number | null;
  code?: string | null;
  evidence?: PickEvidenceNapi | null;
  context?: { videoCount: number; samples?: string[] } | null;
};

export type PickCore = {
  pickFile(files: Array<{ path: string; size: number }>, hint?: PickHintNapi): PickResultNapi;
};

// O napi-rs só aceita campo omitido em `Option`: nulos ficam de fora.
function toHint(hint: PlayHint | undefined): PickHintNapi {
  const out: PickHintNapi = {};
  if (hint?.season != null) out.season = hint.season;
  if (hint?.episode != null) out.episode = hint.episode;
  if (hint?.work) {
    out.work = {};
    if (hint.work.names) out.work.names = hint.work.names;
    if (hint.work.year != null) out.work.year = Number(hint.work.year);
    if (hint.work.pack != null) out.work.pack = hint.work.pack;
  }
  return out;
}

function episodeErrorOf(raw: PickResultNapi): EpisodePickError {
  const ev = raw.evidence;
  const ctx = raw.context;
  return new EpisodePickError(
    ev == null ? undefined : {
      wantedSeason: ev.wantedSeason,
      wantedEpisode: ev.wantedEpisode,
      declaredSeasons: ev.declaredSeasons ?? [],
      declaredEpisodes: ev.declaredEpisodes ?? [],
      ...(ev.sample != null ? { sample: ev.sample } : {}),
    },
    ctx == null ? undefined : { videoCount: ctx.videoCount, samples: ctx.samples ?? [] },
  );
}

/**
 * Arquivo que o play toca. `null` = lista vazia; lança `NoVideoError`,
 * `WorkPickError` ou `EpisodePickError` como antes.
 */
function pickFile(files: DebridFile[], hint?: PlayHint): DebridFile | null {
  const core = requireCore() as unknown as PickCore;
  metrics.count('rust.debrid.pick.calls');
  const list = files.map((file) => ({ path: String(file?.path || ''), size: Number(file?.size || 0) }));
  const raw = core.pickFile(list, toHint(hint));
  if (raw?.kind === 'null') return null;
  if (raw?.kind === 'file') {
    // Path+tamanho identificam o vencedor; empate fica com o primeiro da lista.
    const path = String(raw.path || '');
    const size = Number(raw.size || 0);
    const found = files.find((file) => String(file?.path || '') === path && Number(file?.size || 0) === size);
    if (!found) throw new Error('pickFile do Rust não casa com a lista');
    return found;
  }
  if (raw?.kind === 'error') {
    if (raw.code === 'NO_VIDEO') throw new NoVideoError();
    if (raw.code === 'WORK_PICK') throw new WorkPickError();
    if (raw.code === 'EPISODE_PICK') throw episodeErrorOf(raw);
  }
  throw new Error(`pickFile do Rust devolveu resposta inválida (${String(raw?.kind)}:${String(raw?.code)})`);
}

export { WorkPickError, isWorkPickError, EpisodePickError, isEpisodePickError, NoVideoError, isNoVideoError, DubLieError, isDubLieError, VIDEO_EXT, SAMPLE, EXTRA, isSiteAd, baseName, workCoverage, looksMultiWorkFiles, pickWorkFile, pickFile };
