/**
 * Régua TS da varredura do Premiumize (`sweepDead`), congelada no oráculo.
 *
 * Produção não roda isto: a varredura do Premiumize é a rota nativa
 * `/debrid/sweep-dead` do adom-debrid (8710), chamada por
 * `src/debrid/rust-sweep.ts`. Este corpo saiu de `src/debrid/premiumize.ts` e
 * fica aqui só para os testes de paridade e para a régua de `premiumize-sweep-dead`.
 * Mudou a regra no Rust? Atualize o port e este arquivo juntos.
 */
import { assertSafeTestDb } from '../../db-guard.js';
import config from '../../../../src/config.js';
import * as metrics from '../../../../src/utils/metrics.js';
import * as log from '../../../../src/utils/logger.js';
import * as held from '../../../../src/debrid/protected.js';
import { accountScope } from '../../../../src/utils/request-key.js';
import { markerIdIndex } from '../../../../src/providers/autofetch-marker.js';
import {
  id, call, removeTorrent, resolveTransfer, transferHash, STALLED_TRANSFER,
} from '../../../../src/debrid/premiumize.js';
assertSafeTestDb('pipeline-oracle/debrid-bodies/premiumize-sweep');

/**
 * Quando cada hash foi visto parado pela primeira vez.
 *
 * O `/transfer/list` do Premiumize não devolve data nenhuma — não há campo de
 * criação, só `status`, `progress` e `message` (confirmado na API: as chaves
 * são file_id, folder_id, id, message, name, other_cloud_id, progress, src,
 * status). Sem carimbo de tempo, `minAgeMs` não tem de onde ser calculado, e
 * apagar na primeira observação mataria justamente a transferência recém-criada
 * pelo autofetch — que nasce em "0 Bytes of 0 Bytes, from 0 peer" enquanto
 * procura pares.
 *
 * O `held` já protege esse caso, mas vive em memória e some no restart. Este
 * mapa reconstrói a idade por observação: a primeira varredura anota, e só uma
 * varredura posterior, passado `minAgeMs`, remove. É a mesma dupla observação
 * que o recheck exige antes de matar um torrent.
 */
const stallSeenAt = new Map<string, number>();

/**
 * Varre da conta as transferências terminais e as paradas de vez.
 *
 * Existe porque o recheck só alcança o que está num lote vivo: `recheckLots`
 * é de memória e o restart o zera, então transferência enfileirada por um
 * processo anterior fica parada para sempre, ocupando vaga da conta e nunca
 * sendo reavaliada por ninguém. Não há mais agendador no Node: as varreduras
 * periódicas da conta do operador são NATIVAS (`al_sweeps`, AllDebrid); este
 * método segue chamável por diagnóstico/teste.
 */
async function sweepDead(apiKey: string, { minAgeMs = config.debrid.sweepDeadMinAgeMs } = {}) {
  const account = accountScope(apiKey);
  const data = await call(apiKey, '/transfer/list');
  const transfers = Array.isArray(data?.transfers) ? data.transfers : [];
  const idade = Math.max(0, Number(minAgeMs) || 0);
  const agora = Date.now();
  const byId = markerIdIndex(id, account);

  const alvo: any[] = [];
  const vistosAgora = new Set<string>();
  for (const t of transfers) {
    if (t?.id == null) continue;
    const status = String(t?.status || '').toLowerCase();

    // Erro é terminal: some independente de hash, idade ou proteção.
    if (status === 'error') {
      alvo.push(t);
      continue;
    }
    if (status !== 'running') continue;

    const progress = Number(t?.progress);
    const moving = Number.isFinite(progress) && progress !== 0;
    if (moving || !STALLED_TRANSFER.test(String(t?.message || ''))) continue;

    // Parada, mas só removível quando dá para provar que não é do autofetch
    // em curso. A cascata de campos falha justamente no caso mais comum da
    // fila: post de agregador entra com nome humano ("[WWW.BLUDV.TV] ...
    // [DUBLADO]"), sem hash em `src`, `name` ou `hash` — e ficava fora da
    // varredura para sempre, ocupando vaga. O mapa dos markers (mesma ponte
    // id -> hash que o recheck usa, aqui reconstruída do cache porque o lote
    // não sobrevive ao restart) devolve a identificação e com ela o `held`.
    const achado = resolveTransfer(t, byId);
    const hash = achado?.hash || null;
    if (!hash || held.isHeld(hash, account)) continue;

    vistosAgora.add(hash);
    const desde = stallSeenAt.get(hash);
    if (desde == null) {
      stallSeenAt.set(hash, agora);
      continue;
    }
    if (agora - desde >= idade) alvo.push(t);
  }

  // Quem voltou a andar (ou saiu da conta) perde o histórico de parada.
  for (const hash of stallSeenAt.keys()) {
    if (!vistosAgora.has(hash)) stallSeenAt.delete(hash);
  }

  if (!alvo.length) return { varridos: 0, falhas: 0, observados: vistosAgora.size };

  let ok = 0;
  let falhas = 0;
  for (const t of alvo) {
    if (await removeTorrent(apiKey, t.id)) {
      ok += 1;
      const hash = transferHash(t);
      if (hash) stallSeenAt.delete(hash);
    } else {
      falhas += 1;
    }
  }

  metrics.count('debrid.swept', ok);
  const sufixo = falhas ? ` — ${falhas} falhou(ram)` : '';
  log.info(`[premiumize] varredura: ${ok}/${alvo.length} transferência(s) morta(s) ou parada(s) removida(s)${sufixo}`);
  return { varridos: ok, falhas, observados: vistosAgora.size };
}

/** Só para teste: a memória de paradas é de processo. */
function resetStallMemory() {
  stallSeenAt.clear();
}


export { sweepDead, resetStallMemory };
