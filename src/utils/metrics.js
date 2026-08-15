/**
 * Contadores e latências em memória, para responder as perguntas que hoje só
 * dá pra responder relendo log: o cache está pegando? qual indexador está
 * puxando o prazo? o download automático está mesmo rodando?
 *
 * Fica tudo em memória e zera no restart — é diagnóstico de operação, não série
 * histórica. Um reservatório de tamanho fixo por métrica limita o custo: nada
 * aqui cresce com o volume de buscas.
 */
const SAMPLES = 256;

const counters = new Map();
const timers = new Map();
const startedAt = Date.now();

function count(name, delta = 1) {
  counters.set(name, (counters.get(name) || 0) + delta);
}

/** Guarda uma medição de duração. Só as últimas SAMPLES entram no percentil. */
function observe(name, ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return;

  let timer = timers.get(name);
  if (!timer) {
    timer = { count: 0, sum: 0, max: 0, ring: new Float64Array(SAMPLES), filled: 0, next: 0 };
    timers.set(name, timer);
  }
  timer.count += 1;
  timer.sum += value;
  timer.max = Math.max(timer.max, value);
  timer.ring[timer.next] = value;
  timer.next = (timer.next + 1) % SAMPLES;
  timer.filled = Math.min(timer.filled + 1, SAMPLES);
}

/** Cronômetro de um trecho; devolve a duração para quem também quiser logar. */
function timed(name) {
  const started = Date.now();
  return () => {
    const ms = Date.now() - started;
    observe(name, ms);
    return ms;
  };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Math.round(sorted[index]);
}

function snapshot() {
  const timings = {};
  for (const [name, timer] of timers) {
    const sorted = Array.from(timer.ring.subarray(0, timer.filled)).sort((a, b) => a - b);
    timings[name] = {
      count: timer.count,
      avgMs: timer.count ? Math.round(timer.sum / timer.count) : 0,
      // p50/p95 da JANELA (últimas SAMPLES), não da vida do processo: é o que
      // responde "está lento AGORA".
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: Math.round(timer.max),
    };
  }
  return {
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    counters: Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
    timers: timings,
  };
}

/** Só para teste: o processo real acumula desde a subida. */
function reset() {
  counters.clear();
  timers.clear();
}

module.exports = { count, observe, timed, snapshot, reset };
