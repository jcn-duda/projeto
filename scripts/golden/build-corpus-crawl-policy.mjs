#!/usr/bin/env node
/**
 * Constrói o corpus do golden `crawl-policy` de forma REPRODUTÍVEL.
 *
 * O corpus é entrada do gerador (nunca do oráculo): cada caso é um `input` JSON
 * com `op` e parâmetros, cobrindo os 7 módulos de política (C2) — ciclo, taxa,
 * pausas, vista de status, config ao vivo e a seleção/despacho de sites. Rodar
 * `node scripts/golden/build-corpus-crawl-policy.mjs` regrava
 * `corpus-crawl-policy.json` (ordem determinística; nenhum timestamp).
 *
 * Cobertura POR OP é travada fail-closed em `crawl-policy-validation.mjs`; este
 * builder não é a garantia — só a fonte.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts', 'golden', 'corpus-crawl-policy.json');

const cases = [];
const add = (id, op, rest = {}) => cases.push({ id, input: JSON.stringify({ op, ...rest }) });

// ---- base: config e runtime reutilizáveis ----------------------------------
const baseConfig = (over = {}) => ({
  enabled: true, dryRun: false, delayMs: 1000, maxPerHour: 1500, idleWindowMs: 600000,
  maxTries: 3, errorPauseStreak: 5, layoutCanary: 10, incrementalIntervalMin: 60,
  seriesEnabled: true, seriesMaxCards: 10, seriesMaxButtons: 40, requireProbe: false,
  overridden: [], ...over,
});
const baseRuntime = (id, over = {}) => ({
  id, paused: false, autoPause: null, openRunId: null, needSimulatedRecovery: false,
  needInflightRecovery: false, nextDiscoverAt: 0, lastActiveAt: 0, adapterFailedAt: 0,
  skipReason: null, hourPages: 0, ...over,
});
const counters = (total, pending, error, inflight, partial) => ({
  total, byStatus: { pending, error, inflight, partial },
});
const live = (over = {}) => ({
  enabled: true, dryRun: false, delayMs: 1000, maxPerHour: 1500, idleWindowMs: 600000,
  maxTries: 3, errorPauseStreak: 5, layoutCanary: 10, incrementalIntervalMin: 60,
  seriesEnabled: true, seriesMaxCards: 10, seriesMaxButtons: 40, requireProbe: false,
  sites: ['vacatorrent'], siteOverrides: {}, ...over,
});

// ---- crawl-cycle -----------------------------------------------------------
add('cycle-fresh', 'freshCycle');

// ---- crawler-live: clamps (sanitizePatch é a única fonte viva dos clamps) --
const clamps = {
  delayMs: [-1, 0, 999, 60000, 60001],
  maxPerHour: [0, 1, 10000, 10001, 20000, 20001],
  idleWindowMs: [-1, 0, 600000, 3600000, 3600001],
  maxTries: [0, 3, 10, 11],
  errorPauseStreak: [0, 5, 100, 101],
  layoutCanary: [0, 10, 100, 101, 1000, 1001],
  incrementalIntervalMin: [0, 60, 1440, 1441],
  seriesMaxCards: [0, 10, 50, 51, 100, 101],
  seriesMaxButtons: [0, 40, 200, 201],
};
for (const [key, values] of Object.entries(clamps)) {
  for (const v of values) add(`clamp-${key}-${v}`, 'clamp', { key, v });
}

// ---- crawler-live: fusão por site e trava de segurança ---------------------
add('cfg-in-sites', 'siteConfigOf', { live: live(), siteId: 'vacatorrent' });
add('cfg-not-in-sites', 'siteConfigOf', { live: live(), siteId: 'nerdfilmes' });
add('cfg-over-enabled', 'siteConfigOf', { live: live(), siteId: 'nerdfilmes', override: { enabled: true } });
add('cfg-over-disabled', 'siteConfigOf', { live: live(), siteId: 'vacatorrent', override: { enabled: false } });
add('cfg-over-dryrun', 'siteConfigOf', { live: live(), siteId: 'vacatorrent', override: { dryRun: true } });
add('cfg-over-delay-lower-locked', 'siteConfigOf', { live: live({ delayMs: 2000 }), siteId: 'vacatorrent', override: { delayMs: 500 } });
add('cfg-over-delay-higher', 'siteConfigOf', { live: live({ delayMs: 1000 }), siteId: 'vacatorrent', override: { delayMs: 3000 } });
add('cfg-over-cap-higher-locked', 'siteConfigOf', { live: live({ maxPerHour: 1500 }), siteId: 'vacatorrent', override: { maxPerHour: 9000 } });
add('cfg-over-cap-lower', 'siteConfigOf', { live: live({ maxPerHour: 1500 }), siteId: 'vacatorrent', override: { maxPerHour: 300 } });
add('cfg-over-out-of-range', 'siteConfigOf', { live: live(), siteId: 'vacatorrent', override: { delayMs: 999999, maxPerHour: 50000 } });
add('cfg-global-delay-huge', 'siteConfigOf', { live: live({ delayMs: 70000 }), siteId: 'vacatorrent' });
add('cfg-global-cap-huge', 'siteConfigOf', { live: live({ maxPerHour: 30000 }), siteId: 'vacatorrent' });
add('cfg-map-override', 'siteConfigOf', { live: live({ siteOverrides: { comandotorrents: { enabled: true, dryRun: false, delayMs: 2500, maxPerHour: 500 } } }), siteId: 'comandotorrents' });

add('known-env-plus-panel', 'knownSites', { live: live({ sites: ['vacatorrent', 'bludv'], siteOverrides: { nerdfilmes: { enabled: true } } }) });
add('known-trim-empty', 'knownSites', { live: live({ sites: [' vacatorrent ', '', 'bludv'], siteOverrides: {} }) });
add('cadence-min-enabled', 'cadenceDelayMs', { live: live({ sites: ['vacatorrent', 'bludv'], siteOverrides: { vacatorrent: { delayMs: 5000 }, nerdfilmes: { enabled: true, delayMs: 2000 } } }) });
add('cadence-none-enabled', 'cadenceDelayMs', { live: live({ sites: ['vacatorrent'], siteOverrides: { vacatorrent: { enabled: false } } }) });
add('with-cadence', 'withCadenceDelay', { live: live({ sites: ['vacatorrent', 'bludv'], siteOverrides: { bludv: { enabled: false }, vacatorrent: { delayMs: 5000 } } }) });
add('series-limits-global', 'seriesLimits', { live: live({ seriesEnabled: false, seriesMaxCards: 12, seriesMaxButtons: 45 }) });

// ---- crawl-status-view -----------------------------------------------------
add('probe-neutral', 'neutralProbe');
add('legacy-full', 'legacyView', {
  input: { activeSiteId: 'vacatorrent', activeLabel: 'Vaca Torrent', siteReady: true, paused: false, pagesThisHour: 42, currentSiteNewReleases: 5, avgRequestCost: 1.25, idleFraction: 0.85 },
  live: live(), siteId: 'vacatorrent',
});
add('legacy-empty', 'legacyView', { input: {}, live: live(), siteId: 'nerdfilmes' });
add('legacy-default-idle', 'legacyView', { input: { activeLabel: null, cursors: { movie: 'a', tv_show: 'b' }, errorStreak: 3, canaryStreak: 2, cycle: { pages: 9 } }, live: live(), siteId: 'vacatorrent' });

// ---- crawl-pauses ----------------------------------------------------------
const matchTexts = [
  'fetch: HTTP 403 Forbidden', 'HTTP 429 Too Many Requests', '500 Internal Server Error',
  'blocked_host:evil', 'Challenge required', 'Cloudflare Ray ID', 'Just a moment...', '503',
];
const nonMatchTexts = ['socket hang up', 'ECONNREFUSED', 'ETIMEDOUT', 'JSON parse error', '4030 not error', 'HTTP 200 OK', ''];
matchTexts.forEach((t, i) => add(`siteerr-match-${i}`, 'isSiteLevelError', { text: t }));
nonMatchTexts.forEach((t, i) => add(`siteerr-non-${i}`, 'isSiteLevelError', { text: t }));

const lastmods = [
  [], ['', ''],
  ['2026-01-01', '2026-03-15T01:36:00+00:00', '2026-02-01', '2026-04-10T10:20:00Z'],
  ['not-a-date', 'corrupt-2026'],
  ['invalid', '2026-01-01', '2026-02-01'],
  ['2026-03-01', 'invalid', '2026-01-01'],
  ['2026-05-01T15:00:00+04:00', '2026-05-01T12:00:00Z'],
];
lastmods.forEach((urls, i) => add(`lastmod-${i}`, 'maxLastmod', { urls }));

add('obs-error-streak', 'observePages', {
  limits: { errorPauseStreak: 3, layoutCanary: 10 },
  steps: [
    { url: '/p1', kind: 'error', siteLevelError: false },
    { url: '/p2', kind: 'error', siteLevelError: true },
    { url: '/p3', kind: 'error', siteLevelError: true },
    { url: '/p4', kind: 'error', siteLevelError: true },
  ],
});
add('obs-canary', 'observePages', {
  limits: { errorPauseStreak: 5, layoutCanary: 2 },
  steps: [
    { url: '/page1', kind: 'done', releases: 2 },
    { url: '/page2', kind: 'done', releases: 3 },
    { url: '/stream', kind: 'no-torrent' },
    { url: '/page1', kind: 'no-torrent' },
    { url: '/ok', kind: 'done', releases: 1 },
    { url: '/page1', kind: 'no-torrent' },
    { url: '/page2', kind: 'no-torrent' },
  ],
});
add('obs-partial-neutral', 'observePages', {
  limits: { errorPauseStreak: 3, layoutCanary: 2 },
  steps: [
    { url: '/item', kind: 'done', releases: 5 },
    { url: '/err', kind: 'error', siteLevelError: true },
    { url: '/item', kind: 'partial', releases: 8 },
  ],
});
add('obs-no-work-resets', 'observePages', {
  limits: { errorPauseStreak: 2, layoutCanary: 5 },
  steps: [
    { url: '/e', kind: 'error', siteLevelError: true },
    { url: '/nw', kind: 'no-work' },
    { url: '/e', kind: 'error', siteLevelError: true },
    { url: '/sim', kind: 'simulated', releases: 4 },
  ],
});
add('obs-zero-limits', 'observePages', {
  limits: { errorPauseStreak: 0, layoutCanary: 0 },
  steps: [{ url: '/e', kind: 'error', siteLevelError: true }],
});
add('obs-canary-zero-limit', 'observePages', {
  limits: { errorPauseStreak: 0, layoutCanary: 0 },
  steps: [{ url: '/a', kind: 'done', releases: 3 }, { url: '/a', kind: 'no-torrent' }],
});
add('obs-failure-non-site', 'observeSite', {
  limits: { errorPauseStreak: 3, layoutCanary: 10 },
  steps: [{ kind: 'failure', text: 'DNS timeout' }, { kind: 'failure', text: 'HTTP 502 Bad Gateway' }],
});
add('obs-failure-streak', 'observeSite', {
  limits: { errorPauseStreak: 3, layoutCanary: 10 },
  steps: [{ kind: 'failure', text: '403' }, { kind: 'failure', text: '429' }, { kind: 'success' }, { kind: 'failure', text: 'cloudflare' }],
});

// ---- crawl-rate (relógio injetado) -----------------------------------------
add('hour-basic', 'hourCounter', { steps: [{ kind: 'current', now: 1000000 }, { kind: 'note', amount: 1, now: 1000000 }, { kind: 'current', now: 1000500 }, { kind: 'note', amount: 10, now: 1500000 }, { kind: 'current', now: 2000000 }] });
add('hour-rollover', 'hourCounter', { steps: [{ kind: 'note', amount: 5, now: 3599999 }, { kind: 'current', now: 3599999 }, { kind: 'current', now: 3600000 }, { kind: 'note', amount: 2, now: 3600000 }, { kind: 'current', now: 3600001 }] });
add('hour-note-default', 'hourCounter', { steps: [{ kind: 'note', now: 0 }, { kind: 'current', now: 0 }] });
add('hour-note-nonpositive', 'hourCounter', { steps: [{ kind: 'note', amount: 0, now: 0 }, { kind: 'note', amount: -5, now: 0 }, { kind: 'current', now: 0 }] });
add('hour-clear', 'hourCounter', { steps: [{ kind: 'note', amount: 3, now: 0 }, { kind: 'clear' }, { kind: 'current', now: 0 }] });
add('cost-avg', 'costMeter', { steps: [{ kind: 'avg' }, { kind: 'note', cost: 1 }, { kind: 'note', cost: 12 }, { kind: 'avg' }, { kind: 'reset' }, { kind: 'avg' }] });
add('cost-nonpositive', 'costMeter', { steps: [{ kind: 'note', cost: 0 }, { kind: 'note', cost: -2 }, { kind: 'avg' }] });
add('cost-fraction', 'costMeter', { steps: [{ kind: 'note', cost: 1 }, { kind: 'note', cost: 1 }, { kind: 'note', cost: 2 }, { kind: 'avg' }] });

// ---- crawl-site-select -----------------------------------------------------
const RCFG = baseConfig();
add('due-open-run', 'dueClass', { runtime: baseRuntime('s1', { openRunId: 42 }), counters: counters(0, 0, 0, 0, 0), now: 100000 });
add('due-pending', 'dueClass', { runtime: baseRuntime('s1'), counters: counters(5, 1, 0, 0, 0), now: 100000 });
add('due-recovery-sim', 'dueClass', { runtime: baseRuntime('s1', { needSimulatedRecovery: true }), counters: counters(0, 0, 0, 0, 0), now: 100000 });
add('due-recovery-inflight', 'dueClass', { runtime: baseRuntime('s1', { needInflightRecovery: true }), counters: counters(0, 0, 0, 0, 0), now: 100000 });
add('due-empty-discovery', 'dueClass', { runtime: baseRuntime('s1'), counters: counters(0, 0, 0, 0, 0), now: 100000 });
add('due-next-due', 'dueClass', { runtime: baseRuntime('s1', { nextDiscoverAt: 90000 }), counters: counters(5, 0, 0, 0, 0), now: 100000 });
add('due-next-future', 'dueClass', { runtime: baseRuntime('s1', { nextDiscoverAt: 200000 }), counters: counters(5, 0, 0, 0, 0), now: 100000 });
add('hasdue-injected-true', 'hasDuePage', { siteId: 's1', counters: counters(10, 0, 0, 0, 0), deps: { hasDue: { s1: true } }, now: 1000 });
add('hasdue-injected-false', 'hasDuePage', { siteId: 's1', counters: counters(10, 5, 0, 0, 0), deps: { hasDue: { s1: false } }, now: 1000 });
add('hasdue-fallback', 'hasDuePage', { siteId: 's1', counters: counters(10, 0, 0, 1, 0), deps: {}, now: 1000 });

const mk = (id, over) => baseRuntime(id, over);
const cfgs = { s1: RCFG, s2: RCFG, mico: RCFG, a: RCFG, b: RCFG, c: RCFG };
add('assess-disabled', 'assessSites', { ids: ['s1'], runtimes: { s1: mk('s1') }, configs: { s1: baseConfig({ enabled: false }) }, deps: {}, now: 1000 });
add('assess-paused', 'assessSites', { ids: ['s1'], runtimes: { s1: mk('s1', { paused: true }) }, configs: cfgs, deps: {}, now: 1000 });
add('assess-autopause', 'assessSites', { ids: ['s1'], runtimes: { s1: mk('s1', { autoPause: { reason: 'layout', at: 1, detail: '' } }) }, configs: cfgs, deps: {}, now: 1000 });
add('assess-cap-global', 'assessSites', { ids: ['s1'], runtimes: { s1: mk('s1', { hourPages: 10 }) }, configs: cfgs, deps: { globalCapHit: true }, now: 1000 });
add('assess-cap-site', 'assessSites', { ids: ['s1'], runtimes: { s1: mk('s1', { hourPages: 100 }) }, configs: { s1: baseConfig({ maxPerHour: 50 }) }, deps: {}, now: 1000 });
add('assess-mico-cap-exempt', 'assessSites', { ids: ['mico'], runtimes: { mico: mk('mico', { hourPages: 5000 }) }, configs: { mico: baseConfig({ maxPerHour: 50 }) }, deps: { globalCapHit: true }, now: 1000 });
add('assess-probe', 'assessSites', { ids: ['s1'], runtimes: { s1: mk('s1') }, configs: cfgs, deps: { probeOpen: { s1: false } }, now: 1000 });
add('assess-adapter-window', 'assessSites', { ids: ['s1'], runtimes: { s1: mk('s1', { adapterFailedAt: 70000 }) }, configs: cfgs, deps: {}, now: 100000 });
add('assess-no-work', 'assessSites', { ids: ['s1'], runtimes: { s1: mk('s1', { nextDiscoverAt: 200000 }) }, configs: cfgs, deps: { counters: { s1: counters(10, 0, 0, 0, 0) } }, now: 100000 });
add('assess-precedence', 'assessSites', { ids: ['s1'], runtimes: { s1: mk('s1', { paused: true, autoPause: { reason: 'layout', at: 1, detail: '' }, hourPages: 999, adapterFailedAt: 99000 }) }, configs: { s1: baseConfig({ enabled: false, maxPerHour: 10 }) }, deps: { globalCapHit: true, probeOpen: { s1: false } }, now: 100000 });

add('select-fairness', 'selectNext', { ids: ['a', 'b'], runtimes: { a: mk('a', { openRunId: 1, lastActiveAt: 900 }), b: mk('b', { openRunId: 2, lastActiveAt: 100 }) }, configs: cfgs, deps: { counters: { a: counters(5, 5, 0, 0, 0), b: counters(5, 5, 0, 0, 0) } }, now: 1000 });
add('select-tie', 'selectNext', { ids: ['a', 'b'], runtimes: { a: mk('a', { openRunId: 1, lastActiveAt: 100 }), b: mk('b', { openRunId: 2, lastActiveAt: 100 }) }, configs: cfgs, deps: { counters: { a: counters(5, 5, 0, 0, 0), b: counters(5, 5, 0, 0, 0) } }, now: 1000 });
add('select-starve-never', 'selectNext', { ids: ['a', 'b'], runtimes: { a: mk('a', { openRunId: 1, lastActiveAt: 1000000 }), b: mk('b', { lastActiveAt: 0 }) }, configs: cfgs, deps: { counters: { a: counters(5, 5, 0, 0, 0), b: counters(0, 0, 0, 0, 0) } }, now: 1000000 });
add('select-starve-expired', 'selectNext', { ids: ['a', 'b'], runtimes: { a: mk('a', { openRunId: 1, lastActiveAt: 10000000 }), b: mk('b', { lastActiveAt: 10000000 - 61 * 60000 }) }, configs: cfgs, deps: { counters: { a: counters(5, 5, 0, 0, 0), b: counters(0, 0, 0, 0, 0) } }, now: 10000000 });
add('select-starve-within', 'selectNext', { ids: ['a', 'b'], runtimes: { a: mk('a', { openRunId: 1, lastActiveAt: 10000000 }), b: mk('b', { lastActiveAt: 10000000 - 30 * 60000 }) }, configs: cfgs, deps: { counters: { a: counters(5, 5, 0, 0, 0), b: counters(0, 0, 0, 0, 0) } }, now: 10000000 });
add('select-none', 'selectNext', { ids: ['a'], runtimes: { a: mk('a', { nextDiscoverAt: 5000 }) }, configs: cfgs, deps: { counters: { a: counters(10, 0, 0, 0, 0) } }, now: 1000 });

add('pick-max-parallel', 'pickBatch', { ids: ['a', 'b', 'c', 'd'], inflight: [], maxParallel: 3, flareSites: [], runtimes: { a: mk('a', { openRunId: 1 }), b: mk('b', { openRunId: 1 }), c: mk('c', { openRunId: 1 }), d: mk('d', { openRunId: 1 }) }, configs: { a: baseConfig({ delayMs: 500 }), b: baseConfig({ delayMs: 500 }), c: baseConfig({ delayMs: 500 }), d: baseConfig({ delayMs: 500 }) }, deps: { counters: { a: counters(5, 5, 0, 0, 0), b: counters(5, 5, 0, 0, 0), c: counters(5, 5, 0, 0, 0), d: counters(5, 5, 0, 0, 0) } }, now: 1000000 });
add('pick-flare-single', 'pickBatch', { ids: ['rede', 'bludv', 'vaca'], inflight: [], maxParallel: 3, flareSites: ['rede', 'bludv'], runtimes: { rede: mk('rede', { openRunId: 1 }), bludv: mk('bludv', { openRunId: 1 }), vaca: mk('vaca', { openRunId: 1 }) }, configs: { rede: baseConfig({ delayMs: 500 }), bludv: baseConfig({ delayMs: 500 }), vaca: baseConfig({ delayMs: 500 }) }, deps: { counters: { rede: counters(5, 5, 0, 0, 0), bludv: counters(5, 5, 0, 0, 0), vaca: counters(5, 5, 0, 0, 0) } }, now: 1000000 });
add('pick-paced', 'pickBatch', { ids: ['a', 'b'], inflight: [], maxParallel: 3, flareSites: [], runtimes: { a: mk('a', { openRunId: 1, lastActiveAt: 999900 }), b: mk('b', { openRunId: 1, lastActiveAt: 999100 }) }, configs: { a: baseConfig({ delayMs: 500 }), b: baseConfig({ delayMs: 500 }) }, deps: { counters: { a: counters(5, 5, 0, 0, 0), b: counters(5, 5, 0, 0, 0) } }, now: 1000000 });
add('pick-ownpace', 'pickBatch', { ids: ['a', 'b', 'c', 'd', 'mico'], inflight: [], maxParallel: 3, flareSites: [], runtimes: { a: mk('a', { openRunId: 1 }), b: mk('b', { openRunId: 1 }), c: mk('c', { openRunId: 1 }), d: mk('d', { openRunId: 1 }), mico: mk('mico', { openRunId: 1 }) }, configs: { a: baseConfig({ delayMs: 500 }), b: baseConfig({ delayMs: 500 }), c: baseConfig({ delayMs: 500 }), d: baseConfig({ delayMs: 500 }), mico: baseConfig({ delayMs: 500 }) }, deps: { counters: { a: counters(5, 5, 0, 0, 0), b: counters(5, 5, 0, 0, 0), c: counters(5, 5, 0, 0, 0), d: counters(5, 5, 0, 0, 0), mico: counters(5, 5, 0, 0, 0) } }, now: 1000000 });
add('pick-inflight', 'pickBatch', { ids: ['a', 'b', 'c'], inflight: ['a', 'b'], maxParallel: 3, flareSites: [], runtimes: { a: mk('a', { openRunId: 1 }), b: mk('b', { openRunId: 1 }), c: mk('c', { openRunId: 1 }) }, configs: { a: baseConfig({ delayMs: 500 }), b: baseConfig({ delayMs: 500 }), c: baseConfig({ delayMs: 500 }) }, deps: { counters: { a: counters(5, 5, 0, 0, 0), b: counters(5, 5, 0, 0, 0), c: counters(5, 5, 0, 0, 0) } }, now: 1000000 });

add('fair-2', 'byFairness', { candidates: [{ id: 'x', lastActiveAt: 500 }, { id: 'y', lastActiveAt: 100 }, { id: 'z', lastActiveAt: 500 }, { id: 'w', lastActiveAt: 50 }] });
add('fair-3', 'byFairness', { candidates: [{ id: 'a', lastActiveAt: 0 }, { id: 'b', lastActiveAt: 0 }, { id: 'c', lastActiveAt: 100 }] });

add('skip-measured', 'skipReasonFor', { runtime: baseRuntime('s1', { skipReason: 'teto-horario' }), config: RCFG, globalEnabled: false });
add('skip-none', 'skipReasonFor', { runtime: baseRuntime('s1'), config: RCFG, globalEnabled: true });
add('skip-global-off', 'skipReasonFor', { runtime: baseRuntime('s1'), config: RCFG, globalEnabled: false });
add('skip-disabled-cfg', 'skipReasonFor', { runtime: baseRuntime('s1'), config: baseConfig({ enabled: false }), globalEnabled: true });
add('apply-reasons', 'applySkipReasons', { candidates: [{ id: 's1', skipReason: 'pausado' }, { id: 's2', skipReason: null }] });

add('ownpace-mico', 'isOwnPace', { id: 'mico' });
add('ownpace-other', 'isOwnPace', { id: 'vacatorrent' });

const corpus = { config: { floorPolicy: 'crawl-policy-validation.mjs' }, cases };
fs.writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
console.log(`[corpus] crawl-policy: ${cases.length} casos -> ${path.relative(REPO, OUT)}`);
