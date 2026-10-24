// Lie GLOBAL (união de contas) para o banco de magnets vivo. Extraído de
// `magnet-bank.ts` pela catraca de 400 linhas: sem engine, sem fila — só a
// leitura quiet do `mag` que promove `lied` no merge.
import config from '../config.js';
import * as cache from './cache.js';
import * as log from './logger.js';
import { prefix } from './cache-keys.js';

/**
 * Hashes com `lie` VIVO no `mag` de QUALQUER conta. O banco é global, então a
 * evidência de mentira vira um booleano global (não se duplica a conta); o
 * `mag` continua sendo a autoridade por credencial.
 *
 * `keysMatching` filtra pelo prefixo do lado (`mag:v1:lie:`) e só chaves cujo
 * último segmento é um hash DA LEVA são lidas: `cache.peek` descarta a chave
 * EXPIRADA e nada mais é parseado. SEM memo: a varredura roda a cada flush com
 * hashes, então uma mentira recém-gravada antes do flush é vista. Sem
 * `infoHash`/`bad` por conta (isso é do `mag`).
 */
export function globalLieHashes(hashes: Set<string>): Set<string> {
  const out = new Set<string>();
  if (hashes.size === 0) return out;
  if (!config.magnetDb?.enabled || !config.magnetDb?.lieEnabled) return out;
  try {
    // O prefixo já prova o lado `lie`; o último segmento da chave é o hash.
    for (const key of cache.keysMatching(`${prefix('mag')}lie:`)) {
      const hash = key.slice(key.lastIndexOf(':') + 1);
      if (!hashes.has(hash)) continue;
      if (cache.peek(key) === 1) out.add(hash);
    }
  } catch (err: unknown) {
    log.warn('[magnetbank] leitura do lie global falhou:', log.errorMessage(err));
  }
  return out;
}
