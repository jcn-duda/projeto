#!/usr/bin/env node
/**
 * Oráculo do golden `crawl-policy` — política pura do motor de raspagem (C2).
 *
 * Mede a saída REAL do `dist` vivo dos módulos:
 * - `crawl-cycle.ts` (`freshCycle`)
 * - `crawl-rate.ts` (`createHourCounter`, `createCostMeter`; relógio injetado
 *   por override de `Date.now` no próprio oráculo)
 * - `crawl-pauses.ts` (`isSiteLevelError`, `maxLastmod`, `CrawlPausePolicy`)
 * - `crawl-status-view.ts` (`legacyView`, `NEUTRAL_PROBE`)
 * - `crawler-live-schema.ts` / `crawler-live-site.ts` (`sanitizePatch` para os
 *   clamps, `siteConfigOf`, `knownSites`, `cadenceDelayMs`, `withCadence`,
 *   `seriesLimitsOf`)
 * - `crawl-site-select.ts` (`dueClass`, `hasDuePage`, `assessSites`,
 *   `selectNext`, `byFairness`, `skipReasonFor`, `applySkipReasons`)
 * - `crawl-dispatch.ts` (`pickBatch`)
 *
 * `starveMs` e `pacedOut` são privados no TS (sem export) e não entram aqui; a
 * fome do `selectNext` e o ritmo do `pickBatch` já são exercitados por casos.
 *
 * Nunca reimplementa o TS: cada `op` chama a função exportada real. A saída é
 * SEMPRE uma string canônica (JSON com chaves ordenadas ou escalar), para
 * comparação byte a byte com o teste Rust que consome o mesmo `expected`.
 *
 * Os `input` são JSON com `op`; o `deps` de seleção é materializado a partir do
 * corpus (`counters`/`probeOpen`/`globalCapHit`/`hasDue`) e o `runtime` recebe
 * só os campos que a política lê, com `hourPages.current()` injetado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];
const imp = (rel) => import(pathToFileURL(path.join(job.repo, rel)).href);

const cycle = await imp('dist/src/providers/crawl-cycle.js');
const rate = await imp('dist/src/providers/crawl-rate.js');
const pauses = await imp('dist/src/providers/crawl-pauses.js');
const statusView = await imp('dist/src/providers/crawl-status-view.js');
const select = await imp('dist/src/providers/crawl-site-select.js');
const dispatch = await imp('dist/src/providers/crawl-dispatch.js');
const liveSchema = await imp('dist/src/utils/crawler-live-schema.js');
const liveSite = await imp('dist/src/utils/crawler-live-site.js');
const registry = await imp('dist/src/providers/crawl-sites/registry.js');

// ---------------------------------------------------------------------------
// Canonicalização: JSON com chaves ordenadas (casa com o BTreeMap do serde_json).
// ---------------------------------------------------------------------------
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
}
const stable = (v) => JSON.stringify(sortDeep(v));
const bit = (v) => (v ? '1' : '0');
const numStr = (v) => (v === null || v === undefined ? 'null' : String(v));

const CONFIG_KEYS = [
  'enabled', 'dryRun', 'delayMs', 'maxPerHour', 'idleWindowMs', 'maxTries',
  'errorPauseStreak', 'layoutCanary', 'incrementalIntervalMin', 'seriesEnabled',
  'seriesMaxCards', 'seriesMaxButtons', 'requireProbe', 'overridden',
];
const configObj = (c) => {
  const o = {};
  for (const k of CONFIG_KEYS) o[k] = c[k];
  return o;
};

// ---------------------------------------------------------------------------
// Materialização de runtime/deps a partir do corpus.
// ---------------------------------------------------------------------------
function materializeRuntime(rt) {
  return {
    id: rt.id,
    paused: rt.paused === true,
    autoPause: rt.autoPause ?? null,
    openRunId: rt.openRunId ?? null,
    needSimulatedRecovery: rt.needSimulatedRecovery === true,
    needInflightRecovery: rt.needInflightRecovery === true,
    nextDiscoverAt: rt.nextDiscoverAt ?? 0,
    lastActiveAt: rt.lastActiveAt ?? 0,
    adapterFailedAt: rt.adapterFailedAt ?? 0,
    skipReason: rt.skipReason ?? null,
    hourPages: { current: () => rt.hourPages ?? 0 },
  };
}
function buildDeps(d) {
  d = d || {};
  const counters = d.counters || {};
  const probe = d.probeOpen || {};
  const hasDue = d.hasDue || null;
  const deps = {
    counters: (id) => counters[id] || { total: 0, byStatus: { pending: 0, error: 0, inflight: 0, partial: 0 } },
    probeOpen: (id) => (Object.prototype.hasOwnProperty.call(probe, id) ? probe[id] === true : true),
    globalCapHit: () => d.globalCapHit === true,
  };
  if (hasDue) deps.hasDue = (id) => (Object.prototype.hasOwnProperty.call(hasDue, id) ? hasDue[id] === true : d.hasDueDefault === true);
  return deps;
}
const runtimeOf = (runtimes) => (id) => materializeRuntime(runtimes[id] || { id });
const configsOf = (configs) => (id) => (configs && configs[id] ? configs[id] : { enabled: true, dryRun: false, delayMs: 1000, maxPerHour: 1500, idleWindowMs: 600000, maxTries: 3, errorPauseStreak: 5, layoutCanary: 10, incrementalIntervalMin: 60, seriesEnabled: true, seriesMaxCards: 10, seriesMaxButtons: 40, requireProbe: false, overridden: [] });

const canonCandidate = (c) => ({ id: c.id, due: c.due, skipReason: c.skipReason });

// ---------------------------------------------------------------------------
// Dispatch de ops.
// ---------------------------------------------------------------------------
const cases = job.cases.map((c) => {
  const r = JSON.parse(c.input);
  let out;
  switch (r.op) {
    case 'freshCycle':
      out = stable(cycle.freshCycle());
      break;
    case 'clamp': {
      const res = liveSchema.sanitizePatch({ [r.key]: r.v });
      out = numStr(res.clean[r.key]);
      break;
    }
    case 'siteConfigOf': {
      const live = r.live;
      const cfg = r.override !== undefined
        ? liveSite.siteConfigOf({ ...live, siteOverrides: { ...(live.siteOverrides || {}), [r.siteId]: r.override } }, r.siteId)
        : liveSite.siteConfigOf(live, r.siteId);
      out = stable(configObj(cfg));
      break;
    }
    case 'knownSites':
      out = stable(liveSite.knownSites(r.live));
      break;
    case 'cadenceDelayMs':
      out = numStr(liveSite.cadenceDelayMs(r.live));
      break;
    case 'withCadenceDelay':
      out = numStr(liveSite.withCadence(r.live).delayMs);
      break;
    case 'seriesLimits':
      out = stable(liveSchema.seriesLimitsOf(r.live));
      break;
    case 'neutralProbe':
      out = stable(canonProbe(statusView.NEUTRAL_PROBE));
      break;
    case 'legacyView': {
      const view = statusView.legacyView(r.input, r.live, r.siteId);
      out = stable({
        id: view.id, label: view.label, ready: view.ready, paused: view.paused,
        autoPause: view.autoPause ?? null, cursors: view.cursors, nextDiscoveryAt: view.nextDiscoveryAt,
        pagesThisHour: view.pagesThisHour, openRunId: view.openRunId, errorStreak: view.errorStreak,
        canaryStreak: view.canaryStreak, cycle: view.cycle, currentSiteNewReleases: view.currentSiteNewReleases,
        avgRequestCost: numStr(view.avgRequestCost), idleFraction: numStr(view.idleFraction),
        enabled: view.enabled, dryRun: view.dryRun, siteConfig: configObj(view.siteConfig),
        lastActiveAt: view.lastActiveAt, skipReason: view.skipReason, site: view.site, probe: canonProbe(view.probe),
      });
      break;
    }
    case 'isSiteLevelError':
      out = bit(pauses.isSiteLevelError(r.text));
      break;
    case 'maxLastmod':
      out = pauses.maxLastmod(r.urls.map((u) => ({ lastmod: u })));
      break;
    case 'observePages': {
      const policy = new pauses.CrawlPausePolicy();
      const reasons = r.steps.map((s) => {
        const reason = policy.observePage(s.url, { kind: s.kind, siteLevelError: s.siteLevelError, releases: s.releases }, r.limits);
        return reason === null || reason === undefined ? null : reason;
      });
      out = stable({
        reasons,
        errorStreak: policy.errorStreakCount,
        canaryStreak: policy.canaryStreakCount,
      });
      break;
    }
    case 'observeSite': {
      const policy = new pauses.CrawlPausePolicy();
      const reasons = r.steps.map((s) => {
        if (s.kind === 'success') { policy.observeSiteSuccess(); return null; }
        const reason = policy.observeSiteFailure(s.text, r.limits);
        return reason === null || reason === undefined ? null : reason;
      });
      out = stable({ reasons, errorStreak: policy.errorStreakCount });
      break;
    }
    case 'hourCounter': {
      const hc = rate.createHourCounter();
      const origNow = Date.now;
      const seen = [];
      for (const s of r.steps) {
        Date.now = () => s.now ?? 0;
        if (s.kind === 'note') hc.note(s.amount);
        else if (s.kind === 'clear') hc.clear();
        else seen.push(hc.current());
      }
      Date.now = origNow;
      out = stable(seen);
      break;
    }
    case 'costMeter': {
      const m = rate.createCostMeter();
      const seen = [];
      for (const s of r.steps) {
        if (s.kind === 'note') m.note(s.cost);
        else if (s.kind === 'reset') m.reset();
        else seen.push(numStr(m.avg()));
      }
      out = stable(seen);
      break;
    }
    case 'dueClass': {
      const deps = buildDeps(r.deps);
      const counters = r.counters || { total: 0, byStatus: {} };
      const cls = select.dueClass(materializeRuntime(r.runtime), deps, counters, r.now);
      out = cls === null || cls === undefined ? 'null' : cls;
      break;
    }
    case 'hasDuePage': {
      const deps = buildDeps(r.deps);
      out = bit(select.hasDuePage(deps, r.siteId, r.counters, r.now));
      break;
    }
    case 'assessSites': {
      const deps = buildDeps(r.deps);
      const cands = select.assessSites(r.ids, runtimeOf(r.runtimes), configsOf(r.configs), deps, r.now);
      out = stable(cands.map(canonCandidate));
      break;
    }
    case 'selectNext': {
      const deps = buildDeps(r.deps);
      const res = select.selectNext(r.ids, runtimeOf(r.runtimes), configsOf(r.configs), deps, r.now);
      out = stable({ chosen: res.chosen ? res.chosen.id : null });
      break;
    }
    case 'pickBatch': {
      const deps = buildDeps(r.deps);
      const res = dispatch.pickBatch({
        ids: r.ids,
        inflight: new Set(r.inflight || []),
        maxParallel: r.maxParallel,
        flareSites: new Set(r.flareSites || []),
        runtimeOf: runtimeOf(r.runtimes),
        configOf: configsOf(r.configs),
        deps,
        now: r.now,
      });
      out = stable({ chosen: res.chosen.map((c) => c.id), paced: [...res.paced].sort() });
      break;
    }
    case 'byFairness': {
      const cands = r.candidates.map((c) => ({ id: c.id, runtime: materializeRuntime(c), config: configsOf({})(c.id), due: null, skipReason: null }));
      out = stable(select.byFairness(cands).map((c) => c.id));
      break;
    }
    case 'skipReasonFor': {
      const reason = select.skipReasonFor(materializeRuntime(r.runtime), r.config, r.globalEnabled);
      out = reason === null || reason === undefined ? 'null' : reason;
      break;
    }
    case 'applySkipReasons': {
      const cands = r.candidates.map((c) => ({
        id: c.id, config: configsOf({})(c.id), runtime: materializeRuntime(c), due: null, skipReason: c.skipReason ?? null,
      }));
      select.applySkipReasons(cands);
      out = stable(cands.map((c) => ({ id: c.id, skipReason: c.runtime.skipReason })));
      break;
    }
    case 'isOwnPace': {
      out = bit(registry.isOwnPace(r.id));
      break;
    }
    default:
      throw new Error(`op desconhecida: ${r.op}`);
  }
  if (typeof out !== 'string') throw new Error(`saída não-string no caso ${c.id}`);
  return { id: c.id, out };
});

function canonProbe(p) {
  return {
    required: p.required, verdict: p.verdict ?? null, ok: p.ok, at: p.at ?? null,
    sample: p.sample ?? null, blockedBy: p.blockedBy ?? null,
    rates: p.rates ?? null, counts: p.counts ?? null, reasons: p.reasons ?? [],
  };
}

fs.writeFileSync(outPath, JSON.stringify({ ok: true, cases }));
