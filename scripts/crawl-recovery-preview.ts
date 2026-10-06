import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseUrlRow } from '../src/utils/crawl-store-rules.js';
import type { CrawlUrlRow } from '../src/providers/crawl-types.js';
import { parseRecoveryManifest, planRecovery } from './crawl-recovery-preview-plan.js';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);

function fail(message: string): never {
  console.error(`[preview] RECUSADO: ${message}`);
  process.exit(1);
}

function flag(name: string): string | null {
  const matches = args.filter((arg) => arg.startsWith(`--${name}=`));
  if (matches.length > 1) fail(`flag --${name} repetida`);
  return matches[0]?.slice(name.length + 3) ?? null;
}

const knownFlags = new Set(['--manifest', '--crawl']);
for (const arg of args) {
  const name = arg.split('=', 1)[0];
  if (!knownFlags.has(name) || !arg.includes('=')) fail(`flag inválida (${name}); esta prévia não tem --apply`);
}
const manifestArg = flag('manifest');
if (!manifestArg) fail('use --manifest=<arquivo.json>');

const manifestPath = path.resolve(manifestArg);
let manifest;
try {
  manifest = parseRecoveryManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown);
} catch (error) {
  fail(`manifesto inválido em ${manifestPath}: ${(error as Error).message}`);
}

const crawlPath = path.resolve(flag('crawl') ?? path.join('data', 'crawl.db'));
console.log(`[preview] manifesto: ${manifestPath} (schema ${manifest.schema}, source=${manifest.source}, ${manifest.entries.length} entrada(s))`);
console.log(`[preview] banco: ${crawlPath} (somente leitura)`);
if (!manifest.backup) console.log('[preview] backup: ausente no manifesto (pré-condição de apply futuro)');
else {
  const backupDir = path.resolve(manifest.backup.dir);
  let verified = false;
  try {
    verified = fs.statSync(backupDir).isDirectory() && fs.readdirSync(backupDir).some((file) => {
      if (file !== 'crawl.db' && !file.startsWith('crawl.db.')) return false;
      const stat = fs.statSync(path.join(backupDir, file));
      return stat.isFile() && stat.size > 0;
    });
  } catch { /* relatório read-only: ausência vira aviso */ }
  console.log(`[preview] backup: ${verified ? 'cópia crawl.db não vazia encontrada' : 'não verificado'} (${backupDir})`);
}

const sites = [...new Set(manifest.entries.map((entry) => entry.site))];
let rows: Array<CrawlUrlRow & { urlKey: string }> = [];
if (sites.length > 0) {
  try {
    if (!fs.existsSync(crawlPath) || fs.statSync(crawlPath).size === 0) {
      console.log(`[preview] crawl.db ausente/vazio: sem linhas para avaliar; nenhuma escrita`);
    } else {
      const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => any };
      const db = new DatabaseSync(crawlPath, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        const columns = db.prepare('PRAGMA table_info(crawl_url)').all() as Array<Record<string, unknown>>;
        if (!columns.some((column) => column.name === 'url_key')) {
          throw new Error('crawl_url sem url_key; abra o store/addon para migrar (a prévia não migra)');
        }
        const placeholders = sites.map(() => '?').join(',');
        const rawRows = db.prepare(`SELECT * FROM crawl_url WHERE site IN (${placeholders}) ORDER BY site, url_key`)
          .all(...sites) as Array<Record<string, unknown>>;
        rows = rawRows.map((raw) => ({ ...parseUrlRow(raw), urlKey: String(raw.url_key ?? '') }));
        for (const site of sites) {
          const states = db.prepare('SELECT key, value FROM crawl_state WHERE site = ? ORDER BY key')
            .all(site) as Array<Record<string, unknown>>;
          for (const state of states) {
            const value = String(state.value ?? '');
            console.log(`[preview] contexto cursor ${site}: ${String(state.key)}=${value ? 'presente' : 'vazio'} (valor omitido)`);
          }
        }
      } finally {
        db.close();
      }
    }
  } catch (error) {
    fail(`banco não pôde ser lido: ${(error as Error).message}`);
  }
}

const plan = planRecovery(rows, manifest);
for (const proposal of plan.proposals) {
  const evidence = proposal.evidenceRefs.map((ref) => {
    const entry = manifest.entries[ref];
    return `#${ref}:${entry.type}/${entry.check}`;
  }).join(',');
  const expected = proposal.expected ? ` esperado=${proposal.expected.imdb}${proposal.expected.kind ? `/${proposal.expected.kind}` : ''}` : '';
  console.log(`[preview]   PROPOSTA requeue-url ${proposal.site} ${proposal.urlKey} motivo=${proposal.reason}`
    + ` imdb=${proposal.before.imdb ?? 'null'}${expected} kind=${proposal.before.kind} status=${proposal.before.status}`
    + ` evidencia=${evidence} alvo=${proposal.desired.status},nextAt=${proposal.desired.nextAt}`);
}
for (const finding of [...plan.reports, ...plan.noops]) {
  const entry = manifest.entries[finding.evidenceRef];
  const group = plan.reports.includes(finding) ? 'RELATO' : 'NO-OP';
  console.log(`[preview]   ${group} ${finding.site} ${finding.urlKey} motivo=${finding.reason}`
    + ` evidencia=#${finding.evidenceRef}:${entry.type}/${entry.check}`);
}
console.log(`[preview] resumo: ${plan.proposals.length} proposta(s), ${plan.reports.length} relato(s), ${plan.noops.length} no-op(s)`
  + ' — SOMENTE PRÉVIA (nenhuma escrita)');
