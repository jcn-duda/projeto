/**
 * davail do play — oráculo de teste. Eram `noteAvailable`/`peekDavail`/
 * `noteUnavailable` em `src/debrid/cache-check.ts`: o L1 do davail que o
 * adaptador TypeScript gravava no próprio processo. Em produção o davail é do
 * gateway (`streams`/`davail` nativos); aqui só os testes do contrato de
 * `/debrid/link` e do atalho do histórico leem e escrevem esse estado.
 */
import { assertSafeTestDb } from '../../db-guard.js';
import { opts } from '../../../../src/runtime.js';
import config from '../../../../src/config.js';
import { davailState } from '../../../../src/utils/debrid-state-native.js';
import * as magnetdbWrites from './magnetdb-writes.js';
import { current } from '../../../../src/debrid/registry.js';

// Grava davail/posse no MESMO cache.db: sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/play/davail');

/**
 * O recheck acabou de confirmar que o hash ficou pronto. Semeia o positivo para
 * a próxima lista marcar ⚡ sem repetir a consulta ao debrid.
 */
export function noteAvailable(infoHash: string) {
  const adapter = current();
  const apiKey = opts().debridApiKey;
  if (!adapter || !apiKey || !infoHash) return;
  if (config.debrid.availPosTtl > 0) davailState().put(adapter.id, apiKey, infoHash, true, config.debrid.availPosTtl, Date.now());
  // Pronto de verdade é evidência durável: entra no banco de magnets além do
  // davail de TTL curto.
  magnetdbWrites.markAlive(adapter.id, apiKey, [infoHash]);
}

/**
 * Leitura de SONDAGEM do davail, sem efeito algum: a ponte lê o store do núcleo
 * direto — não promove LRU, não conta cache.hit e não acorda o L2. Negativo
 * "fresco" aqui foi escrito NESTA instância, que é exatamente o que o consumidor
 * (DEBRID_ALIVE_AS_CACHE) quer para vetar o atalho do histórico; positivo
 * sozinho não pinta ⚡, só o negativo contradiz.
 *
 * @returns {0|1|null} veredito vivo do store, ou null (ausente/expirado).
 */
export function peekDavail(adapterId: string, apiKey: string, hash: string): 0 | 1 | null {
  const value = davailState().get(adapterId, apiKey, hash, Date.now());
  if (value === null) return null;
  return value ? 1 : 0;
}

/**
 * Negativo MEDIDO pelo play: o /resolve acabou de constatar que o hash não
 * estava pronto no serviço. Grava davail=0 pela janela curta do availNegTtl
 * (a mesma do caminho da checagem) para o atalho do histórico não pintar ⚡
 * no que o play acabou de provar frio — o erro do atalho custa uma janela,
 * não os 7 dias do alive. Não toca no magnetdb: o alive de plays antigos
 * continua de pé, e um play futuro bem-sucedido o renova.
 */
export function noteUnavailable(adapterId: string, apiKey: string, infoHash: string) {
  if (!adapterId || !apiKey || !infoHash) return;
  if (config.debrid.availNegTtl > 0) davailState().put(adapterId, apiKey, infoHash, false, config.debrid.availNegTtl, Date.now());
}
