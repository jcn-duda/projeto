/**
 * Sombra do `pickFile` (`RUST_DEBRID_FILE`). O Node continua dono da lista e
 * dos erros; o Rust só escolhe de novo a mesma lista. Não apaga magnet e não
 * chama API — uma segunda ida à conta seria o bug que esta fase evita.
 *
 * O gancho mora aqui, e não em cada `*-play.ts`: todo play e os medidores já
 * passam pelo `pickFile` exportado. Um gancho só.
 */
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';
import {
  installPickFile,
  EpisodePickError,
  NoVideoError,
  WorkPickError,
} from '../debrid/file-selector.js';
import type { DebridFile } from '../debrid/file-selector.js';
import type { PlayHint } from '../../types/domain.js';

export type DebridPickFileIn = { path?: string; size?: number };

export type DebridPickHint = {
  season?: number | null;
  episode?: number | null;
  work?: { names?: string[]; year?: number | null; pack?: boolean } | null;
};

export type DebridPickEvidence = {
  wantedSeason: number;
  wantedEpisode: number;
  declaredSeasons: number[];
  declaredEpisodes: number[];
  sample?: string | null;
};

export type DebridPickContext = {
  videoCount: number;
  samples: string[];
};

export type DebridPickResult = {
  kind?: string;
  path?: string | null;
  size?: number | null;
  code?: string | null;
  evidence?: DebridPickEvidence | null;
  context?: DebridPickContext | null;
};

export type PickCore = {
  pickFile(files: DebridPickFileIn[], hint?: DebridPickHint): DebridPickResult;
};

type CoreWithPick = { pickFile?: PickCore['pickFile'] };

type TsRun =
  | { ok: true; value: DebridFile | null }
  | { ok: false; error: unknown };

type Decision =
  | { kind: 'file'; path: string; size: number }
  | { kind: 'null' }
  | { kind: 'error'; code: string; evidence: unknown; context: unknown };

let loggedDiffs = 0;
let loggedMissing = false;

function sameList(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function sameEvidence(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  const left = a as DebridPickEvidence;
  const right = b as DebridPickEvidence;
  return left.wantedSeason === right.wantedSeason
    && left.wantedEpisode === right.wantedEpisode
    && sameList(left.declaredSeasons, right.declaredSeasons)
    && sameList(left.declaredEpisodes, right.declaredEpisodes)
    && (left.sample ?? null) === (right.sample ?? null);
}

function sameContext(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  const left = a as DebridPickContext;
  const right = b as DebridPickContext;
  return left.videoCount === right.videoCount && sameList(left.samples, right.samples);
}

function sameDecision(left: Decision, right: Decision): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'null' && right.kind === 'null') return true;
  if (left.kind === 'file' && right.kind === 'file') return left.path === right.path && left.size === right.size;
  if (left.kind === 'error' && right.kind === 'error') {
    return left.code === right.code && sameEvidence(left.evidence, right.evidence) && sameContext(left.context, right.context);
  }
  return false;
}

function decisionOfTs(run: TsRun): Decision {
  if (!run.ok) {
    const err = run.error as { code?: string; evidence?: unknown; context?: unknown };
    return {
      kind: 'error',
      code: String(err?.code || ''),
      evidence: err?.evidence === undefined ? null : err.evidence,
      context: err?.context === undefined ? null : err.context,
    };
  }
  if (run.value == null) return { kind: 'null' };
  return { kind: 'file', path: String(run.value.path || ''), size: Number(run.value.size || 0) };
}

function decisionOfRust(raw: DebridPickResult | null | undefined): Decision | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'null') return { kind: 'null' };
  if (raw.kind === 'file') return { kind: 'file', path: String(raw.path || ''), size: Number(raw.size || 0) };
  if (raw.kind === 'error' && raw.code) {
    return { kind: 'error', code: String(raw.code), evidence: raw.evidence ?? null, context: raw.context ?? null };
  }
  return null;
}

function labelOf(decision: Decision): string {
  if (decision.kind === 'file') return decision.path;
  if (decision.kind === 'null') return 'null';
  const evidence = decision.evidence as { sample?: string } | null;
  const sample = evidence?.sample ? `:${evidence.sample}` : '';
  return `${decision.code}${sample}`;
}

function logDiff(ts: Decision, rust: Decision) {
  metrics.count('rust.debrid.pick.diff');
  if (loggedDiffs >= config.rustCore.maxLoggedDiffs) return;
  loggedDiffs += 1;
  log.warn(`[rust] pickFile divergiu: ts=${labelOf(ts)} rust=${labelOf(rust)}`);
}

function noteMissing() {
  if (loggedMissing) return;
  loggedMissing = true;
  log.warn('[rust] pickFile ausente no núcleo; seguindo só com TS');
}

function toFiles(files: DebridFile[]): DebridPickFileIn[] {
  return files.map((file) => ({ path: String(file?.path || ''), size: Number(file?.size || 0) }));
}

function toHint(hint: PlayHint | undefined): DebridPickHint {
  const out: DebridPickHint = {};
  if (hint?.season != null) out.season = hint.season;
  if (hint?.episode != null) out.episode = hint.episode;
  if (hint?.work) {
    out.work = {};
    if (hint.work.names) out.work.names = hint.work.names;
    if (hint.work.year != null) out.work.year = hint.work.year;
    if (hint.work.pack != null) out.work.pack = hint.work.pack;
  }
  return out;
}

function replay(run: TsRun): DebridFile | null {
  if (!run.ok) throw run.error;
  return run.value;
}

function episodeFrom(evidence: unknown, context: unknown): EpisodePickError {
  const ev = evidence as DebridPickEvidence | null;
  const ctx = context as DebridPickContext | null;
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

function materialize(files: DebridFile[], raw: DebridPickResult): DebridFile | null {
  const decision = decisionOfRust(raw);
  if (!decision) throw new Error('pickFile do Rust veio quebrado');
  if (decision.kind === 'null') return null;
  if (decision.kind === 'file') {
    // O play precisa do objeto original (`id`, `link`). Path+tamanho identificam
    // o vencedor; empate de tamanho fica com o primeiro, como o reduce do TS.
    const found = files.find((file) => String(file?.path || '') === decision.path && Number(file?.size || 0) === decision.size);
    if (!found) throw new Error('pickFile do Rust não casa com a lista');
    return found;
  }
  if (decision.code === 'NO_VIDEO') throw new NoVideoError();
  if (decision.code === 'WORK_PICK') throw new WorkPickError();
  if (decision.code === 'EPISODE_PICK') throw episodeFrom(decision.evidence, decision.context);
  throw new Error(`pickFile do Rust devolveu código ${decision.code}`);
}

function isDomainPickError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'NO_VIDEO' || code === 'EPISODE_PICK' || code === 'WORK_PICK';
}

function captureTs(files: DebridFile[], hint: PlayHint | undefined, ts: (files: DebridFile[], hint?: PlayHint) => DebridFile | null): TsRun {
  try {
    return { ok: true, value: ts(files, hint) };
  } catch (error) {
    return { ok: false, error };
  }
}

function shadowPick(getCore: () => CoreWithPick | null, files: DebridFile[], hint: PlayHint | undefined, ts: (files: DebridFile[], hint?: PlayHint) => DebridFile | null): DebridFile | null {
  const mode = config.rustDebrid.file;
  if (mode === 'off') return ts(files, hint);
  const pick = getCore()?.pickFile;
  if (typeof pick !== 'function') {
    noteMissing();
    return ts(files, hint);
  }
  metrics.count('rust.debrid.pick.calls');
  if (mode === 'shadow') {
    const run = captureTs(files, hint, ts);
    try {
      const got = decisionOfRust(pick(toFiles(files), toHint(hint)));
      if (!got) metrics.count('rust.debrid.pick.error');
      else if (!sameDecision(decisionOfTs(run), got)) logDiff(decisionOfTs(run), got);
    } catch (err) {
      metrics.count('rust.debrid.pick.error');
      log.debug('[rust] pickFile lançou:', log.errorMessage(err));
    }
    return replay(run);
  }
  try {
    return materialize(files, pick(toFiles(files), toHint(hint)));
  } catch (err) {
    // Erro de domínio reconstruído é a resposta do Rust. Quebra/throw cai no TS.
    if (isDomainPickError(err)) throw err;
    metrics.count('rust.debrid.pick.error');
    log.debug('[rust] pickFile lançou; usando TS:', log.errorMessage(err));
    return ts(files, hint);
  }
}

/** Liga o gancho. `getCore` é lido a cada chamada, para o teste injetar stub. */
function installDebridPickHook(getCore: () => CoreWithPick | null) {
  installPickFile((files, hint, ts) => shadowPick(getCore, files, hint, ts));
}

/** Só para teste: tira o gancho. O boot real não chama isto. */
function resetDebridPickHook() {
  installPickFile(null);
  loggedDiffs = 0;
  loggedMissing = false;
}

export { installDebridPickHook, resetDebridPickHook };
