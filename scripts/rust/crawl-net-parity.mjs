#!/usr/bin/env node
/**
 * Paridade de REDE do fetch TS × Rust para páginas do raspador.
 *
 * Este script compara o fetch do TypeScript (`fetchTextDirect`) com o fetch
 * do Rust (`adom-crawl probe`) para as mesmas URLs. Diferente do `crawl-parity.mjs`
 * (que compara parsers em fixtures offline), este script faz REDE REAL e mede
 * tempo, status e tamanho do body.
 *
 * Uso:
 *   node scripts/rust/crawl-net-parity.mjs [--site=vacatorrent] [--sample=10]
 *
 * Flags:
 *   --site=<id>     Site a testar (default: vacatorrent)
 *   --sample=<n>    Número de páginas a testar (default: 5)
 *   --flare-url=<u> URL do FlareSolverr (default: http://127.0.0.1:8191)
 *   --timeout-ms=<n> Timeout em ms (default: 15000)
 *
 * IMPORTANTE: Este script é para VALIDAÇÃO MANUAL. Ele NÃO roda no CI (precisa de rede).
 * É uma ferramenta do operador para verificar que o fetch do Rust se comporta
 * igual ao fetch do TS antes de virar o default.
 *
 * Saída: tabela com URL, status TS, status Rust, tamanho TS, tamanho Rust, tempo TS, tempo Rust.
 * No final, resumo com X/Y páginas com mesmo status, tempo médio, divergências.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures');

// ── Parse de argumentos ─────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = {
  site: 'vacatorrent',
  sample: 5,
  flareUrl: 'http://127.0.0.1:8191',
  timeoutMs: 15000,
};

for (const arg of argv) {
  if (arg.startsWith('--site=')) args.site = arg.slice('--site='.length);
  else if (arg.startsWith('--sample=')) args.sample = parseInt(arg.slice('--sample='.length), 10);
  else if (arg.startsWith('--flare-url=')) args.flareUrl = arg.slice('--flare-url='.length);
  else if (arg.startsWith('--timeout-ms=')) args.timeoutMs = parseInt(arg.slice('--timeout-ms='.length), 10);
  else if (arg === '--help' || arg === '-h') {
    console.log('Uso: node scripts/rust/crawl-net-parity.mjs [--site=vacatorrent] [--sample=10]');
    console.log('');
    console.log('Flags:');
    console.log('  --site=<id>       Site a testar (default: vacatorrent)');
    console.log('  --sample=<n>      Número de páginas a testar (default: 5)');
    console.log('  --flare-url=<u>   URL do FlareSolverr (default: http://127.0.0.1:8191)');
    console.log('  --timeout-ms=<n>  Timeout em ms (default: 15000)');
    process.exit(0);
  } else {
    console.error(`Flag desconhecida: ${arg}`);
    process.exit(1);
  }
}

// ── Cores para output ───────────────────────────────────────────────────────
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const color = (text, colorName) => `${colors[colorName]}${text}${colors.reset}`;
const ok = (text) => color(text, 'green');
const fail = (text) => color(text, 'red');
const warn = (text) => color(text, 'yellow');
const info = (text) => color(text, 'cyan');

// ── Descobre URLs de fixture ────────────────────────────────────────────────
// Lê o HTML do fixture e extrai URLs de exemplo (links <a href="...">).
// Como os fixtures são HTML estático, as URLs são fictícias — o script
// poderia usar URLs reais do site, mas isso exigiria descoberta online.
// Para validação inicial, usamos URLs sintéticas baseadas no site.
function discoverUrls(site, sample) {
  // URLs de exemplo por site (o operador pode expandir esta lista).
  const urlTemplates = {
    vacatorrent: [
      'https://vaqueirofilmes1.com/movie-links/filme-teste-1/',
      'https://vaqueirofilmes1.com/movie-links/filme-teste-2/',
      'https://vaqueirofilmes1.com/movie-links/filme-teste-3/',
    ],
    nerdfilmes: [
      'https://nerdfilmes.net/filme/filme-teste-1',
      'https://nerdfilmes.net/filme/filme-teste-2',
      'https://nerdfilmes.net/filme/filme-teste-3',
    ],
    bludv: [
      'https://bludvfilmes1.xyz/filme-teste-1/',
      'https://bludvfilmes1.xyz/filme-teste-2/',
    ],
    apachetorrent: [
      'https://apachetorrents.com/filme-teste-1/',
      'https://apachetorrents.com/filme-teste-2/',
    ],
    hdrtorrents: [
      'https://hdrtorrents.org/filme-teste-1/',
      'https://hdrtorrents.org/filme-teste-2/',
    ],
    comandotorrents: [
      'https://comandotorrents.to/filme-teste-1/',
      'https://comandotorrents.to/filme-teste-2/',
    ],
    torrentdosfilmes: [
      'https://torrentdosfilmes.se/filme-teste-1/',
      'https://torrentdosfilmes.se/filme-teste-2/',
    ],
  };

  const urls = urlTemplates[site] || [];
  return urls.slice(0, sample);
}

// ── Fetch TS ────────────────────────────────────────────────────────────────
async function fetchTs(url, timeoutMs) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    clearTimeout(timeout);
    const text = await res.text();
    const elapsed = Date.now() - start;
    return {
      status: res.status,
      bytes: text.length,
      elapsedMs: elapsed,
      error: null,
    };
  } catch (e) {
    return {
      status: 0,
      bytes: 0,
      elapsedMs: Date.now() - start,
      error: e.message,
    };
  }
}

// ── Fetch Rust ──────────────────────────────────────────────────────────────
function fetchRust(site, url, flareUrl, timeoutMs) {
  const binPath = path.join(REPO, 'target', 'release', 'adom-crawl');
  if (!fs.existsSync(binPath)) {
    return {
      status: 0,
      bytes: 0,
      elapsedMs: 0,
      error: `binário não encontrado: ${binPath} (rode: cargo build --release -p adom-crawl)`,
    };
  }

  const start = Date.now();
  try {
    const args = [
      'probe',
      `--site=${site}`,
      `--url=${url}`,
      `--flare-url=${flareUrl}`,
      `--timeout-ms=${timeoutMs}`,
      '--json',
    ];
    const output = execFileSync(binPath, args, {
      encoding: 'utf8',
      timeout: timeoutMs + 1000, // margem para o binário iniciar
    });
    const elapsed = Date.now() - start;
    const result = JSON.parse(output);
    return {
      status: result.status,
      bytes: result.bytes,
      elapsedMs: result.elapsed_ms || elapsed,
      error: null,
    };
  } catch (e) {
    return {
      status: 0,
      bytes: 0,
      elapsedMs: Date.now() - start,
      error: e.message,
    };
  }
}

// ── Tabela de resultados ────────────────────────────────────────────────────
function printTable(results) {
  console.log('');
  console.log(info('─'.repeat(100)));
  console.log(info('Resultados da paridade de rede TS × Rust'));
  console.log(info('─'.repeat(100)));
  console.log('');

  // Cabeçalho
  const header = [
    'URL'.padEnd(50),
    'Status TS'.padEnd(10),
    'Status Rust'.padEnd(12),
    'Bytes TS'.padEnd(10),
    'Bytes Rust'.padEnd(11),
    'Tempo TS'.padEnd(10),
    'Tempo Rust'.padEnd(11),
  ].join(' ');
  console.log(color(header, 'dim'));
  console.log(color('─'.repeat(100), 'dim'));

  for (const r of results) {
    const urlShort = r.url.length > 47 ? r.url.slice(0, 47) + '...' : r.url.padEnd(50);
    const statusTs = r.ts.error ? fail('ERR') : ok(String(r.ts.status).padEnd(10));
    const statusRust = r.rust.error ? fail('ERR') : ok(String(r.rust.status).padEnd(12));
    const bytesTs = r.ts.error ? fail('0') : String(r.ts.bytes).padEnd(10);
    const bytesRust = r.rust.error ? fail('0') : String(r.rust.bytes).padEnd(11);
    const tempoTs = r.ts.error ? fail('ERR') : `${r.ts.elapsedMs}ms`.padEnd(10);
    const tempoRust = r.rust.error ? fail('ERR') : `${r.rust.elapsedMs}ms`.padEnd(11);

    console.log(
      `${urlShort} ${statusTs} ${statusRust} ${bytesTs} ${bytesRust} ${tempoTs} ${tempoRust}`
    );

    if (r.ts.error || r.rust.error) {
      if (r.ts.error) console.log(warn(`  TS erro: ${r.ts.error}`));
      if (r.rust.error) console.log(warn(`  Rust erro: ${r.rust.error}`));
    }
  }

  console.log('');
}

// ── Resumo ──────────────────────────────────────────────────────────────────
function printSummary(results) {
  const total = results.length;
  const sameStatus = results.filter(
    (r) => !r.ts.error && !r.rust.error && r.ts.status === r.rust.status
  ).length;
  const sameBytes = results.filter(
    (r) => !r.ts.error && !r.rust.error && Math.abs(r.ts.bytes - r.rust.bytes) < 100
  ).length;
  const tsErrors = results.filter((r) => r.ts.error).length;
  const rustErrors = results.filter((r) => r.rust.error).length;

  const avgTs = results.reduce((sum, r) => sum + (r.ts.elapsedMs || 0), 0) / total;
  const avgRust = results.reduce((sum, r) => sum + (r.rust.elapsedMs || 0), 0) / total;

  console.log(info('─'.repeat(100)));
  console.log(info('Resumo'));
  console.log(info('─'.repeat(100)));
  console.log(`Páginas testadas: ${total}`);
  console.log(`Mesmo status: ${ok(sameStatus)}/${total}`);
  console.log(`Bytes similares (<100 diff): ${ok(sameBytes)}/${total}`);
  console.log(`Erros TS: ${tsErrors > 0 ? fail(tsErrors) : ok(tsErrors)}`);
  console.log(`Erros Rust: ${rustErrors > 0 ? fail(rustErrors) : ok(rustErrors)}`);
  console.log(`Tempo médio TS: ${avgTs.toFixed(0)}ms`);
  console.log(`Tempo médio Rust: ${avgRust.toFixed(0)}ms`);
  console.log('');

  if (sameStatus === total && tsErrors === 0 && rustErrors === 0) {
    console.log(ok('✓ Paridade de rede OK: TS e Rust retornam o mesmo status em todas as páginas.'));
  } else if (sameStatus >= total * 0.8) {
    console.log(warn('⚠ Paridade parcial: a maioria das páginas tem o mesmo status, mas há divergências.'));
  } else {
    console.log(fail('✗ Paridade falhou: muitas divergências entre TS e Rust.'));
  }
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(info(`[crawl-net-parity] site=${args.site} sample=${args.sample}`));
  console.log(info(`[crawl-net-parity] flare-url=${args.flareUrl} timeout=${args.timeoutMs}ms`));
  console.log('');

  const urls = discoverUrls(args.site, args.sample);
  if (urls.length === 0) {
    console.error(fail(`Nenhuma URL de teste disponível para o site: ${args.site}`));
    console.error('Edite o script e adicione URLs reais em discoverUrls().');
    process.exit(1);
  }

  console.log(`Testando ${urls.length} URLs...`);
  console.log('');

  const results = [];
  for (const url of urls) {
    process.stdout.write(`  ${url} ... `);
    const ts = await fetchTs(url, args.timeoutMs);
    const rust = fetchRust(args.site, url, args.flareUrl, args.timeoutMs);
    results.push({ url, ts, rust });

    if (ts.error || rust.error) {
      console.log(fail('ERRO'));
    } else if (ts.status === rust.status) {
      console.log(ok('OK'));
    } else {
      console.log(warn('DIVERGÊNCIA'));
    }
  }

  printTable(results);
  printSummary(results);
}

main().catch((e) => {
  console.error(fail(`Erro inesperado: ${e.stack || e.message}`));
  process.exit(1);
});
