#!/usr/bin/env node
/**
 * Baseline LOCAL e PASSIVO do servidor TS em container (fatia 7).
 *
 * Coleta ~60s de amostras espaçadas, SEM forçar busca/play e SEM HTTP externo.
 * É observacional: não é benchmark controlado e NÃO compara TS com Rust (não
 * existe servidor Rust neste checkout). Produz um JSON sanitizado por allowlist
 * forte — nenhum dado de conta/config/segredo/path/caminho/host sai daqui.
 *
 * Toda leitura sensível (token, /proc, /metrics.json) acontece DENTRO do
 * container, via `docker exec ... python3 -` (programa lido do stdin). O token
 * nunca vira argumento, log ou stack.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { argv, platform, exit } from 'node:process';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
const PROBE_SRC_URL = new URL('./local-container-probe.py', import.meta.url);
// Subconjunto compilado comparado entre container e host (sem importar addon.js).
// F4.4: o pipeline de busca TS saiu; o baseline compara o que sobrou do processo
// (rede/coleta e hot paths do núcleo) e não inventa arquivo removido.
const ARTIFACT_RELS = [
  'dist/src/addon.js',
  'dist/src/app.js',
  'dist/src/utils/title-normalization.js',
  'dist/src/providers/collect-orchestrator.js',
];
const DEFAULT_CONTAINER = 'stremio-adom';
const DEFAULT_OUT = 'rust/benchmarks/local-ts-baseline.json';
// O endpoint /metrics.json DESTE checkout não publica o tamanho da janela; 256 é
// a constante SAMPLES de src/utils/metrics.ts (referência do código do host),
// não um valor medido no container. Mantido separado do campo "medido".
const CONFIGURED_WINDOW_SIZE = 256;
const WINDOW_SOURCE_ENDPOINT = 'endpoint-metrics-json';
const WINDOW_SOURCE_NOT_REPORTED = 'not-reported-by-endpoint';
const WINDOW_CONFIGURED_SOURCE = 'checkout-code-constant-not-reported-by-endpoint';
// Raízes onde --out pode gravar: rust/benchmarks/ do repo e <tmp>/kilo.
const OUT_REPO_ROOT = resolve(process.cwd(), 'rust', 'benchmarks');
const OUT_TMP_ROOT = resolve(tmpdir(), 'kilo');
const RANGE = { duration: [5, 3600], interval: [1, 60] };
const SUBPROCESS_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 15000;
const KNOWN_FLAGS = new Set(['--duration', '--interval', '--container', '--out']);
const USAGE = [
  'uso: npm run bench:local -- [--duration <s>] [--interval <s>] [--container <nome>] [--out <arquivo.json>]',
  '  --duration  janela de coleta em segundos (padrão 60; faixa 5..3600)',
  '  --interval  espaçamento entre amostras (padrão 5; faixa 1..60; <= duration)',
  `  --container nome do container Docker (padrão ${DEFAULT_CONTAINER})`,
  `  --out       destino do JSON (padrão ${DEFAULT_OUT}); só .json sob`,
  '              rust/benchmarks/ do repositório ou <dir-temporário>/kilo',
].join('\n');

class CliError extends Error {}

function intArg(name, value, [min, max]) {
  if (!/^-?\d+$/.test(value)) throw new CliError(`valor não inteiro para ${name}: ${value}`);
  const n = Number(value);
  if (n < min || n > max) throw new CliError(`${name} fora da faixa ${min}..${max}: ${n}`);
  return n;
}

/** Canonicaliza --out e exige que fique DENTRO de rust/benchmarks/ ou <tmp>/kilo.
 *  Evita clobber acidental (package.json, scripts/golden, caminho externo) via
 *  absoluto ou `..`; NÃO é defesa adversarial de symlink/FS do host. */
function resolveOutPath(raw) {
  const candidate = resolve(process.cwd(), raw);
  if (!candidate.endsWith('.json')) throw new CliError('--out deve terminar em .json');
  const inside = [OUT_REPO_ROOT, OUT_TMP_ROOT].some((root) => {
    const rel = relative(root, candidate);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!inside) throw new CliError('--out fora das raízes permitidas (rust/benchmarks ou <tmp>/kilo)');
  return candidate;
}

function parseArgs(tokens) {
  const cfg = { duration: 60, interval: 5, container: DEFAULT_CONTAINER, out: DEFAULT_OUT };
  let help = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--help' || tok === '-h') { help = true; continue; }
    const eq = tok.startsWith('--') && tok.includes('=') ? tok.indexOf('=') : -1;
    const name = eq >= 0 ? tok.slice(0, eq) : tok;
    if (!KNOWN_FLAGS.has(name)) throw new CliError(`flag desconhecida: ${tok}`);
    let value = eq >= 0 ? tok.slice(eq + 1) : undefined;
    if (value === undefined) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith('-')) throw new CliError(`valor ausente para ${name}`);
      value = next; i++;
    }
    if (name === '--duration') cfg.duration = intArg(name, value, RANGE.duration);
    else if (name === '--interval') cfg.interval = intArg(name, value, RANGE.interval);
    else if (name === '--container') {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new CliError(`nome de container inválido: ${value}`);
      cfg.container = value;
    } else if (name === '--out') {
      cfg.out = value;
    }
  }
  if (!help) {
    if (cfg.interval > cfg.duration) throw new CliError('--interval não pode ser maior que --duration');
    // Valida o destino AQUI: sai com exit 2 antes de qualquer IO/Docker.
    cfg.outPath = resolveOutPath(cfg.out);
  }
  return { cfg, help };
}

async function docker(args, timeoutMs = SUBPROCESS_TIMEOUT_MS) {
  try {
    const { stdout } = await execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 8 << 20, encoding: 'utf8' });
    return { ok: true, stdout: stdout.trim() };
  } catch { return { ok: false }; }
}

async function host(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' });
    return stdout.trim() || null;
  } catch { return null; }
}

// `npm run` já publica o user-agent em env; extrair só a versão evita executar
// um .cmd (que o execFile não roda sem shell no Windows).
function npmVersionFromEnv() {
  const m = /(?:^|\s)npm\/([^\s]+)/.exec(process.env.npm_config_user_agent || '');
  return m ? m[1] : null;
}

let probeSource = '';
function probeOnce(container, mode) {
  return new Promise((done) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; done(v); } };
    let child;
    try {
      child = spawn('docker', ['exec', '-i', '-w', '/app', container, 'python3', '-', mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { settle({ ok: false, error: 'spawn_failed' }); return; }
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} settle({ ok: false, error: 'timeout' }); }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); settle({ ok: false, error: 'spawn_failed' }); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop();
      try { settle({ ok: true, value: JSON.parse(line) }); } catch { settle({ ok: false, error: 'bad_json' }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(probeSource);
  });
}

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
function parseBytes(text) {
  const m = /^([0-9.]+)\s*([A-Za-z]+)$/.exec(String(text).trim());
  if (!m) return null;
  const v = Number(m[1]); const u = UNITS[m[2].toUpperCase()];
  return Number.isFinite(v) && u ? Math.round(v * u) : null;
}
function parsePercent(text) {
  const v = Number(String(text).replace('%', '').trim());
  return Number.isFinite(v) ? v : null;
}

async function dockerStats(container) {
  const r = await docker(['stats', '--no-stream', '--format', '{{json .}}', container]);
  if (!r.ok) return { ok: false };
  let d;
  try { d = JSON.parse(r.stdout.split('\n').pop()); } catch { return { ok: false }; }
  const usage = String(d.MemUsage || '').split('/');
  return {
    ok: true,
    cpuPercent: parsePercent(d.CPUPerc),
    memUsedBytes: parseBytes(usage[0]),
    memLimitBytes: usage[1] ? parseBytes(usage[1]) : null,
    memPercent: parsePercent(d.MemPerc),
    pids: Number.isFinite(Number(d.PIDs)) ? Number(d.PIDs) : null,
  };
}

function series(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (!nums.length) return { samples: 0, min: null, max: null, avg: null };
  const sum = nums.reduce((a, b) => a + b, 0);
  return { samples: nums.length, min: Math.min(...nums), max: Math.max(...nums), avg: Math.round((sum / nums.length) * 100) / 100 };
}

/** ≥1 amostra REAL de memória (RSS do processo OU cgroup)? Frames existem
 *  mesmo sem dado; sem piso o artefato sairia "ok" com tudo null. */
function hasMemorySample(summary) {
  return summary.addonRssBytes.samples > 0 || summary.containerMemUsedBytes.samples > 0;
}
/** Algum timer traz p50/p95 numérico? Decide o texto de `limits` (nulo ≠ zero). */
function hasNumericPercentile(view) {
  return Object.values((view && view.timers) || {}).some((t) => t && (Number.isFinite(t.p50Ms) || Number.isFinite(t.p95Ms)));
}

/** Nunca deixa NaN/negativo/infinito entrar no artefato. */
function assertFiniteNonNegative(value, path) {
  if (value === null || value === undefined) return;
  if (typeof value === 'number') { if (!Number.isFinite(value) || value < 0) throw new Error(`valor inválido em ${path}`); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => assertFiniteNonNegative(v, `${path}[${i}]`)); return; }
  if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) assertFiniteNonNegative(v, `${path}.${k}`); }
}

function metricsView(snapshot) {
  const m = snapshot && snapshot.ok && snapshot.value ? snapshot.value.metrics : null;
  // "windowSize" só é medição se o endpoint publicar um número finito; caso
  // contrário fica null (desconhecido). A constante 256 vai rotulada à parte.
  const measured = m && typeof m.windowSize === 'number' && Number.isFinite(m.windowSize) ? m.windowSize : null;
  const view = {
    status: 'probe_failed',
    httpStatus: null,
    windowSize: measured,
    windowSizeSource: measured === null ? WINDOW_SOURCE_NOT_REPORTED : WINDOW_SOURCE_ENDPOINT,
    configuredWindowSize: CONFIGURED_WINDOW_SIZE,
    configuredWindowSizeSource: WINDOW_CONFIGURED_SOURCE,
    uptimeS: null,
    timers: {},
    source: 'server-memory-window',
    sessionSampled: false,
  };
  if (!m) return view;
  return { ...view, status: m.status, httpStatus: m.httpStatus ?? null, uptimeS: m.uptimeS ?? null, timers: m.timers ?? {} };
}

async function hashHostDist() {
  const out = {};
  for (const rel of ARTIFACT_RELS) {
    try { out[rel] = createHash('sha256').update(await readFile(rel)).digest('hex'); } catch { out[rel] = null; }
  }
  return out;
}

function block(message) { console.error(`[bench:local] bloqueio: ${message}`); exit(3); }

async function main() {
  let parsed;
  try { parsed = parseArgs(argv.slice(2)); } catch (e) { console.error(`[bench:local] ${e.message}\n${USAGE}`); exit(2); }
  if (parsed.help) { console.log(USAGE); exit(0); }
  const cfg = parsed.cfg;

  try { probeSource = await readFile(PROBE_SRC_URL, 'utf8'); } catch { block('sonda python ausente (scripts/bench/local-container-probe.py)'); }
  if (!probeSource.trim()) block('sonda python vazia');

  const inspect = await docker(['inspect', cfg.container, '--format', '{{.Image}}|{{.Created}}|{{.State.StartedAt}}|{{.State.Running}}']);
  if (!inspect.ok) block(`container "${cfg.container}" indisponível (docker inspect falhou)`);
  const [imageId, containerCreatedAt, containerStartedAt, runningRaw] = inspect.stdout.split('|');
  if (runningRaw !== 'true') block(`container "${cfg.container}" não está em execução`);

  const revRes = await docker(['inspect', cfg.container, '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}']);
  const revision = revRes.ok && /^[0-9a-f]{7,40}$/i.test(revRes.stdout) ? revRes.stdout.toLowerCase() : null;
  const nodeVer = await docker(['exec', cfg.container, 'node', '--version']);
  const containerNodeVersion = nodeVer.ok && /^v\d+\.\d+\.\d+/.test(nodeVer.stdout) ? nodeVer.stdout : null;

  const initial = await probeOnce(cfg.container, 'snapshot');
  if (!initial.ok) block(`sonda no container falhou (${initial.error})`);

  const durationMs = cfg.duration * 1000;
  const intervalMs = cfg.interval * 1000;
  const totalSamples = Math.floor(durationMs / intervalMs) + 1;
  const t0 = performance.now();
  const samples = [];
  let rssOk = 0; let statsOk = 0;
  for (let i = 0; i < totalSamples; i++) {
    const wait = t0 + i * intervalMs - performance.now();
    if (i > 0 && wait > 5) await sleep(wait);
    const elapsedMs = Math.round(performance.now() - t0);
    // RSS antes do stats: evita que a sonda distorça a memória lida logo depois.
    const p = await probeOnce(cfg.container, 'sample');
    let rss = null;
    if (p.ok && p.value && p.value.addonProc) { rss = p.value.addonProc.rssBytes; rssOk++; }
    const st = await dockerStats(cfg.container);
    if (st.ok) statsOk++;
    samples.push({
      index: i,
      elapsedMs,
      addonRssBytes: rss,
      containerCpuPercent: st.ok ? st.cpuPercent : null,
      containerMemUsedBytes: st.ok ? st.memUsedBytes : null,
      containerMemLimitBytes: st.ok ? st.memLimitBytes : null,
      containerMemPercent: st.ok ? st.memPercent : null,
      containerPids: st.ok ? st.pids : null,
    });
  }
  const effectiveDurationMs = Math.round(performance.now() - t0);

  const final = await probeOnce(cfg.container, 'snapshot');
  const hashRes = await probeOnce(cfg.container, 'hashes');
  const containerHashes = hashRes.ok && hashRes.value && hashRes.value.files ? hashRes.value.files : {};
  const hostHashes = await hashHostDist();
  const hostDistPresent = ARTIFACT_RELS.some((rel) => hostHashes[rel] !== null);
  const files = ARTIFACT_RELS.map((rel) => {
    const c = containerHashes[rel] ?? null;
    const h = hostHashes[rel] ?? null;
    return { path: rel, containerSha256: c, hostSha256: h, match: c !== null && h !== null ? c === h : null };
  });
  const subsetMatch = !hostDistPresent ? null : files.every((f) => f.match === true);

  const hostHead = await host('git', ['rev-parse', 'HEAD']);
  const hostNpm = npmVersionFromEnv() || (platform === 'win32' ? null : await host('npm', ['--version']));

  const summary = {
    sampleCount: samples.length,
    addonRssBytes: series(samples.map((s) => s.addonRssBytes)),
    containerCpuPercent: series(samples.map((s) => s.containerCpuPercent)),
    containerMemUsedBytes: series(samples.map((s) => s.containerMemUsedBytes)),
    containerMemLimitBytes: series(samples.map((s) => s.containerMemLimitBytes)),
    containerPids: series(samples.map((s) => s.containerPids)),
  };
  if (samples.length < 1) { console.error('[bench:local] falha: 0 amostras — nada a reportar'); exit(4); }
  // Bloqueia ANTES do writer: frames sozinhos não provam dado; exige memória real.
  if (!hasMemorySample(summary)) block('nenhuma amostra válida de memória');

  const initialView = metricsView(initial);
  const finalView = metricsView(final);
  const percentilesPresent = hasNumericPercentile(initialView) || hasNumericPercentile(finalView);
  const artifact = {
    schema: 'adom.local-ts-baseline/1',
    status: 'ok',
    kind: 'observational',
    controlledBenchmark: false,
    forcesLoad: false,
    rustComparison: false,
    generatedAt: new Date().toISOString(),
    collector: {
      file: 'scripts/bench/local-baseline.mjs',
      platform,
      durationRequestedMs: durationMs,
      intervalMs,
      effectiveDurationMs,
      timeouts: { subprocessMs: SUBPROCESS_TIMEOUT_MS, probeMs: PROBE_TIMEOUT_MS },
    },
    target: { container: cfg.container, imageId, containerCreatedAt, containerStartedAt, containerNodeVersion, revision },
    host: { node: process.version, npm: hostNpm, gitHead: hostHead },
    fingerprints: {
      hostDistPresent,
      // Igualdade só DENTRO dos 5 artefatos compilados comparados; NÃO prova
      // paridade integral do checkout com a imagem em execução.
      allMatchWithinSubset: subsetMatch,
      comparisonScope: {
        scope: 'selected-compiled-artifacts',
        artifactCount: ARTIFACT_RELS.length,
        completeCheckoutParityProven: false,
      },
      files,
    },
    metrics: { endpoint: '/metrics.json', initial: initialView, final: finalView },
    samples,
    summary,
    coverage: {
      addonRss: rssOk > 0,
      containerStats: statsOk > 0,
      metricsInitial: initialView.status,
      metricsFinal: finalView.status,
      artifactHashes: Object.values(containerHashes).some((v) => v),
      hostDistComparison: hostDistPresent,
    },
    limits: [
      'Observacional: coleta passiva, sem forçar busca ou play e sem HTTP externo; não é benchmark controlado.',
      'Overhead do observador explícito: um python3 efêmero por amostra (docker exec) + docker stats a cada intervalo.',
      'containerCpuPercent (docker stats) é do container inteiro, não do processo Node do addon — não é CPU do Node.',
      'addonRssBytes é VmRSS (/proc/<pid>/status) do processo node dist/src/addon.js; containerMemUsedBytes é a memória cgroup do docker stats. Não são somas entre si.',
      percentilesPresent
        ? 'p50/p95 vêm da janela em memória do servidor; há percentis numéricos nesta amostra, mas são observação pontual — não série histórica nem benchmark desta sessão.'
        : 'p50/p95 vêm da janela em memória do servidor e são NULOS nesta amostra; nulo não é zero e não há série histórica desta sessão.',
      'A janela configurada (256) é a constante SAMPLES do código do host (src/utils/metrics.ts); o endpoint /metrics.json deste checkout não publica windowSize, então o valor medido é null.',
      'A comparação de artefatos cobre 5 arquivos compilados selecionados; NÃO prova paridade integral do checkout com a imagem em execução (completeCheckoutParityProven=false).',
      'containerCreatedAt é anterior à data do HEAD git do host; timestamp anterior sozinho não prova divergência da imagem nem equivalência/divergência de Node — nenhuma das duas é afirmada.',
      'Nenhum servidor Rust existe neste checkout: nenhuma comparação TS-vs-Rust é feita ou afirmada.',
    ],
  };
  assertFiniteNonNegative(artifact, 'artifact');

  const outPath = cfg.outPath;
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  } catch (e) {
    // Não ecoar caminho absoluto (nem usuário do host) ao falhar a escrita.
    block(typeof e?.code === 'string' ? `falha ao gravar --out (${e.code})` : 'falha ao gravar --out');
  }

  const r = summary.addonRssBytes; const c = summary.containerCpuPercent; const m = summary.containerMemUsedBytes; const pd = summary.containerPids;
  console.log(`[bench:local] ok amostras=${samples.length} efetivo=${effectiveDurationMs}ms rss[min=${r.min},max=${r.max}] cpu[max=${c.max}] mem[max=${m.max}] pids[max=${pd.max}]`);
  console.log(`[bench:local] fingerprintsSubset=${subsetMatch} revision=${revision ? revision.slice(0, 7) : 'none'} metrics=${initialView.status}/${finalView.status} out=${basename(outPath)}`);
}

main().catch((e) => {
  const code = e && typeof e.code === 'string' ? e.code : null;
  console.error(code ? `[bench:local] erro inesperado (${code})` : '[bench:local] erro inesperado');
  exit(1);
});
