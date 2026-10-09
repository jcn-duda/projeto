// Resumo do Chupim dentro do /stream-trace.json (Fase 7 do Chupim 2.0).
//
// O ledger do P5 (stream-trace) registra item a item por que cada release
// caiu, mas não diz NADA sobre a decisão do autofetch daquela build: qual pool
// foi escolhido, se o pool seeds foi bloqueado por política/sonda e em que
// estágio a sonda dirigida estava. Este módulo monta essa linha — três tokens
// de enum, formato estável:
//
//   pool=br|any|seeds|none; seeds=allowed|blocked:<motivo>|n/a; probe=<estado>
//
// NUNCA carrega hash, imdbId, conta, chave ou título: só rótulos de decisão.
// A escrita vai para o `StreamTraceState` da build (o mesmo que viaja no cache
// da entrada `streams`) e é last-writer entre seleção e despacho — os dois
// pontos onde o Chupim decide. O kill-switch STREAM_TRACE desliga a escrita e
// a leitura (setTraceChupim + serializeTrace).
import { setTraceChupim } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';
import { probeState, type BrProbeWork } from './br-probe.js';

export type ChupimPool = 'br' | 'any' | 'seeds' | 'none';
/** `n/a` = o pool seeds nem foi avaliado (br/any já cobriram a busca). */
export type ChupimSeeds = 'allowed' | 'n/a' | `blocked:${string}`;

/** Estado da sonda da obra, ou `off` quando ela não se aplica. */
export function chupimProbeLabel(work: BrProbeWork | null | undefined): string {
  return work ? probeState(work) : 'off';
}

/** Escreve o resumo no trace da build (no-op sem trace / kill-switch off). */
export function writeChupimTrace(
  trace: StreamTraceState | null | undefined,
  input: { pool: ChupimPool; seeds: ChupimSeeds; probe: string },
): void {
  setTraceChupim(trace, `pool=${input.pool}; seeds=${input.seeds}; probe=${input.probe}`);
}
