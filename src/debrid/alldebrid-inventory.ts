import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { raceWithDeadline } from '../utils/deadline.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
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
  // Snapshot ANTERIOR, retido durante o refresh: o upload que acontece
  // enquanto o novo `/magnet/status` está em voo precisa de uma referência
  // para a prova de criação (8.15) — sem ela, toda busca que coincidisse com
  // o refresh (uma a cada `preexistingTtlMs`) perderia a etiqueta.
  previous?: Set<string> | null;
}

export const preexisting = new Map<string, PreexistingEntry>();
// Upload é idempotente e a API não informa se criou ou reaproveitou o magnet.
// O que este processo submeteu nunca pode virar "preexistente" só porque o
// inventário assíncrono terminou depois do upload.
//
// Fase 8 (8.15): hash → quando foi submetido. A catraca que encheu a conta
// (904 magnets em 8 dias com o autofetch gateado) morava aqui: o Map morria no
// restart e o snapshot seguinte classificava TUDO como acervo do usuário
// (`knownBefore`), imune à limpeza — cada deploy lavava a própria sujeira. A
// etiqueta agora também persiste em `adsub:v1` (TTL
// `alldebridSubmittedTtlMs`) e sobrevive ao restart.
const submitted = new Map<string, Map<string, number>>();

/** Chave durável de posse, mesmo formato do adprot: conta + hash, sem segredo. */
const adsubKey = (account: string, hash: string) => `${prefix('adsub')}${account}:${hash}`;

/**
 * Etiqueta "nosso" COM a regra de proveniência do 8.15 — para TODO chamador,
 * sem exceção. O upload é idempotente e a resposta não diz se criou ou
 * reaproveitou — etiquetar sem prova reintroduz a perda que a Fase 1 (B1)
 * corrigiu, com polaridade invertida: o magnet legítimo do usuário que uma
 * busca toca seria reclassificado como lixo nosso para sempre. Só etiqueta
 * quando um snapshot da conta — o corrente, ou o anterior durante o refresh —
 * prova que o hash NÃO estava lá: então o upload criou. Sem snapshot
 * (inventário frio, conta grande no primeiro request) NÃO etiqueta: o
 * fail-safe fecha no lado que protege, e o pior caso é o lixo frio ficar
 * protegido até a próxima busca com inventário quente — nunca o contrário.
 *
 * O enqueue do autofetch usa esta MESMA regra (resíduo aceito: o download
 * subido sem referência pode virar "preexistente" no snapshot seguinte — o
 * held do autofetch e a janela do TTL limitam o dano; a polaridade errada
 * aqui seria etiquetar acervo do usuário, e essa nunca mais volta).
 */
export function rememberSubmitted(account: string, hash: string) {
  const normalized = String(hash || '').toLowerCase();
  if (!normalized) return;
  const entry = preexisting.get(account);
  const referencia = entry?.hashes ?? entry?.previous ?? null;
  if (!referencia || referencia.has(normalized)) return;
  let hashes = submitted.get(account);
  if (!hashes) {
    hashes = new Map();
    submitted.set(account, hashes);
  }
  const at = Date.now();
  hashes.set(normalized, at);
  // Write-through durável: o registro é o que faz a posse sobreviver ao
  // restart. TTL 0 = só memória (rollback de uma linha no .env).
  const ttlMs = config.debrid.alldebridSubmittedTtlMs;
  if (ttlMs > 0) {
    cache.set(adsubKey(account, normalized), { at }, Math.floor(ttlMs / 1000));
    metrics.count('adsub.persisted');
  }
}

/** Prova durável de posse: registro `adsub` ainda válido para este hash. */
function persistedSubmitted(account: string, hash: string): boolean {
  if (config.debrid.alldebridSubmittedTtlMs <= 0) return false;
  return cache.peek(adsubKey(account, hash)) != null;
}

/**
 * Timestamp da posse ativa de um hash (o `at` do adsub), para o reconcile
 * distinguir "nosso desde a etiqueta" de re-add do usuário. Memória e registro
 * durável são consultados e o MAIS NOVO vence — o re-add do usuário acontece
 * sempre DEPOIS da etiqueta original, e é exatamente contra ele que a margem
 * anti-re-add compara. `null` = sem posse ativa (nunca fomos donos, ou a
 * etiqueta já expirou/purgada). Leitura via `peek`: varredura de fundo não
 * promove LRU nem conta hit/miss.
 */
export function submittedAt(account: string, hash: string): number | null {
  const normalized = String(hash || '').toLowerCase();
  if (!normalized) return null;
  const memoria = submitted.get(account)?.get(normalized) ?? 0;
  let duravel = 0;
  if (config.debrid.alldebridSubmittedTtlMs > 0) {
    const registro = cache.peek(adsubKey(account, normalized)) as { at?: number } | null;
    if (registro && Number(registro.at) > 0) duravel = Number(registro.at);
  }
  if (memoria && duravel) return Math.max(memoria, duravel);
  return memoria || duravel || null;
}

/**
 * Purga da posse: o hash saiu da conta por limpeza NOSSA (dropReady/
 * dropDownload/reconcile). Deixar o registro de pé faria o snapshot seguinte
 * subtrair do acervo protegido um hash que nem está mais lá e — pior —
 * esconderia um re-add legítimo (do usuário) da prova de criação. Falha de
 * delete NÃO purga: o magnet continua na conta e continua sendo nosso.
 */
export function forgetSubmitted(account: string, hash: string): void {
  const normalized = String(hash || '').toLowerCase();
  if (!normalized) return;
  submitted.get(account)?.delete(normalized);
  if (config.debrid.alldebridSubmittedTtlMs > 0) cache.forget(adsubKey(account, normalized));
}

/**
 * Espera EXISTIR referência de proveniência para a conta (snapshot corrente,
 * ou o anterior durante o refresh), com teto. Para o enqueue do autofetch:
 * ele é background e pode aguardar um instante a referência antes de decidir
 * a etiqueta — sem isso o primeiro download de conta fria nunca seria
 * etiquetado (o fail-safe do rememberSubmitted fecharia sobre ele) e viraria
 * "preexistente" no snapshot seguinte, a catraca pelo caminho do chupim.
 *
 * Nunca lança e nunca espera além do teto: vencido, devolve false e quem
 * chamou segue sem referência (o rememberSubmitted NÃO etiqueta — fail-safe).
 * O teto é o `debridCheckFloor` (orçamento mínimo da checagem), não o prazo
 * da resposta: esta espera mora em background, mas não vale estourar a janela
 * que o próprio autofetch usa de corte.
 */
export async function waitProvenanceReference(account: string, timeoutMs?: number): Promise<boolean> {
  const teto = Math.max(0, Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, config.debridCheckFloor));
  const inicio = Date.now();
  for (;;) {
    const entry = preexisting.get(account);
    // Set VAZIO é referência válida (conta conhecida e vazia): o que importa
    // é EXISTIR prova, não ela ser grande.
    if (entry?.hashes ?? entry?.previous) return true;
    const restante = teto - (Date.now() - inicio);
    if (restante <= 0) return false;
    if (entry?.promise) {
      // O refresh em voo É a referência que queremos: espera-o pelo que resta
      // do teto (raceWithDeadline nunca lança — o teto devolve null).
      await raceWithDeadline(entry.promise, restante, () => null);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, restante)));
  }
}

/** Recomeço do estado volátil de posse — simula o restart nos testes. */
export function resetSubmittedForTests() {
  submitted.clear();
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
  const loading: PreexistingEntry = {
    hashes: null,
    loadedAt: 0,
    // O snapshot anterior permanece como referência de prova durante o refresh.
    previous: entry?.hashes ?? entry?.previous ?? null,
  };
  preexisting.set(account, loading);
  loading.promise = call(apiKey, '/magnet/status')
    .then((data) => {
      const list: AllDebridMagnet[] = Array.isArray(data?.magnets) ? data.magnets : [];
      const snapshot = new Set<string>(list.map((m) => String(m.hash || '').toLowerCase()));
      const ours = submitted.get(account);
      const merged = new Set<string>();
      for (const hash of snapshot) {
        // Duas provas de posse subtraem do acervo protegido: a etiqueta em
        // memória (esta instância) e o registro durável `adsub` (sobrevive ao
        // restart — é o conserto da catraca). O `peek` não promove LRU nem
        // conta hit/miss: a varredura de proteção não pode reordenar o cache.
        if (ours?.has(hash)) continue;
        if (persistedSubmitted(account, hash)) continue;
        merged.add(hash);
      }
      loading.hashes = merged;
      loading.loadedAt = Date.now();
      const etiquetados = snapshot.size - merged.size;
      log.info(
        `[alldebrid] ${merged.size} magnet(s) preexistente(s) na conta ficam protegidos da limpeza` +
          (etiquetados ? ` (${etiquetados} subido(s) pelo addon)` : ''),
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
