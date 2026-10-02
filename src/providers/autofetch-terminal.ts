// Colapso de um hash TERMINAL (morto/parado) do lote do recheck — extraído do
// `runRecheck` para a catraca de linhas e para concentrar num só ponto a
// decisão de REMOÇÃO, que é a operação mais cara do ciclo.
//
// Duas origens chegam aqui:
//
// - `native`: `dead` ou `stalled` NATIVO do adaptador (TorBox/Premiumize). A
//   remoção direta só acontece quando `via !== 'id'` OU `DEBRID_REMOVE_BY_ID`;
//   o que o gate barra vai para a fila de represados (`autofetch-suppressed`)
//   e a limpeza terminal fica com o `sweepDead`/painel.
//
// - `progress`: parada DERIVADA por progresso (Fase 3, hoje AllDebrid). NUNCA
//   aciona `removeTorrent` direto, nem com o knob ligado: registra na fila de
//   represados (quando há id) e delega a limpeza. A derivação prova que o
//   download parou, não que apagá-lo é decisão do ciclo automático.
//
// O dreno da fila NÃO é feito aqui: quem chama decide, porque o dreno é do
// recheck e depende do `searchKey` do lote.

import config from '../config.js';
import * as held from '../debrid/protected.js';
import * as autofetch from './autofetch.js';
import * as suppressed from './autofetch-suppressed.js';
import * as releaseIndex from '../utils/release-index.js';
import { forgetObraHash } from './autofetch-obra.js';
import { forgetProgress } from './autofetch-progress.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { DebridAdapter, TorrentStatusEntry } from '../../types/domain.js';

/** Identidade mínima da obra que o lote guarda por hash (ver SeasonHint). */
export type CollapseHint = {
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  isPack?: boolean;
};

/** Tipo estrutural do lote: o módulo não importa `RecheckLot` (evita ciclo). */
export type CollapseLot = {
  hashes: Set<string>;
  deadStreak: Map<string, number>;
  stallStreak: Map<string, number>;
  seasonHints: Map<string, CollapseHint>;
};

/**
 * Tira o hash dos mapas do lote e limpa a memória de progresso dele. Sem o
 * segundo passo um hash reenfileirado herdaria streak residual da janela
 * anterior (a memória é por processo, não por lote).
 */
export function cleanLotHash(lot: CollapseLot, hash: string, adapterId: string, account: string): void {
  lot.hashes.delete(hash);
  lot.deadStreak.delete(hash);
  lot.stallStreak.delete(hash);
  lot.seasonHints.delete(hash);
  forgetProgress(adapterId, account, hash);
}

export type CollapseArgs = {
  adapter: DebridAdapter;
  account: string;
  apiKey: string;
  hash: string;
  searchKey: string;
  statusInfo: TorrentStatusEntry;
  /** Observações consecutivas que levaram ao colapso (log). */
  streak: number;
  /** Origem do sinal: nativo do adaptador ou derivado por progresso. */
  mode: 'native' | 'progress';
  reason: 'dead' | 'stalled' | 'progress';
};

const COUNT_NAME: Record<CollapseArgs['reason'], string> = {
  dead: 'autofetch.dead',
  stalled: 'autofetch.stalled',
  progress: 'autofetch.progress.stalled',
};

const REASON_LABEL: Record<CollapseArgs['reason'], string> = {
  dead: 'morto',
  stalled: 'parado',
  progress: 'parado (progresso)',
};

/**
 * Colapsa o hash: blacklist, libera a vaga da obra, decide a remoção e destrava
 * o registro da obra. Devolve `true` quando a remoção DIRETA foi disparada.
 */
export function collapseTerminal(lot: CollapseLot, args: CollapseArgs): boolean {
  const { adapter, account, apiKey, hash, searchKey, statusInfo, streak, mode, reason } = args;
  metrics.count(COUNT_NAME[reason]);
  autofetch.blacklist(adapter.id, account, hash);
  const obraHint = lot.seasonHints.get(hash);
  releaseIndex.forgetAutofetchHash(obraHint?.imdbId, hash);
  held.unprotect(adapter.id, account, hash);
  held.release(hash, account);

  let removido = false;
  if (mode === 'progress') {
    // Derivado por progresso: nunca apaga direto. Registra para a fila de
    // represados (drenada pelo knob/painel) e deixa o resto para a limpeza
    // terminal — `sweepDead`/painel.
    if (statusInfo.id != null) {
      suppressed.noteSuppressed(adapter.id, account, hash, statusInfo.id);
      metrics.count('autofetch.progress.suppressed');
    }
  } else {
    const podeRemover = statusInfo.via !== 'id' || config.debrid.removeById;
    if (!podeRemover) {
      metrics.count(reason === 'dead' ? 'autofetch.dead.suppressed' : 'autofetch.stalled.suppressed');
      suppressed.noteSuppressed(adapter.id, account, hash, statusInfo.id);
    } else if (typeof adapter.removeTorrent === 'function' && statusInfo.id != null) {
      adapter.removeTorrent(apiKey, statusInfo.id).catch(() => {});
      removido = true;
    }
  }

  // Hash TERMINAL libera a vaga da obra ANTES do dreno: a reposição SAME POOL
  // precisa caber ainda na janela, sem esperar a eviction (F6).
  forgetObraHash({
    adapterId: adapter.id,
    account,
    imdbId: obraHint?.imdbId ?? null,
    season: obraHint?.season ?? null,
    episode: obraHint?.isPack ? null : (obraHint?.episode ?? null),
    isPack: obraHint?.isPack === true,
    searchKey,
    hash,
  });
  cleanLotHash(lot, hash, adapter.id, account);
  log.info(
    `[autofetch] torrent ${hash} detectado como ${REASON_LABEL[reason]} (${streak} rechecks consecutivos); ` +
    (removido ? 'removendo e drenando fila' : 'drenando fila (remoção direta barrada)'),
  );
  return removido;
}
