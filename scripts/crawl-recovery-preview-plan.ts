import { crawlUrlKey } from '../src/utils/crawl-url-key.js';
import type { CrawlUrlRow } from '../src/providers/crawl-types.js';

export type EvidenceSource = 'previous-check' | 'current-check' | 'operator';

interface EvidenceBase {
  site: string;
  check: EvidenceSource;
  proof?: string;
}

export interface IdentityEvidence extends EvidenceBase {
  type: 'identity';
  urlKey: string;
  expectedImdb: string;
  expectedKind?: 'movie' | 'tv_show';
  proof: string;
}

export interface DiscoveryGapEvidence extends EvidenceBase {
  type: 'discovery-gap';
  urlKey?: string;
  hint?: { urlKeyPrefix?: string; lastmodFrom?: string; lastmodTo?: string };
}

export type RecoveryEvidence = IdentityEvidence | DiscoveryGapEvidence;

export interface RecoveryManifest {
  schema: 'crawl-recovery-evidence/v1';
  source: EvidenceSource;
  backup?: { dir: string };
  entries: RecoveryEvidence[];
}

export type RecoveryRow = CrawlUrlRow & { urlKey: string };

export interface RecoveryProposal {
  action: 'requeue-url';
  site: string;
  urlKey: string;
  reason: 'identity-divergence' | 'discovery-gap-reread';
  evidenceRefs: number[];
  before: { status: string; imdb: string | null; kind: string; tries: number; nextAt: number };
  expected?: { imdb: string; kind?: string };
  desired: { status: 'pending'; nextAt: 0 };
}

export interface RecoveryFinding {
  site: string;
  urlKey: string;
  reason: 'already-correct' | 'already-queued' | 'inflight-skip' | 'row-not-found'
    | 'identity-divergence-already-queued' | 'gap-unverifiable-offline' | 'gap-unverifiable-lastmod';
  evidenceRef: number;
}

export interface RecoveryPlan {
  proposals: RecoveryProposal[];
  reports: RecoveryFinding[];
  noops: RecoveryFinding[];
}

const SOURCES = new Set<EvidenceSource>(['previous-check', 'current-check', 'operator']);
const SECRET_TEXT = /magnet:\?|btih:|\bxt=|token=|cookie|protect(?:or)?[-_/ ]?url/i;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: esperado objeto`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${label}: campo desconhecido ${extra}`);
}

function safeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: texto obrigatório`);
  if (SECRET_TEXT.test(value)) throw new Error(`${label}: conteúdo secreto/URL de protetor recusado`);
  return value.trim();
}

function keyOf(entry: Record<string, unknown>, label: string): string | undefined {
  if (entry.urlKey !== undefined && entry.url !== undefined) throw new Error(`${label}: use urlKey OU url`);
  const raw = entry.urlKey ?? entry.url;
  if (raw === undefined) return undefined;
  return crawlUrlKey(safeText(raw, `${label}.urlKey`));
}

function isoDate(value: unknown, label: string): string {
  const text = safeText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error(`${label}: data ISO-8601 inválida`);
  }
  return text;
}

function parseEntry(input: unknown, index: number): RecoveryEvidence {
  const label = `entries[${index}]`;
  const entry = record(input, label);
  const baseKeys = ['type', 'site', 'urlKey', 'url', 'check', 'proof'];
  if (entry.type === 'identity') {
    exactKeys(entry, [...baseKeys, 'expectedImdb', 'expectedKind'], label);
    const urlKey = keyOf(entry, label);
    if (!urlKey) throw new Error(`${label}: urlKey obrigatório`);
    const expectedImdb = safeText(entry.expectedImdb, `${label}.expectedImdb`);
    if (!/^tt\d+$/.test(expectedImdb)) throw new Error(`${label}.expectedImdb: formato inválido`);
    const expectedKind = entry.expectedKind;
    if (expectedKind !== undefined && expectedKind !== 'movie' && expectedKind !== 'tv_show') {
      throw new Error(`${label}.expectedKind: esperado movie ou tv_show`);
    }
    const check = safeText(entry.check, `${label}.check`) as EvidenceSource;
    if (!SOURCES.has(check)) throw new Error(`${label}.check: origem inválida`);
    return {
      type: 'identity', site: safeText(entry.site, `${label}.site`), urlKey,
      expectedImdb, ...(expectedKind ? { expectedKind } : {}), check,
      proof: safeText(entry.proof, `${label}.proof`),
    };
  }
  if (entry.type === 'discovery-gap') {
    exactKeys(entry, [...baseKeys, 'hint'], label);
    const urlKey = keyOf(entry, label);
    let hint: DiscoveryGapEvidence['hint'];
    if (entry.hint !== undefined) {
      const rawHint = record(entry.hint, `${label}.hint`);
      exactKeys(rawHint, ['urlKeyPrefix', 'lastmodFrom', 'lastmodTo'], `${label}.hint`);
      const prefix = rawHint.urlKeyPrefix === undefined ? undefined : (() => {
        const rawPrefix = safeText(rawHint.urlKeyPrefix, `${label}.hint.urlKeyPrefix`);
        const normalized = crawlUrlKey(rawPrefix);
        return rawPrefix.endsWith('/') && normalized !== '/' ? `${normalized}/` : normalized;
      })();
      const from = rawHint.lastmodFrom === undefined ? undefined
        : isoDate(rawHint.lastmodFrom, `${label}.hint.lastmodFrom`);
      const to = rawHint.lastmodTo === undefined ? undefined
        : isoDate(rawHint.lastmodTo, `${label}.hint.lastmodTo`);
      if (Boolean(from) !== Boolean(to)) throw new Error(`${label}.hint: lastmodFrom e lastmodTo devem vir juntos`);
      if (!prefix && !from) throw new Error(`${label}.hint: seletor vazio`);
      if (from && to && Date.parse(from) > Date.parse(to)) throw new Error(`${label}.hint: intervalo invertido`);
      hint = { ...(prefix ? { urlKeyPrefix: prefix } : {}), ...(from ? { lastmodFrom: from, lastmodTo: to } : {}) };
    }
    if (Boolean(urlKey) === Boolean(hint)) throw new Error(`${label}: use urlKey OU hint`);
    const check = safeText(entry.check, `${label}.check`) as EvidenceSource;
    if (!SOURCES.has(check)) throw new Error(`${label}.check: origem inválida`);
    return {
      type: 'discovery-gap', site: safeText(entry.site, `${label}.site`),
      ...(urlKey ? { urlKey } : {}), ...(hint ? { hint } : {}), check,
      ...(entry.proof === undefined ? {} : { proof: safeText(entry.proof, `${label}.proof`) }),
    };
  }
  throw new Error(`${label}.type: esperado identity ou discovery-gap`);
}

export function parseRecoveryManifest(value: unknown): RecoveryManifest {
  const root = record(value, 'manifesto');
  exactKeys(root, ['schema', 'source', 'backup', 'entries'], 'manifesto');
  if (root.schema !== 'crawl-recovery-evidence/v1') throw new Error('manifesto.schema: esperado crawl-recovery-evidence/v1');
  const source = safeText(root.source, 'manifesto.source') as EvidenceSource;
  if (!SOURCES.has(source)) throw new Error('manifesto.source: origem inválida');
  if (!Array.isArray(root.entries)) throw new Error('manifesto.entries: esperado array');
  let backup: RecoveryManifest['backup'];
  if (root.backup !== undefined) {
    const raw = record(root.backup, 'manifesto.backup');
    exactKeys(raw, ['dir'], 'manifesto.backup');
    backup = { dir: safeText(raw.dir, 'manifesto.backup.dir') };
  }
  const entries = root.entries.map(parseEntry);
  const identities = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'identity') continue;
    const key = `${entry.site}\0${entry.urlKey}`;
    if (identities.has(key)) throw new Error(`manifesto: identity duplicada em ${entry.site} ${entry.urlKey}`);
    identities.add(key);
  }
  return { schema: 'crawl-recovery-evidence/v1', source, ...(backup ? { backup } : {}), entries };
}

function matchesHint(row: RecoveryRow, hint: NonNullable<DiscoveryGapEvidence['hint']>): 'yes' | 'no' | 'unknown' {
  if (hint.urlKeyPrefix && !row.urlKey.startsWith(hint.urlKeyPrefix)) return 'no';
  if (!hint.lastmodFrom || !hint.lastmodTo) return 'yes';
  const seen = Date.parse(row.lastmod);
  if (!Number.isFinite(seen)) return 'unknown';
  return seen >= Date.parse(hint.lastmodFrom) && seen <= Date.parse(hint.lastmodTo) ? 'yes' : 'no';
}

export function planRecovery(rows: readonly RecoveryRow[], manifest: RecoveryManifest): RecoveryPlan {
  const proposals = new Map<string, RecoveryProposal>();
  const reports: RecoveryFinding[] = [];
  const noops: RecoveryFinding[] = [];
  const addProposal = (row: RecoveryRow, reason: RecoveryProposal['reason'], evidenceRef: number,
    expected?: RecoveryProposal['expected']) => {
    const key = `${row.site}\0${row.urlKey}`;
    const current = proposals.get(key);
    if (current) {
      current.evidenceRefs.push(evidenceRef);
      return;
    }
    proposals.set(key, {
      action: 'requeue-url', site: row.site, urlKey: row.urlKey, reason,
      evidenceRefs: [evidenceRef],
      before: { status: row.status, imdb: row.imdb, kind: row.kind, tries: row.tries, nextAt: row.nextAt },
      ...(expected ? { expected } : {}), desired: { status: 'pending', nextAt: 0 },
    });
  };
  manifest.entries.forEach((entry, evidenceRef) => {
    const candidates = rows.filter((row) => row.site === entry.site);
    if (entry.type === 'identity') {
      const row = candidates.find((candidate) => candidate.urlKey === entry.urlKey);
      if (!row) { reports.push({ site: entry.site, urlKey: entry.urlKey, reason: 'row-not-found', evidenceRef }); return; }
      if (row.status === 'inflight') { reports.push({ site: row.site, urlKey: row.urlKey, reason: 'inflight-skip', evidenceRef }); return; }
      const matches = row.imdb === entry.expectedImdb && (!entry.expectedKind || row.kind === entry.expectedKind);
      if (matches) { noops.push({ site: row.site, urlKey: row.urlKey, reason: 'already-correct', evidenceRef }); return; }
      if (row.status === 'pending') {
        noops.push({ site: row.site, urlKey: row.urlKey, reason: 'identity-divergence-already-queued', evidenceRef });
        return;
      }
      addProposal(row, 'identity-divergence', evidenceRef, { imdb: entry.expectedImdb, ...(entry.expectedKind ? { kind: entry.expectedKind } : {}) });
      return;
    }
    const matched = candidates.filter((row) => entry.urlKey
      ? row.urlKey === entry.urlKey
      : entry.hint ? matchesHint(row, entry.hint) === 'yes' : false);
    const unknownDates = candidates.filter((row) => !entry.urlKey && entry.hint
      && matchesHint(row, entry.hint) === 'unknown');
    if (matched.length === 0) {
      reports.push({ site: entry.site, urlKey: entry.urlKey ?? entry.hint?.urlKeyPrefix ?? '*',
        reason: unknownDates.length ? 'gap-unverifiable-lastmod' : 'gap-unverifiable-offline', evidenceRef });
      return;
    }
    for (const row of unknownDates) {
      reports.push({ site: row.site, urlKey: row.urlKey, reason: 'gap-unverifiable-lastmod', evidenceRef });
    }
    for (const row of matched) {
      if (row.status === 'inflight') { reports.push({ site: row.site, urlKey: row.urlKey, reason: 'inflight-skip', evidenceRef }); continue; }
      if (row.status === 'pending' && !row.error) { noops.push({ site: row.site, urlKey: row.urlKey, reason: 'already-queued', evidenceRef }); continue; }
      addProposal(row, 'discovery-gap-reread', evidenceRef);
    }
  });
  return { proposals: [...proposals.values()], reports, noops };
}
