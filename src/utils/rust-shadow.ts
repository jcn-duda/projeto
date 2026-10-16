/**
 * Shadow em lote do núcleo Rust (`evaluateReleases`, `rust/crates/adom-napi`).
 *
 * Por busca, o TS calcula o veredito de cada release bruta e o Rust calcula o
 * mesmo em UMA chamada napi. Divergências viram métrica (`rust.batch.*`) e log.
 * Nunca responde nada: a resposta é sempre a do TS.
 *
 * Roda com `setImmediate`, fora do caminho da resposta. Em `RUST_CORE=off`, ou
 * sem o núcleo carregado, é no-op. Em `on` o Rust DECIDE: o filtro de relevância
 * chama o preparador (`primerFor`) e as funções de base leem os vereditos de
 * `rust-verdict-memo.ts`; a comparação deixa de rodar.
 */
import config from '../config.js';
import type { RawItem } from '../../types/domain.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';
import { getCore, getMode } from './rust-core.js';
import type { BatchCore } from './rust-core.js';
import { extractInfoHash, magnetDisplayName, normalizeTitle } from './title-normalization.js';
import { hasPtSigns, brOriginMark } from './br-origin.js';
import { parseTitleSeasonEpisode } from './episode-matching.js';
import { matchesBrTitle as matchesBrTitleRule } from './release-title-rules.js';
import { isSafeDownloadUrl } from './net-safety.js';
import {
  brTitleKey, installVerdictPrimer, knownBrTitle, rememberBrTitle, rememberLink, rememberMagnet, rememberTitle,
} from './rust-verdict-memo.js';
import type { VerdictPrimer } from './rust-verdict-memo.js';

/** Entrada de um release bruta; "" = ausente (mesmo contrato do napi). */
export interface ReleaseProbe {
  title: string;
  magnet: string;
  link: string;
  name: string;
  year: string;
  isSeries: boolean;
  allNames: string[];
  cutTail: boolean;
}

/** Veredito por release. O TS e o Rust têm que produzir exatamente o mesmo. */
export interface ReleaseVerdict {
  normalized: string;
  hasPtSigns: boolean;
  brOriginMark: boolean;
  infoHash: string | null;
  displayName: string;
  seasons: number[];
  episodes: number[];
  complete: boolean;
  seasonPack: boolean;
  matchesBrTitle: boolean;
  safeLink: boolean;
}

export interface ShadowDiff {
  field: string;
  index: number;
  title: string;
  ts: unknown;
  rust: unknown;
}

export interface ShadowContext {
  names: string[];
  year: string | number | null | undefined;
  isSeries: boolean;
}

const FIELDS: ReadonlyArray<keyof ReleaseVerdict> = [
  'normalized', 'hasPtSigns', 'brOriginMark', 'infoHash', 'displayName', 'seasons',
  'episodes', 'complete', 'seasonPack', 'matchesBrTitle', 'safeLink',
];

let warnedNoEvaluate = false;
let loggedBatchDiffs = 0;

/** Converte os itens brutos em probes, até `max`. Só lê campos: não altera nada. */
export function buildProbes(items: RawItem[], ctx: ShadowContext, max: number): ReleaseProbe[] {
  const name = ctx.names[0] || '';
  const year = ctx.year == null ? '' : String(ctx.year);
  const cutTail = config.search?.titlePrecisionTailCut !== false;
  const out: ReleaseProbe[] = [];
  for (const item of items) {
    if (out.length >= max) break;
    const guid = item.Guid || '';
    out.push({
      title: item.title || item.Title || '',
      magnet: item.magnet || item.MagnetUri || '',
      link: guid && /^https?:/i.test(guid) ? guid : '',
      name,
      year,
      isSeries: ctx.isSeries,
      allNames: ctx.names,
      cutTail,
    });
  }
  return out;
}

/** Veredito calculado pelo TS (o `normalized` já vem do Rust: normalizeTitle é só Rust). */
export function tsVerdict(p: ReleaseProbe): ReleaseVerdict {
  const parsed = parseTitleSeasonEpisode(p.title);
  return {
    normalized: normalizeTitle(p.title),
    hasPtSigns: hasPtSigns(p.title),
    brOriginMark: brOriginMark(p.title),
    infoHash: extractInfoHash(p.magnet) ?? null,
    displayName: magnetDisplayName({ magnet: p.magnet }),
    seasons: [...parsed.seasons],
    episodes: [...parsed.episodes],
    complete: parsed.complete,
    seasonPack: parsed.seasonPack,
    matchesBrTitle: p.name
      ? matchesBrTitleRule(p.title, p.name, p.year || null, {
        isSeries: p.isSeries,
        allNames: p.allNames.length ? p.allNames : null,
      })
      : false,
    safeLink: p.link ? isSafeDownloadUrl(p.link) : false,
  };
}

/** Compara campo a campo (JSON.stringify). Tamanhos diferentes viram `__length__`. */
export function compareBatch(
  probes: ReleaseProbe[],
  ts: ReleaseVerdict[],
  rust: ReleaseVerdict[],
): ShadowDiff[] {
  const diffs: ShadowDiff[] = [];
  if (ts.length !== rust.length) {
    diffs.push({ field: '__length__', index: -1, title: '', ts: ts.length, rust: rust.length });
  }
  const n = Math.min(ts.length, rust.length);
  for (let i = 0; i < n; i += 1) {
    for (const field of FIELDS) {
      // `?? null`: o napi entrega Option::None como campo AUSENTE (undefined), o
      // TS como null — mesma ausência, não divergência (infoHash sem magnet).
      const a = JSON.stringify(ts[i][field] ?? null);
      const b = JSON.stringify(rust[i]?.[field] ?? null);
      if (a !== b) diffs.push({ field, index: i, title: probes[i]?.title ?? '', ts: ts[i][field], rust: rust[i]?.[field] });
    }
  }
  return diffs;
}

function logDiff(d: ShadowDiff) {
  if (loggedBatchDiffs >= config.rustCore.maxLoggedDiffs) return;
  loggedBatchDiffs += 1;
  log.warn(
    `[rust] lote divergiu: campo=${d.field} indice=${d.index} titulo=${JSON.stringify(d.title)} ts=${JSON.stringify(d.ts)} rust=${JSON.stringify(d.rust)}`,
  );
}

function runBatch(core: BatchCore, items: RawItem[], ctx: ShadowContext) {
  try {
    const probes = buildProbes(items, ctx, config.rustCore.shadowMaxPerSearch);
    if (!probes.length) return;
    const ts = probes.map(tsVerdict);
    metrics.count('rust.batch.calls');
    metrics.count('rust.batch.items', probes.length);
    const rust = core.evaluateReleases(probes);
    if (!Array.isArray(rust)) throw new Error('evaluateReleases não devolveu lista');
    const diffs = compareBatch(probes, ts, rust);
    if (diffs.length) metrics.count('rust.batch.diff', diffs.length);
    for (const d of diffs) logDiff(d);
  } catch (err) {
    metrics.count('rust.batch.error');
    log.debug('[rust] shadow em lote lançou:', log.errorMessage(err));
  }
}

/**
 * Preparador do `on`: um lote napi por chamada do filtro, com os vereditos
 * gravados em `rust-verdict-memo.ts`. O filtro só pergunta `matchesBrTitle`
 * de item BR, então só o BR vai uma vez por nome; o resto vai uma vez (o napi
 * custa dezenas de µs por release). Chave já calculada ou repetida no lote não
 * volta ao Rust.
 */
export function primerFor(core: BatchCore): VerdictPrimer {
  return (items, names, year, isSeries) => {
    const yearText = year == null ? '' : String(year);
    const cutTail = config.search?.titlePrecisionTailCut !== false;
    const allNames = [...names];
    const probes: ReleaseProbe[] = [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const [n, name] of names.entries()) {
      for (const item of items) {
        if (n > 0 && !item.isBr) continue;
        const title = item.title || item.Title || '';
        const key = brTitleKey(title, name, year, isSeries, allNames);
        const dedupe = `${key}\u0000${item.magnet || item.MagnetUri || ''}\u0000${item.Guid || ''}`;
        if (seen.has(dedupe) || knownBrTitle(key)) continue;
        seen.add(dedupe);
        const guid = item.Guid || '';
        const link = guid && /^https?:/i.test(guid) ? guid : '';
        probes.push({ title, magnet: item.magnet || item.MagnetUri || '', link, name, year: yearText, isSeries, allNames, cutTail });
        keys.push(key);
      }
    }
    if (!probes.length) return;
    metrics.count('rust.batch.calls');
    metrics.count('rust.batch.items', probes.length);
    const out = core.evaluateReleases(probes);
    if (!Array.isArray(out) || out.length !== probes.length) throw new Error('evaluateReleases devolveu lote de tamanho errado');
    probes.forEach((p, i) => {
      const v = out[i];
      rememberTitle(p.title, {
        hasPtSigns: Boolean(v.hasPtSigns),
        brOriginMark: Boolean(v.brOriginMark),
        seasons: v.seasons || [],
        episodes: v.episodes || [],
        complete: Boolean(v.complete),
        seasonPack: Boolean(v.seasonPack),
      });
      // `?? null`/`?? ''`: o napi entrega Option::None como campo ausente.
      rememberMagnet(p.magnet, v.infoHash ?? null, v.displayName ?? '');
      rememberLink(p.link, Boolean(v.safeLink));
      if (p.name) rememberBrTitle(keys[i], Boolean(v.matchesBrTitle));
    });
  };
}

/**
 * Boot do processo: com `RUST_CORE=on` e o núcleo carregado, o lote Rust passa
 * a decidir os vereditos dos filtros. Binário sem `evaluateReleases` = TS.
 */
export function installBatchDecisions(): void {
  const core = getMode() === 'on' ? getCore() : null;
  if (!core || typeof core.evaluateReleases !== 'function') {
    installVerdictPrimer(null);
    return;
  }
  installVerdictPrimer(primerFor({ evaluateReleases: core.evaluateReleases.bind(core) }));
  log.info('[rust] vereditos de release em modo on (lote por filtro)');
}

/**
 * Agenda o shadow em lote da busca. Copia as referências já aqui (o pipeline
 * pode mexer nos itens depois), mas monta probes e chama o Rust só depois.
 * Em `on` o Rust já decidiu no filtro: comparar mediria o Rust contra ele mesmo.
 */
export function observe(items: RawItem[], ctx: ShadowContext): void {
  try {
    if (getMode() !== 'shadow') return;
    const core = getCore();
    if (!core) return;
    if (typeof core.evaluateReleases !== 'function') {
      if (!warnedNoEvaluate) {
        warnedNoEvaluate = true;
        log.info('[rust] núcleo sem evaluateReleases (binário antigo); shadow em lote desligado');
      }
      return;
    }
    const batch = items.slice();
    const snapshot: ShadowContext = { names: ctx.names.slice(), year: ctx.year, isSeries: ctx.isSeries };
    const bound: BatchCore = { evaluateReleases: core.evaluateReleases.bind(core) };
    setImmediate(() => runBatch(bound, batch, snapshot));
  } catch (err) {
    metrics.count('rust.batch.error');
    log.debug('[rust] shadow em lote não agendou:', log.errorMessage(err));
  }
}
