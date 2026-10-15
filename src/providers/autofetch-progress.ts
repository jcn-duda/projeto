// Derivação CONSERVADORA de parada por progresso (Fase 3 do Chupim 2.0).
//
// Serviços com `progress` medido (hoje só o AllDebrid: `downloaded`/`size`/
// `downloadSpeed`/`seeders` do `/magnet/status`) não têm sinal NATIVO de
// parada. Sem ele, o recheck só via "downloading" e o lote entrava em settle
// sem repor nada — o download que nunca termina ocupava a vaga até o TTL.
//
// Este módulo guarda, POR `adapter:account:hash`, os últimos bytes vistos e o
// streak de observações CONSECUTIVAS paradas. Um hash vira `stalled` derivado
// SÓ quando bytes e velocidade ficam parados por N rechecks seguidos; qualquer
// evidência contrária zera. Falso positivo aqui condena um download que ainda
// esquentava, então a regra erra para o lado de NÃO condenar:
//
// - bytes crescendo: movimento real, zera o streak;
// - `speed > 0` é movimento e zera/reinicia o streak, mesmo com `seeders: 0`
//   (seeders zero nunca sobrepõe velocidade positiva);
// - regressão de bytes (contador resetado) ou troca da transferência (mesmo
//   hash reenviado, id diferente): SEM sinal, memória reiniciada;
// - `total <= 0`, `bytes >= total`, campos ausentes/não numéricos, `status`
//   sem progresso ou state diferente de `downloading` (queued/processing/
//   unknown/ready/dead): SEM sinal — mantém o legado (`stalled` nativo do
//   adaptador, se houver);
// - `threshold <= 0` (STALL_STREAK=0) desliga a derivação por inteiro.
//
// A memória é de PROCESSO e por isso precisa ser limpa no fim do lote
// (ready/dead/parado/expira/evicção do LRU de settle): hash reenfileirado não
// pode herdar streak residual de uma janela anterior.

import type { TorrentStatusEntry } from '../../types/domain.js';

type ProgressMemory = { lastBytes: number; lastId: string; streak: number };
const memory = new Map<string, ProgressMemory>();

function memoryKey(adapterId: string, account: string, hash: string): string {
  return `${adapterId}:${account}:${String(hash || '').toLowerCase()}`;
}

export type ProgressLot = {
  adapterId: string;
  account: string;
  hashes: Iterable<string>;
  /** `autoFetchStallStreak`; <= 0 desliga a derivação. */
  threshold: number;
};

export type ProgressDerivation = {
  /** Hashes que cruzaram o limiar: o recheck colapsa como PARADO derivado. */
  stalled: Set<string>;
  /** Quantos hashes trouxeram progresso VÁLIDO nesta passagem (observável). */
  signals: number;
};

/**
 * Lê o progresso da passagem, atualiza a memória e devolve os hashes que
 * cruzaram o limiar. Puro quanto a rede: só olha `statuses`.
 */
export function deriveStall(lot: ProgressLot, statuses: Record<string, TorrentStatusEntry>): ProgressDerivation {
  const stalled = new Set<string>();
  let signals = 0;
  for (const rawHash of lot.hashes) {
    const hash = String(rawHash || '').toLowerCase();
    const status = statuses[hash] ?? statuses[rawHash];
    const k = memoryKey(lot.adapterId, lot.account, hash);
    const p = status?.progress;
    // Sem progresso = serviço sem sinal (ou item pronto/morto). Mantém o
    // legado e NÃO mexe na memória: uma janela sem campo não é prova de nada.
    if (!status || !p) continue;
    // Só download ATIVO vira parada: queued/processing/unknown/ready/dead não.
    if (status.state !== 'downloading') continue;
    const bytes = Number(p.bytes);
    const total = Number(p.total);
    const speed = Number(p.speed);
    const seeders = Number(p.seeders);
    if (!Number.isFinite(bytes) || !Number.isFinite(total) || !Number.isFinite(speed)
      || !Number.isFinite(seeders) || total <= 0 || bytes < 0) {
      continue;
    }
    // Completo/limítrofe (bytes >= total) não é parada útil — o ready cuida.
    if (bytes >= total) continue;
    signals += 1;
    const id = status.id != null ? String(status.id) : '';
    const prev = memory.get(k);
    // Troca da transferência: a leitura anterior era de OUTRO download.
    if (prev && prev.lastId && id && prev.lastId !== id) {
      memory.set(k, { lastBytes: bytes, lastId: id, streak: 0 });
      continue;
    }
    if (!prev) {
      memory.set(k, { lastBytes: bytes, lastId: id, streak: 0 });
      continue;
    }
    // Regressão de bytes: sem sinal, reinicia a janela.
    if (bytes < prev.lastBytes) {
      memory.set(k, { lastBytes: bytes, lastId: id, streak: 0 });
      continue;
    }
    // Bytes crescendo: movimento real, zera o streak.
    if (bytes > prev.lastBytes) {
      memory.set(k, { lastBytes: bytes, lastId: id, streak: 0 });
      continue;
    }
    // Bytes parados. Velocidade POSITIVA é evidência de movimento e zera —
    // mesmo com `seeders: 0`, que nunca sobrepõe a velocidade. Só a ausência
    // de movimento (speed <= 0) deixa o streak acumular.
    if (speed > 0) {
      memory.set(k, { lastBytes: bytes, lastId: id, streak: 0 });
      continue;
    }
    const streak = prev.streak + 1;
    memory.set(k, { lastBytes: bytes, lastId: id, streak });
    if (lot.threshold > 0 && streak >= lot.threshold) stalled.add(hash);
  }
  return { stalled, signals };
}

/** Limpa a memória de UM hash (fim do hash no lote). */
export function forgetProgress(adapterId: string, account: string, hash: string): void {
  memory.delete(memoryKey(adapterId, account, hash));
}

/** Limpa a memória de um lote inteiro (expira/evicção). */
export function forgetLotProgress(adapterId: string, account: string, hashes: Iterable<string>): void {
  for (const hash of hashes) memory.delete(memoryKey(adapterId, account, hash));
}

/** Tamanho da memória — observabilidade de vazamento em teste/painel. */
export function progressMemorySize(): number {
  return memory.size;
}
