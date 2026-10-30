/**
 * Escrita do magnetdb — régua TS CONGELADA no oráculo de teste. Eram
 * `markAlive`/`markBad`/`markLie`/`renewAlive`/`forgetBad` e as leituras de
 * decisão (`isAlive`/`isBad`/`isLie`/`peekAlive`) em `src/utils/magnetdb.ts`.
 * Em produção quem grava a evidência (`alive`/`bad`/`lie`) é o gateway
 * (`play_effects_native*`); aqui só os testes do contrato do magnetdb escrevem
 * e leem por essa régua de referência.
 */
import { assertSafeTestDb } from '../../db-guard.js';
import config from '../../../../src/config.js';
import * as metrics from '../../../../src/utils/metrics.js';
import { magnetState } from '../../../../src/utils/debrid-state-native.js';
import { isSupportedHash } from '../../../../src/utils/magnetdb-counts.js';
import {
  adapterCounts, getOrCreateAdapter, schedulePersistentSave, markMutation,
} from '../../../../src/utils/magnetdb-persist.js';

// Grava o banco de magnets no MESMO cache.db: sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/play/magnetdb-writes');

/**
 * Grava em lote que os hashes tocariam na hora nesta conta. Chamado quando a
 * checagem de cache do debrid confirma o positivo e quando o /resolve devolve
 * link de verdade. Regravar um hash já vivo só renova o TTL.
 */
export function markAlive(adapterId: string, apiKey: string, hashes: string[]) {
  const ttl = config.magnetDb.aliveTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey) return;
  // Dedup + minúsculas: o núcleo casa por hash já normalizado, e a métrica de
  // recusa conta HASHES — duas cópias do mesmo hash inflariam `alive.set`.
  const candidates = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter(Boolean);
  // Só grava hash que o parse da chave aceita de volta: gravar o que ele
  // recusa cria linha física que a enumeração de diagnóstico não reconhece,
  // e a sentinela de divergência acusa desacordo em todo boot sem nunca
  // convergir.
  const unique = candidates.filter(isSupportedHash);
  const malformed = candidates.length - unique.length;
  if (malformed > 0) metrics.count('magnetdb.hash.refused', malformed);
  if (unique.length === 0) return;
  const now = Date.now();
  // UMA varredura para saber quais já estão `bad`: a precedência
  // `bad > lie > alive` é do núcleo, e um `isBad` por hash custaria uma
  // travessia napi por candidato.
  const bad = new Set(
    magnetState().stateSnapshot(adapterId, apiKey, unique, now)
      .filter((mark) => mark.state === 'bad')
      .map((mark) => String(mark.hash || '').toLowerCase()),
  );
  const allowed = unique.filter((hash) => !bad.has(hash));
  const refused = unique.length - allowed.length;
  if (refused > 0) metrics.count('magnetdb.alive.refused-bad', refused);
  if (allowed.length === 0) return;

  // `born` = quantas chaves NASCERAM; renovação de chave viva não conta.
  const born = magnetState().markAlive(adapterId, apiKey, allowed, ttl, now);

  // Qualquer escrita degrada a base para estimativa — inclusive a renovação
  // econômica do renewAlive (born === 0): a soma não sabe o restante
  // anterior da chave renovada, então `l1-rebuild` não sobrevive nem a ela.
  markMutation();
  if (born > 0) {
    const totals = getOrCreateAdapter(adapterId);
    totals.alive += born;
    totals.ttlRemainingSums.alive += born * ttl;
    schedulePersistentSave();
  }
  metrics.count('magnetdb.alive.set', allowed.length);
}

export function isAlive(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'alive'
    : false;
}
/**
 * Grava que o hash provou estar quebrado nesta conta (torrent sem arquivo de
 * vídeo no play). TTL próprio: torrent pode ganhar upload novo, então o
 * negativo também envelhece.
 *
 * bad VENCE sobre alive: o núcleo apaga o `alive` do mesmo hash na MESMA
 * transação do `bad`, e `state()` devolve o veredito único pela precedência
 * `bad > lie > alive`. Sem isso as janelas de TTL são distintas (24h contra 7
 * dias) e os dois coexistiriam — o filtro pré-checagem cortaria, mas o
 * instantSet já teria empurrado o hash ao topo do sort, gastando uma vaga do
 * pool de candidatos. Evidência mais recente e específica (play sem vídeo
 * depois da confirmação de cache) manda.
 */
export function markBad(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.badTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  if (!isSupportedHash(hash)) { metrics.count('magnetdb.hash.refused'); return; }
  const now = Date.now();
  // `mark_bad` apaga o `alive` do mesmo hash na MESMA transação, mas a ponte
  // só informa se o `bad` nasceu — sem olhar a janela do alive aqui, o agregado
  // ficaria contando um vivo que o núcleo já apagou até a sentinela do boot.
  // `remaining` consulta a chave `alive` direto (não passa pela precedência
  // bad > lie > alive), então enxerga o alive mesmo quando há `lie`.
  const hadAlive = magnetState().remaining(adapterId, apiKey, 'alive', hash, now) !== null;
  // `true` = o bad nasceu agora; o alive do mesmo hash sai na mesma transação.
  const born = magnetState().markBad(adapterId, apiKey, hash, ttl, now);
  if (born || hadAlive) {
    const totals = getOrCreateAdapter(adapterId);
    if (born) {
      totals.bad += 1;
      totals.ttlRemainingSums.bad += ttl;
    }
    if (hadAlive) {
      totals.alive = Math.max(0, totals.alive - 1);
      totals.ttlRemainingSums.alive = Math.max(0, totals.ttlRemainingSums.alive - config.magnetDb.aliveTtl);
    }
    markMutation();
    schedulePersistentSave();
  }
  metrics.count('magnetdb.bad.set');
}

export function isBad(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'bad'
    : false;
}
/**
 * Esquece um registro `bad`, SEM tocar em alive/lie do mesmo hash. É a função
 * do REPARO do dano do F3: um ramo antigo do warmer marcava `bad` no hash cuja
 * resposta era `blocked` — recusa legal (HTTP 451/error_code 35) do
 * Real-Debrid, não magnet quebrado. Recusa legal não grava `blocked` no
 * magnetdb, e NoVideoError legítimo não grava blocked no ledger; portanto
 * `bad + blocked` por definição é aquela escrita equivocada e pode ser
 * desfeita com segurança. Retorna true se havia um registro para apagar.
 */
export function forgetBad(adapterId: string, apiKey: string, hash: string): boolean {
  const removed = magnetState().forgetBad(adapterId, apiKey, hash);
  // O antigo `onForget` do cache decrementava o agregado aqui; a escrita agora
  // é nativa e não passa pelo Node, então o decremento é explícito.
  if (removed) {
    const totals = adapterCounts.get(adapterId);
    if (totals) {
      totals.bad = Math.max(0, totals.bad - 1);
      totals.ttlRemainingSums.bad = Math.max(0, totals.ttlRemainingSums.bad - config.magnetDb.badTtl);
      markMutation();
      schedulePersistentSave();
    }
  }
  return removed;
}
/** Há vídeo, mas o post prometeu áudio PT e os arquivos provaram release EN. */
export function markLie(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.lieTtl;
  if (!config.magnetDb.enabled || !config.magnetDb.lieEnabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  if (!isSupportedHash(hash)) { metrics.count('magnetdb.hash.refused'); return; }
  // `lie` NÃO apaga o alive do mesmo hash: o magnet toca, só não é dublado.
  const born = magnetState().markLie(adapterId, apiKey, hash, ttl, Date.now());
  if (born) {
    const totals = getOrCreateAdapter(adapterId);
    totals.lie += 1;
    totals.ttlRemainingSums.lie += ttl;
    markMutation();
    schedulePersistentSave();
  }
  metrics.count('magnetdb.lie.set');
}

export function isLie(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && config.magnetDb.lieEnabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'lie'
    : false;
}
export function peekAlive(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'alive'
    : false;
}
/**
 * Renovação ECONÔMICA para o atalho do davail: regrava só o hash cujo alive
 * está na segunda metade do TTL. O hit do L1 não é evidência nova — é a mesma
 * confirmação de antes —, e regravar o histórico inteiro em todo hit de título
 * popular virava escrita recorrente sem ganho: quem está no começo do TTL de
 * 7 dias desempata igual. Entrada sem registro (expirou) também renova — o
 * davail acabou de confirmar o positivo; hash com `bad` NÃO renova (bad vence,
 * e a renovação não pode ressuscitá-lo pela janela do davail).
 */
export function renewAlive(adapterId: string, apiKey: string, hashes: string[]) {
  const ttl = config.magnetDb.aliveTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey) return;
  const now = Date.now();
  const stale = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter((hash) => {
    if (!hash || isBad(adapterId, apiKey, hash)) return false;
    const remaining = magnetState().remaining(adapterId, apiKey, 'alive', hash, now);
    return remaining == null || remaining < ttl / 2;
  });
  markAlive(adapterId, apiKey, stale);
}
