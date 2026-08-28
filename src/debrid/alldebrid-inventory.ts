import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { raceWithDeadline } from '../utils/deadline.js';
import { call, type AllDebridMagnet } from './alldebrid-api.js';

/**
 * Inventário de referência por conta: os hashes que JÁ estavam lá antes de o
 * addon começar a trabalhar.
 *
 * Ele existe porque o /magnet/upload é idempotente e não diz se criou ou
 * reaproveitou — a resposta é `{magnet, hash, name, size, ready, id}`, sem
 * data. Sem essa referência, limpar os prontos apagaria também o filme que o
 * usuário guardou de propósito na conta, na primeira vez que ele aparecesse
 * numa busca.
 *
 * O boot aquece a conta do operador em segundo plano; para uma chave que chega
 * na primeira requisição, o primeiro upload espera o snapshot para não arriscar
 * classificar magnet do usuário como nosso. A referência expira: usuário também
 * administra a conta fora do addon, e snapshot congelado autorizaria apagá-lo.
 *
 * DONO ÚNICO do estado mutável do adaptador: os mapas `preexisting` e
 * `submitted` vivem só aqui, e os irmãos (checagem, play) importam a MESMA
 * referência — nenhum deles muta o estado diretamente.
 */
interface PreexistingEntry {
  hashes: Set<string> | null;
  loadedAt: number;
  promise?: Promise<Set<string> | null>;
}

export const preexisting = new Map<string, PreexistingEntry>();
// Upload é idempotente e a API não informa se criou ou reaproveitou o magnet.
// O que este processo submeteu nunca pode virar "preexistente" só porque o
// inventário assíncrono terminou depois do upload.
const submitted = new Map();

export function rememberSubmitted(account: string, hash: string) {
  const normalized = String(hash || '').toLowerCase();
  if (!normalized) return;
  let hashes = submitted.get(account);
  if (!hashes) {
    hashes = new Set();
    submitted.set(account, hashes);
  }
  hashes.add(normalized);
}

function snapshotFresh(entry: PreexistingEntry | undefined) {
  if (!entry || entry.hashes === null) return false;
  const ttl = config.debrid.preexistingTtlMs;
  return ttl > 0 && Date.now() - entry.loadedAt < ttl;
}

/**
 * Espera o inventário sem deixá-lo mandar no prazo da resposta.
 *
 * O teto existe porque esta chamada não tem relação com o que a busca precisa
 * responder: ela mora dentro da reserva do debrid (`DEBRID_RESERVE_MS`), e um
 * `/magnet/status` lento — conta grande, incidente na AllDebrid — passaria a
 * estourar o prazo de toda busca. Vencido o teto, quem chamou segue com `null`:
 * os prontos ficam protegidos nesta passada e o snapshot, que continua
 * carregando em fundo, vale da próxima em diante.
 */
export function waitInventory(promise: Promise<Set<string> | null> | undefined, timeoutMs?: number) {
  if (!promise) return Promise.resolve(null);
  const teto = Math.max(0, Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, config.debridCheckFloor));
  if (!teto) return Promise.resolve(null);
  return raceWithDeadline(promise, teto, () => {
    metrics.count('debrid.inventory.timeout');
    return null;
  });
}

export function knownBefore(apiKey: string, account: string): Set<string> | null {
  const entry = preexisting.get(account);
  if (snapshotFresh(entry)) return entry!.hashes;
  // Refresh já em voo: ninguém espera por ele aqui e ninguém usa a referência
  // velha — enquanto `hashes` for null, os prontos ficam protegidos.
  if (entry?.hashes === null) return null;

  // Enquanto o refresh está em voo, ninguém pode usar a referência velha para
  // apagar prontos. Falha de inventário mantém esse fail-safe e tenta de novo.
  const loading: PreexistingEntry = { hashes: null, loadedAt: 0 };
  preexisting.set(account, loading);
  loading.promise = call(apiKey, '/magnet/status')
    .then((data) => {
      const list: AllDebridMagnet[] = Array.isArray(data?.magnets) ? data.magnets : [];
      const snapshot = new Set<string>(list.map((m) => String(m.hash || '').toLowerCase()));
      const ours = submitted.get(account);
      const merged = ours?.size
        ? new Set([...snapshot].filter((hash) => !ours.has(hash)))
        : snapshot;
      loading.hashes = merged;
      loading.loadedAt = Date.now();
      log.info(
        `[alldebrid] ${merged.size} magnet(s) preexistente(s) na conta ficam protegidos da limpeza` +
          (ours?.size ? ` (${snapshot.size - merged.size} subido(s) pelo addon)` : ''),
      );
      return merged;
    })
    .catch((err) => {
      // Sem inventário não há o que proteger: a limpeza dos prontos continua
      // desligada, e a próxima busca tenta carregar de novo.
      log.warn('[alldebrid] não consegui inventariar a conta:', err.message);
      preexisting.delete(account);
      return null;
    });
  return null;
}

/** Pré-carrega o inventário do operador antes de qualquer upload no boot. */
export function warmInventory(apiKey: string) {
  if (!apiKey) return Promise.resolve(null);
  const account = accountScope(apiKey);
  knownBefore(apiKey, account);
  return preexisting.get(account)?.promise || Promise.resolve(null);
}

/**
 * Snapshot `knownBefore` AGUARDADO, para caminhos de FUNDO (varreduras
 * agendadas e limpezas manuais do painel) que não disputam o prazo da
 * resposta. O fail-safe fecha: `null` = sem prova de proveniência, e ausência
 * de referência NUNCA autoriza remoção — quem recebe null pula a rodada.
 */
export async function preexistingHashes(apiKey: string): Promise<Set<string> | null> {
  const account = accountScope(apiKey);
  const direto = knownBefore(apiKey, account);
  if (direto) return direto;
  const loading = preexisting.get(account);
  return raceWithDeadline(loading?.promise ?? Promise.resolve(null), 30_000, () => null);
}
