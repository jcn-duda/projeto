#!/usr/bin/env node
/**
 * Probe Jev audio-classify (ETAPA 3) — replay mensurável da classificação
 * SÓ DE TÍTULO que a busca já usa para reservar vaga BR: `looksPtBr` /
 * `audioFromTitle` (src/utils/audio-quality.ts).
 *
 * Irmão do probe dub-lie (scripts/jev-dub-lie-probe.mjs): mesmo cliente,
 * mesma política de fan-out/retry/auth/fail-open, mesmo formato de
 * relatório — só a PERGUNTA e o ESTADO mudam (aqui é só `post_title`,
 * sem indexer nem arquivos, porque a pergunta que audita é anterior ao
 * debrid: "esse título promete pt-BR de verdade, ou é uma das guardas
 * medidas em produção — HINDI, [Ukr Dub], rutracker, cirílico, ENGLISH?").
 * O cliente (`jev-dub-lie-client.mjs`) e as métricas
 * (`jev-dub-lie-metrics.mjs`) são compartilhados: ambos são puros/
 * genéricos por construção (sem `is_dub_lie` fixo — ver `questionId`).
 *
 * FORA DO CAMINHO CRÍTICO, POR CONSTRUÇÃO: nada daqui roda no addon,
 * nada é importado por `src/`, nenhuma decisão de busca depende deste
 * experimento — mesma decisão registrada no probe dub-lie.
 *
 * Uso:
 *   node scripts/jev-audio-classify-probe.mjs --dry-run      # local, sem chave, sem rede
 *   node --env-file=.env scripts/jev-audio-classify-probe.mjs # online (usa a chave)
 *
 * Knobs (env; todos opcionais):
 *   TYPESAFE_API_KEY                     chave (SÓ modo online; nunca impressa)
 *   JEV_AUDIO_CLASSIFY_ENDPOINT          default https://api.typesafe.ai/v1/systemone
 *   JEV_AUDIO_CLASSIFY_MODEL             default jev-latest
 *   JEV_AUDIO_CLASSIFY_THRESHOLD         default 0.55 (noul >= → pt-BR dub)
 *   JEV_AUDIO_CLASSIFY_CONCURRENCY       default 4 (1..16)
 *   JEV_AUDIO_CLASSIFY_TIMEOUT_MS        default 30000 (1000..300000)
 *   JEV_AUDIO_CLASSIFY_MAX_ATTEMPTS      default 2 (1..5)
 *
 * Argumentos, códigos de saída e forma dos flags: idênticos ao probe
 * dub-lie (ver o cabeçalho de jev-dub-lie-probe.mjs).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CASES } from './jev-audio-classify-cases.mjs';
import { QUESTIONS, PROMPT_VERSION, buildState, validateCorpus, corpusFingerprint } from './jev-audio-classify-payload.mjs';
import { summarize, renderReport } from './jev-dub-lie-metrics.mjs';
import { runCorpus } from './jev-dub-lie-client.mjs';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const QUESTION_ID = 'is_ptbr_dub';

const BOOLEAN_FLAGS = new Set(['--dry-run', '--json']);
const VALUE_FLAGS = new Set(['--model', '--threshold', '--concurrency', '--timeout-ms', '--max-attempts']);

function parseArgs(argv) {
  const flags = { dryRun: false, json: false };
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq > 0) return { error: `flag ${name} não aceita valor` };
      if (name === '--dry-run') flags.dryRun = true;
      else flags.json = true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      let value;
      if (eq > 0) value = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
      if (value == null || String(value).trim() === '') return { error: `flag ${name} sem valor` };
      values[name] = String(value);
      continue;
    }
    return { error: `flag desconhecida: ${name}` };
  }
  return { flags, values };
}

function numValue(values, name, { min, max, integer = false }) {
  const raw = values[name];
  if (raw == null) return {};
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    return { error: `valor inválido para ${name}: ${raw} (esperado ${integer ? 'inteiro ' : ''}entre ${min} e ${max})` };
  }
  return { value: n };
}

function loadConfig(values) {
  const errors = [];
  const bad = (e) => e && errors.push(e);
  const threshold = numValue(values, '--threshold', { min: 0, max: 1 });
  bad(threshold.error);
  const concurrency = numValue(values, '--concurrency', { min: 1, max: 16, integer: true });
  bad(concurrency.error);
  const timeoutMs = numValue(values, '--timeout-ms', { min: 1000, max: 300000 });
  bad(timeoutMs.error);
  const maxAttempts = numValue(values, '--max-attempts', { min: 1, max: 5, integer: true });
  bad(maxAttempts.error);
  if (errors.length) return { error: errors };
  const modelRaw = values['--model'];
  return {
    cfg: {
      endpoint: process.env.JEV_AUDIO_CLASSIFY_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
      model: (typeof modelRaw === 'string' ? modelRaw.trim() : '') || process.env.JEV_AUDIO_CLASSIFY_MODEL?.trim() || DEFAULT_MODEL,
      threshold: threshold.value ?? clamp(Number(process.env.JEV_AUDIO_CLASSIFY_THRESHOLD), 0, 1, 0.55),
      concurrency: concurrency.value ?? clamp(Number(process.env.JEV_AUDIO_CLASSIFY_CONCURRENCY), 1, 16, 4),
      timeoutMs: timeoutMs.value ?? clamp(Number(process.env.JEV_AUDIO_CLASSIFY_TIMEOUT_MS), 1000, 300000, 30000),
      maxAttempts: maxAttempts.value ?? clamp(Number(process.env.JEV_AUDIO_CLASSIFY_MAX_ATTEMPTS), 1, 5, 2),
      costInputPerM: Number(process.env.JEV_AUDIO_CLASSIFY_COST_INPUT_PER_M || 0),
      costOutputPerM: Number(process.env.JEV_AUDIO_CLASSIFY_COST_OUTPUT_PER_M || 0),
    },
  };
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** A chave é lida SÓ no modo online; `--dry-run` nem chega aqui. */
function loadKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    const m = raw.match(/^TYPESAFE_API_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

function dryRun(cfg) {
  const fp = corpusFingerprint(CASES);
  const ptbr = CASES.filter((c) => c.expectPtBr).length;
  const groups = [...new Set(CASES.map((c) => c.group))].sort();
  console.log('modo=dry-run (rede não é acionada neste caminho — garantia por construção, não sandbox)');
  console.log(`corpus=${CASES.length} casos (${ptbr} ptbr / ${CASES.length - ptbr} other) famílias=${groups.length} [${groups.join(', ')}]`);
  console.log(`prompt_version=${PROMPT_VERSION} corpus_sha256_12=${fp.short}`);
  console.log(`modelo=${cfg.model} threshold=${cfg.threshold} concorrência=${cfg.concurrency} timeout_ms=${cfg.timeoutMs} tentativas_máx=${cfg.maxAttempts}`);
  console.log(`fan-out planejado: ${CASES.length} requests (1 caso/request), no máximo ${cfg.concurrency} em voo`);
  console.log(`allowlist=OK (${['post_title'].join(', ')}) — indexer/arquivo/config/conta/chave nunca saem do processo`);
  console.log('payload de exemplo (primeiro caso):');
  console.log(JSON.stringify({ state: buildState(CASES[0]), model: cfg.model, questions: '…' }, null, 2));
  console.log('custo: configure JEV_AUDIO_CLASSIFY_COST_INPUT_PER_M / JEV_AUDIO_CLASSIFY_COST_OUTPUT_PER_M (USD por 1M tokens)');
  console.log('fora do caminho crítico — probe offline; nada disso roda em src/.');
}

async function online(cfg, key) {
  const fp = corpusFingerprint(CASES);
  console.log(`casos=${CASES.length} threshold=${cfg.threshold} modelo=${cfg.model} concorrência=${cfg.concurrency}`);
  const meta = {
    reportTitle: 'Jev audio-classify probe',
    model: cfg.model,
    threshold: cfg.threshold,
    concurrency: cfg.concurrency,
    timeoutMs: cfg.timeoutMs,
    promptVersion: PROMPT_VERSION,
    corpusSha256: fp.sha256,
    costInputPerM: cfg.costInputPerM,
    costOutputPerM: cfg.costOutputPerM,
    generatedAt: new Date().toISOString(),
  };
  let authFatal = false;
  // O cliente/métricas compartilhados falam em expectLie/predLie/tp-fp-fn-tn
  // (positivo genérico); aqui a classe positiva é "título indica pt-BR
  // dub" — expectPtBr entra como expectLie sem perder o nome próprio no
  // corpus, que continua expectPtBr por clareza de leitura.
  const casesForClient = CASES.map((c) => ({ ...c, expectLie: c.expectPtBr }));
  const rows = await runCorpus({
    cases: casesForClient,
    buildState,
    questions: QUESTIONS,
    questionId: QUESTION_ID,
    key,
    endpoint: cfg.endpoint,
    model: cfg.model,
    threshold: cfg.threshold,
    concurrency: cfg.concurrency,
    maxAttempts: cfg.maxAttempts,
    timeoutMs: cfg.timeoutMs,
    onRow: (row) => {
      if (row.error != null) {
        console.log(`ERR ${row.id}: ${row.error}`);
        if (row.error.startsWith('auth-recusada')) {
          authFatal = true;
          console.error('Auth falhou — gere outra chave em https://typesafe.ai e atualize TYPESAFE_API_KEY no .env');
        }
        return;
      }
      const mark = row.ok ? 'OK' : 'MISS';
      const expect = row.expectLie ? 'ptbr' : 'other';
      console.log(`${mark} ${row.id} expect=${expect} noul=${row.noul.toFixed(3)} pred=${row.predLie ? 'ptbr' : 'other'} ${row.latencyMs}ms`);
    },
  });
  const summary = summarize({ rows, meta });
  console.log('---');
  console.log(renderReport(summary));
  if (cfg.json) console.log(JSON.stringify(summary, null, 2));
  return authFatal;
}

async function main() {
  const { flags, values, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`argumento inválido: ${error} (use --dry-run para o modo local)`);
    process.exitCode = 3;
    return;
  }
  const { cfg, error: cfgError } = loadConfig(values);
  if (cfgError) {
    for (const e of cfgError) console.error(`argumento inválido: ${e}`);
    process.exitCode = 3;
    return;
  }
  const corpusErrors = validateCorpus(CASES);
  if (corpusErrors.length) {
    console.error('corpus inválido:');
    for (const e of corpusErrors) console.error(`  ${e}`);
    process.exitCode = 3;
    return;
  }
  if (flags.dryRun) {
    dryRun(cfg);
    return;
  }
  const key = loadKey();
  if (!key) {
    console.error('TYPESAFE_API_KEY ausente (.env ou env). Para validar SEM rede use --dry-run.');
    process.exitCode = 2;
    return;
  }
  try {
    const authFatal = await online(cfg, key);
    if (authFatal) process.exitCode = 1;
  } catch (e) {
    console.error('falha inesperada na corrida:', e?.message || e);
    process.exitCode = 1;
  }
}

main();
