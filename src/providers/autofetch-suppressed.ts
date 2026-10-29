// Fila do que a remoção automática deixou de apagar.
//
// Quando o gate barra uma remoção (transferência identificada só pelo id, com
// `DEBRID_REMOVE_BY_ID` desligado), o recheck segue em frente: blacklista o
// hash, solta os holds e tira o hash do lote. Sem registro nenhum, aquele hash
// NUNCA mais é revisitado — e ligar o knob depois não alcançaria nada do que
// se acumulou enquanto ele esteve desligado, que era exatamente o fluxo
// prometido ("leia os contadores e então ligue").
//
// Este módulo guarda hash + id da transferência num registro durável para que
// a virada do knob seja retroativa. É deliberadamente separado do marker: o
// marker diz "já submetemos isto", este diz "isto deveria ter sido apagado".
//
// `via` descreve o CANAL de identificação, não a confiança: o `id` vem do
// nosso próprio marker de enqueue (src/providers/autofetch-marker.ts) e é
// prova de primeira mão. O gate que barra a remoção por `via === 'id'` é um
// FREIO DE ROLLOUT, não um juízo sobre o id — a conta que a ponte acabou de
// tornar visível não pode ser exposta à primeira rodada destrutiva no mesmo
// deploy. A inversão de precedência do `1a0d38c` empurrou para esta fila até
// transferências que o `name` da listagem identificaria: o conjunto suprimido
// cresceu de propósito, e é ele que o knob desligado mantém observável.
//
// Vida do registro: TTL PRÓPRIO de 30 dias (`DEBRID_SUPPRESSED_TTL`), que cobre
// o tempo real de observação do operador — o antigo `autoFetchDeadTtl` (24h)
// expirava registro bom no meio da decisão. Aposentar um id ruim NÃO é mais
// papel do relógio: o drain falha com backoff exponencial (5min..6h) e desiste
// em 5 falhas consecutivas (`autofetch.suppressed.givenup`). Forma do registro
// `{ id, at, fails, nextAt }`; registro antigo verificado antes da Etapa 2
// (`{ id, at }`) lê como `fails: 0, nextAt: 0` — sempre elegível.
//
// DONO ÚNICO DA ESCRITA: `autofetch:v3:sup:<adapter>:<account>:<hash>` é chave do
// KV nativo (`NativeKv` sobre a tabela `cache` do MESMO `cache.db`) — o worker a
// grava (`recheck_expire.rs` → `SuppressedV3::note`) e o dreno nativo a lê/apaga
// (`suppressed_step.rs`). Este módulo NÃO espelha nada no L1: escrita e remoção
// passam só pela ponte (`utils/autofetch-state-native.ts`). O `cache.set` de antes
// era segundo escritor da mesma linha, e o `cache.forget` (DELETE no SQLite do
// Node) podia apagar a linha FRESCA do nativo no meio de uma passagem dele. Por
// isso `sup:` está em `AUTOFETCH_NATIVE_PREFIXES` (`src/utils/cache-keys.ts`): o
// L1 recusa escrita e remoção, e a leitura (painel) cai na ponte.
//
// O DRENO não mora aqui: o automático é do worker nativo e a ação do painel
// fala só com a admin do gateway. Um dreno local seria segundo dono da represa
// (e, no Real-Debrid, escrita na conta fora do `shared_gate`); a régua TS de
// antes vive como oráculo em `test/helpers/pipeline-oracle/autofetch-suppressed-drain.ts`.
//
// O gate também cobre `expired-unready`: transferência identificada só por id
// é represada aqui quando `DEBRID_REMOVE_BY_ID=false`, em vez de ser apagada
// diretamente ao vencer o settle. Assim o painel enxerga e cobra toda remoção
// por id que o freio de rollout adiou.
import { prefix } from '../utils/cache-keys.js';
import {
  forgetSuppressedNative,
  listSuppressedKeysNative,
  noteSuppressedNative,
  readSuppressedNative,
  remainingNative,
} from '../utils/autofetch-state-native.js';
import config from '../config.js';
import * as metrics from '../utils/metrics.js';

const SUP_PREFIX = `${prefix('autofetch')}sup:`;

// Índice de processo das chaves `sup:` vivas. O agregado do painel conta a cada
// poll e não pode varrer o KV inteiro. Este Set espelha o que a ponte gravou,
// mantido pelas únicas operações que mudam o conjunto (note/forget/givenup) e
// reindexado no boot (`reindexSuppressed`, mesma garantia do reindexDead).
const knownSuppressed = new Set<string>();

// O backoff (5min dobrando, teto 6h) e a desistência na 5ª falha moram no
// nativo (`SuppressedV3::retry`, mesma régua de `suppressed.rs`). O Node não
// recalcula `fails`/`nextAt`: seria segundo escritor dos MESMOS campos.

type SuppressedRead = {
  id: string;
  at: number;
  fails: number;
  nextAt: number;
};

/** Endereço do registro: também exportado para o teste inspecionar o estado. */
function suppressedKey(adapterId: string, account: string, infoHash: string) {
  return `${SUP_PREFIX}${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}

function remaining(key: string): number | null {
  // Só a ponte responde: o L1 não tem linha `sup:` desde que o prefixo entrou
  // em `AUTOFETCH_NATIVE_PREFIXES` (um fallback aqui leria sempre null).
  return remainingNative(key) ?? null;
}

/**
 * Lê o registro SEM efeito (peek não promove o LRU nem conta métrica). Registro
 * antigo `{ id, at }` lê como `fails: 0, nextAt: 0` — mesma tolerância que o
 * markerValue tem com os `1` já gravados: registro sem os campos novos é um
 * represado que ainda não falhou.
 */
function readSuppressed(key: string): SuppressedRead {
  const parts = key.startsWith(SUP_PREFIX) ? key.slice(SUP_PREFIX.length).split(':') : [];
  const stored = (parts.length >= 3
    ? readSuppressedNative(parts[0], parts[1], parts.slice(2).join(':'))
    : null) as { id?: unknown; at?: unknown; fails?: unknown; nextAt?: unknown } | null;
  if (!stored || typeof stored !== 'object' || stored.id == null) {
    return { id: '', at: 0, fails: 0, nextAt: 0 };
  }
  return {
    id: String(stored.id),
    at: typeof stored.at === 'number' ? stored.at : 0,
    fails: typeof stored.fails === 'number' && stored.fails > 0 ? Math.trunc(stored.fails) : 0,
    nextAt: typeof stored.nextAt === 'number' ? stored.nextAt : 0,
  };
}

/**
 * Registra uma remoção barrada pelo gate. Sem id não há o que apagar depois.
 * Reescrever preserva o TTL RESTANTE (remainingNative): evento novo reseta o
 * backoff, mas um registro que já espera há 20 dias não renasce de 30 por um
 * re-note.
 */
function noteSuppressed(
  adapterId: string,
  account: string,
  infoHash: string,
  transferId: string | number | null | undefined,
  ttlSeconds = config.debrid.suppressedTtl,
) {
  if (!adapterId || !account || !infoHash) return;
  if (transferId == null || transferId === '') return;
  const key = suppressedKey(adapterId, account, infoHash);
  const restante = remainingNative(key);
  const ttl = restante != null && restante > 0 ? restante : ttlSeconds;
  // A escrita é da ponte, e só dela: `note` no nativo grava o MESMO registro
  // `{ id, at, fails: 0, nextAt: 0 }` que o `cache.set` gravava e preserva o TTL
  // restante (`SuppressedV3::note`). Sem espelho no L1.
  if (noteSuppressedNative(adapterId, account, infoHash, String(transferId), ttl) !== true) return;
  knownSuppressed.add(key);
}

/**
 * Leitura por adapter/conta APOIADA NO ÍNDICE de processo (`knownSuppressed`),
 * não na enumeração do namespace. `listAllSuppressed` varre o KV inteiro por
 * prefixo e existe para passagens pontuais (painel/drain); o revalidate de fundo
 * roda a cada busca e não pode pagar essa varredura. O índice é populado por
 * note/forget e reconstruído no boot (`reindexSuppressed`) — a MESMA garantia de
 * durabilidade do painel. Chave expirada ainda não podada é descartada aqui.
 */
function listSuppressedForAccount(adapterId: string, account: string): Array<SuppressedRead & { hash: string }> {
  const escopo = `${SUP_PREFIX}${adapterId}:${account}:`;
  const out: Array<SuppressedRead & { hash: string }> = [];
  for (const key of [...knownSuppressed]) {
    if (!key.startsWith(escopo)) continue;
    if (remaining(key) == null) {
      knownSuppressed.delete(key);
      continue;
    }
    const rec = readSuppressed(key);
    if (!rec.id) continue;
    out.push({ hash: key.slice(escopo.length), ...rec });
  }
  return out;
}

/** Leitura COMPLETA (com e sem elegibilidade), por adapter/conta. */
function listAllSuppressed(adapterId: string, account: string): Array<SuppressedRead & { hash: string }> {
  const escopo = `${SUP_PREFIX}${adapterId}:${account}:`;
  const out: Array<SuppressedRead & { hash: string }> = [];
  // Enumeração pela ponte, e só por ela: o L1 do Node não tem (nem aceita)
  // linha `sup:`, então não existe segunda fonte a somar. O caminho quente do
  // PAINEL (agregado de todas as contas) usa o índice `knownSuppressed`; esta é
  // a leitura por conta, que age em passagens pontuais, não em poll.
  for (const key of (listSuppressedKeysNative() || []).filter((key) => key.startsWith(escopo))) {
    const rec = readSuppressed(key);
    if (!rec.id) continue;
    knownSuppressed.add(key);
    out.push({ hash: key.slice(escopo.length), ...rec });
  }
  return out;
}

/**
 * ELEGÍVEIS para o drain: registros cujo `nextAt` já passou (registro novo e o
 * legado `{ id, at }` nascem com nextAt 0 — sempre elegíveis).
 */
function listSuppressed(adapterId: string, account: string, agora = Date.now()) {
  return listAllSuppressed(adapterId, account).filter((reg) => reg.nextAt <= agora);
}

function forgetSuppressed(adapterId: string, account: string, infoHash: string) {
  const key = suppressedKey(adapterId, account, infoHash);
  knownSuppressed.delete(key);
  // Remoção pela ponte (`kvForget` sob o capô). O `cache.forget` de antes era um
  // DELETE no MESMO SQLite que o worker lê — podia apagar a linha fresca dele.
  forgetSuppressedNative(adapterId, account, infoHash);
}

/** Profundidade COMPLETA da fila de uma conta (painel: o que aguarda decisão). */
function countSuppressed(adapterId: string, account: string) {
  return listAllSuppressed(adapterId, account).length;
}

/** Agregado de TODAS as contas/adapters, sem varrer o namespace: índice de processo. */
function countAllSuppressed(): number {
  let total = 0;
  for (const key of knownSuppressed) {
    if (remaining(key) == null) {
      knownSuppressed.delete(key);
      continue;
    }
    total += 1;
  }
  return total;
}

/**
 * Reconstrói o índice de processo no boot: enumera o KV nativo UMA vez (despesa
 * única) e espelha o que sobreviveu ao restart. Depois disso o conjunto só muda
 * pelas operações do próprio módulo — `countAllSuppressed` fica O(índice), não
 * O(namespace).
 */
function reindexSuppressed() {
  let n = 0;
  for (const key of listSuppressedKeysNative() || []) {
    if (knownSuppressed.has(key)) continue;
    if (readSuppressed(key).id) {
      knownSuppressed.add(key);
      n += 1;
    }
  }
  if (n > 0) metrics.count('autofetch.suppressed.reindexed', n);
  return n;
}

reindexSuppressed();

export {
  noteSuppressed,
  listSuppressed,
  listAllSuppressed,
  listSuppressedForAccount,
  forgetSuppressed,
  countSuppressed,
  countAllSuppressed,
  suppressedKey,
  reindexSuppressed,
};
