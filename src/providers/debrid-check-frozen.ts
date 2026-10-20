// Checagem de cache do debrid com replay congelado (Fase 1).
//
// Extraído do pipeline para a catraca de linhas; a semântica é só a fachada
// `frozen.aroundCheck` (grava o veredito no record e o devolve no replay).
import * as frozen from '../utils/stream-frozen.js';

type CheckResult = {
  cached: Set<string>;
  known: boolean;
  unusable?: { reason: string; message: string };
};

export function checkCachedFrozen<T extends CheckResult>(
  service: string | null,
  hashes: string[],
  fileHashes: string[],
  timeoutMs: number | null | undefined,
  run: (options: { timeoutMs?: number; fileHashes?: string[] }) => Promise<T>,
): Promise<T> {
  const options = {
    ...(timeoutMs != null ? { timeoutMs } : {}),
    ...(fileHashes.length ? { fileHashes } : {}),
  };
  return frozen.aroundCheck(hashes, { service, fileHashes }, () => run(options));
}
