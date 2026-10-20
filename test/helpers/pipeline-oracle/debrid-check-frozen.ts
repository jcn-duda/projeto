// ORÁCULO CONGELADO — NÃO É CÓDIGO DE PRODUÇÃO.
//
// Cópia de `src/providers/debrid-check-frozen.ts` no commit c11cb720 (branch
// rust). O arquivo de produção só era consumido pelo `applyDebrid`; depois do
// F4.4 ele pode virar órfão. O oráculo carrega a própria cópia para não
// depender de um módulo que o corte pode remover. A infraestrutura
// `utils/stream-frozen.ts` sobrevive (rotas e file-sizes usam o replay).
import * as frozen from '../../../src/utils/stream-frozen.js';

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
