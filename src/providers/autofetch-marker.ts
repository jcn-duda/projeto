// Marker do autofetch: a chave e o VALOR gravados quando um enqueue é aceito.
//
// O estado do Chupim (fila, blacklist e marker) passou a morar no KV nativo
// (`NativeKv`, a mesma tabela `cache` do `cache.db`): o prefixo
// `autofetch:v3:m:` é RUST_OWNED, então o `cache.get` devolveria sempre `null`.
// A chave e as formas do valor são as MESMAS de antes — o dado já gravado no
// disco é lido pelo `NativeKv` sem migração; só o transporte mudou.
//
// Extraído de autofetch.ts ao estourar a catraca de 400 linhas. Fica junto
// porque chave e valor têm que mudar em par: quem grava um formato novo e
// quem o lê são o mesmo contrato, e separá-los foi o que já deixou o marker
// significar coisas diferentes em pontos diferentes do ciclo.
import { prefix } from '../utils/cache-keys.js';
import { kvKeys, kvPeek, nativeKv } from '../utils/native-kv.js';
import { requireCore } from '../utils/rust-core.js';
import type { AutofetchMarkerCore } from '../utils/rust-autofetch.js';
import * as log from '../utils/logger.js';

function markerKey(adapterId: string, account: string, infoHash: string) {
  return `${prefix('autofetch')}m:${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}

/** Portas do marker no núcleo (`queue_v3.rs`): a chave e as formas são dele. */
function markerCore(): AutofetchMarkerCore {
  return requireCore() as unknown as AutofetchMarkerCore;
}

/**
 * Valor gravado no marker. Historicamente `1`: só a presença importava. Quando
 * o adapter devolve o ID da transferência no aceite, guarda-o — é a âncora
 * para reencontrá-la depois em serviço que não publica o hash na listagem (o
 * Premiumize é o caso medido). Os leitores testam TRUTHINESS, nunca `=== 1`,
 * então o objeto convive com os `1` já gravados: marker antigo apenas não tem
 * id, e o recheck volta a enxergá-lo no próximo enqueue.
 *
 * `meta` (Fase 6): o marker do Chupim guarda também pool/obra/acceptedAt/
 * título/br/dubbed. `obra` é o DIGEST da identidade (sha256, mesma função do
 * teto por obra) — nunca imdbId nem conta crus. O marker LEGADO (`1` ou
 * `{id}`) continua truthy para todos os leitores antigos, mas é INELEGÍVEL à
 * evicção dirigida: sem `obra` não há prova de identidade. `meta` ausente
 * preserva byte a byte o valor antigo.
 */
export interface MarkerMeta {
  pool?: string;
  obra?: string;
  acceptedAt?: number;
  title?: string;
  br?: boolean;
  dubbed?: boolean;
}

function markerValue(accepted: boolean | string, meta?: MarkerMeta) {
  const id = typeof accepted === 'string' && accepted ? accepted : '';
  if (!meta) return id ? { id } : 1;
  const out: Record<string, unknown> = {};
  if (id) out.id = id;
  if (meta.pool) out.pool = String(meta.pool);
  if (meta.obra) out.obra = String(meta.obra);
  out.acceptedAt = Number.isFinite(Number(meta.acceptedAt)) ? Number(meta.acceptedAt) : Date.now();
  if (meta.title) out.title = String(meta.title).slice(0, 120);
  out.br = meta.br === true;
  out.dubbed = meta.dubbed === true;
  return out;
}

/**
 * Leitura crua do marker no KV nativo. NUNCA lança: núcleo ausente, JSON
 * inválido ou chave vencida viram `null`. Um marker ilegível é "sem aceite",
 * não um motivo para derrubar o enqueue ou a checagem do chamador.
 */
function markerRead(adapterId: string, account: string, infoHash: string): unknown {
  try {
    const h = String(infoHash || '').toLowerCase();
    if (!adapterId || !account || !h) return null;
    const raw = markerCore().autofetchV3Marker(nativeKv(), String(adapterId), String(account), h, Date.now());
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Presença do marker (o "aceite" do Chupim). Substitui o `Boolean(cache.get)`
 * dos leitores antigos: toda forma gravada (`1`, `{id}`, `{id,…meta}`) é
 * truthy, e o legado continua barrando reenfileiramento como antes.
 */
function markerActive(adapterId: string, account: string, infoHash: string): boolean {
  return Boolean(markerRead(adapterId, account, infoHash));
}

/**
 * Grava o marker no KV nativo. `ttlSeconds` é o do call site (`autoFetchTtl`,
 * o MESMO TTL do aceite/hold), em segundos — a mesma régua do `cache.set`.
 * `false` = a escrita não aconteceu (núcleo ausente, hash vazio ou TTL <= 0).
 *
 * TTL <= 0 NÃO grava: o `cache.set` antigo descartava a entrada nesse caso,
 * enquanto o nativo a criaria PERMANENTE — um marker eterno barraria o hash
 * para sempre, inclusive depois de morto. O portão é o mesmo da blacklist.
 */
export function setMarker(adapterId: string, account: string, infoHash: string, value: unknown, ttlSeconds: number): boolean {
  const h = String(infoHash || '').toLowerCase();
  if (!adapterId || !account || !h) return false;
  const ttl = Math.trunc(Number(ttlSeconds) || 0);
  if (!(ttl > 0)) return false;
  try {
    markerCore().autofetchV3SetMarker(
      nativeKv(), String(adapterId), String(account), h, JSON.stringify(value ?? null), ttl, Date.now(),
    );
    return true;
  } catch (err: unknown) {
    log.warn(`[autofetch] falha ao gravar marker ${adapterId}:${account}:${h}: ${log.errorMessage(err)}`);
    return false;
  }
}

/** Apaga o marker; `false` = nada havia (idempotente) ou a porta falhou. */
export function forgetMarker(adapterId: string, account: string, infoHash: string): boolean {
  const h = String(infoHash || '').toLowerCase();
  if (!adapterId || !account || !h) return false;
  try {
    return markerCore().autofetchV3ForgetMarker(nativeKv(), String(adapterId), String(account), h);
  } catch (err: unknown) {
    log.warn(`[autofetch] falha ao esquecer marker ${adapterId}:${account}:${h}: ${log.errorMessage(err)}`);
    return false;
  }
}

/** ID da transferência guardado no marker, quando o adapter devolveu um. */
function markerTransferId(adapterId: string, account: string, infoHash: string): string | null {
  const value = markerRead(adapterId, account, infoHash) as { id?: unknown } | null;
  if (!value || typeof value !== 'object') return null;
  return value.id == null || value.id === '' ? null : String(value.id);
}

/**
 * Digest da obra guardado no marker NOVO, ou `null` para marker legado (`1` ou
 * `{id}`). É o predicado de elegibilidade da evicção (Fase 6): só marker com
 * `obra` casa uma identidade provada.
 */
function markerObra(adapterId: string, account: string, infoHash: string): string | null {
  const value = markerRead(adapterId, account, infoHash) as { obra?: unknown } | null;
  if (!value || typeof value !== 'object') return null;
  return typeof value.obra === 'string' && value.obra ? value.obra : null;
}

/**
 * Mapa reverso id da transferência -> infoHash, para o adapter que precisa
 * reencontrar o hash SEM ter o lote do recheck em mãos.
 *
 * O recheck monta essa ponte a partir das hashes do lote (que vivem em
 * memória e somem no restart). A varredura de mortas existe justamente para
 * o que o restart deixou para trás: lá não há lote nenhum, e transferência de
 * nome humano ("[WWW.BLUDV.TV] ... [DUBLADO]") não carrega hash em campo
 * nenhum da listagem. Reconstruir o mapa dos markers devolve a identificação
 * — e com ela a checagem do `held` e a memória de parada por hash.
 *
 * A varredura agora é do KV nativo (`kvKeys`) e a leitura de cada chave é
 * `kvPeek` (getJson): antes o mapa só via o marker hidratado no L1 e o que a
 * cota de hidratação deixou fora ficava invisível. O nativo enxerga o disco
 * inteiro, que é o que a varredura de mortas precisa.
 */
function markerIdIndex(adapterId: string, account: string): Map<string, string> {
  const pre = `${prefix('autofetch')}m:${adapterId}:${account}:`;
  const out = new Map<string, string>();
  for (const key of kvKeys(pre)) {
    const infoHash = key.slice(pre.length);
    if (!/^[a-f0-9]{40}$/.test(infoHash)) continue;
    const value = kvPeek(key) as { id?: unknown } | null;
    if (!value || typeof value !== 'object') continue;
    if (value.id == null || value.id === '') continue;
    out.set(String(value.id), infoHash);
  }
  return out;
}

export { markerKey, markerValue, markerTransferId, markerObra, markerIdIndex, markerActive };
