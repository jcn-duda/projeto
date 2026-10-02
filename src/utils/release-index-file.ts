// Evidência por ARQUIVO (não por obra): o que o play viu dentro do torrent —
// áudio, episódio, qualidade e nome. Vive no mesmo namespace `idx`, com chave
// por hash. Extraído de `release-index.ts` pelo orçamento de 400 linhas.
import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import { prefix } from './cache-keys.js';

export type FileEvidence = { a: string; e?: 0 | 1; q: string; n: string };

function enabled() {
  return config.releaseIndex.enabled && config.releaseIndex.ttl > 0;
}

function fileKey(hash: string) {
  return `${prefix('idx')}file:${String(hash || '').toLowerCase()}`;
}

export function markFileEvidence(hash: string, evidence: FileEvidence) {
  if (!enabled() || !hash || !evidence) return 0;
  const key = fileKey(hash);
  const isNew = cache.get(key) == null;
  cache.set(key, evidence, config.releaseIndex.ttl);
  if (isNew) metrics.count('search.idx.file');
  return isNew ? 1 : 0;
}

export function fileEvidence(hash: string): FileEvidence | null {
  if (!enabled() || !hash) return null;
  return (cache.get(fileKey(hash)) as FileEvidence) || null;
}
