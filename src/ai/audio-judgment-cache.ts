/**
 * Cache do julgamento CRU do TypeSafe — namespace versionado `tsj:v1`, cota
 * própria (500), TTL de config. Serve para NÃO repetir chamada: o valor é o
 * noul bruto, e o threshold é aplicado SÓ na comparação shadow de uma chamada
 * NOVA (cache-hit retorna cedo e não re-contabiliza métrica). Guardar o valor
 * cru é o que permite recomputar sem re-pagar quando existir consumidor de
 * recompute — hoje não existe, então mudar o knob afeta só chamadas novas.
 *
 * Chave: `tsj:v1:<sha256(título normalizado | model | promptVersion)>` — o
 * fingerprint isola model e versão de pergunta, então trocar qualquer um deles
 * nasce em chave nova (julgamentos órfãos expiram pelo TTL sozinhos, sem
 * migracao). O valor `{ n, m, at }` nunca carrega título, chave ou config.
 *
 * O kill-switch (default OFF) é aplicado ANTES deste módulo na fila: sem
 * `TYPESAFE_RUNTIME_ENABLED=true` + chave, nada aqui é lido nem escrito.
 */
import { createHash } from 'node:crypto';
import { normalizeTitle } from '../utils/title-normalization.js';
import { prefix } from '../utils/cache-keys.js';
import { get, set } from '../utils/cache.js';
import { PROMPT_VERSION } from './questions-audio.js';
import type { JevAudioJudgment } from './types.js';

/**
 * Fingerprint estável: título NORMALIZADO (mesma normalização do matching) +
 * model + versão da pergunta. Mudou qualquer um → chave nova por construção.
 */
function fingerprint(title: string, model: string): string {
  const material = `${normalizeTitle(String(title || ''))}|${model}|${PROMPT_VERSION}`;
  return createHash('sha256').update(material).digest('hex');
}

/** Chave completa no cache (`tsj:v1:<fp>`). */
function keyFor(fp: string): string {
  return `${prefix('tsj')}${fp}`;
}

/** Atalho para testes/diagnóstico: chave a partir do título. */
function judgmentKey(title: string, model: string): string {
  return keyFor(fingerprint(title, model));
}

/**
 * Leitura. Valor ausente, de outro formato ou corrompido é MISS (null) — o
 * cache nunca inventa julgamento. `get` (não `peek`): hit aqui É uso real,
 * pode promover LRU e contar no namespace.
 */
function lookup(fp: string): JevAudioJudgment | null {
  const raw = get(keyFor(fp)) as any;
  if (!raw || typeof raw !== 'object') return null;
  const n = raw.n;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null;
  return { n, m: String(raw.m || ''), at: Number(raw.at) || 0 };
}

/** Escrita. TTL <= 0 não grava (o cache.ts também filtra, mas o guarda é daqui). */
function store(fp: string, judgment: JevAudioJudgment, ttlS: number): void {
  const ttl = Math.trunc(Number(ttlS));
  if (!Number.isFinite(ttl) || ttl <= 0) return;
  set(keyFor(fp), { n: judgment.n, m: judgment.m, at: judgment.at }, ttl);
}

export { fingerprint, keyFor, judgmentKey, lookup, store };
