// Lie GLOBAL (união de contas) para o banco de magnets vivo. Extraído de
// `magnet-bank.ts` pela catraca de 400 linhas: sem engine, sem fila — só a
// leitura quiet do `mag` que promove `lied` no merge.
import config from '../config.js';
import * as log from './logger.js';
import { magnetState } from './debrid-state-native.js';

/**
 * Hashes com `lie` VIVO no `mag` de QUALQUER conta. O banco é global, então a
 * evidência de mentira vira um booleano global (não se duplica a conta); o
 * `mag` continua sendo a autoridade por credencial.
 *
 * Quem filtra é o NÚCLEO (`liveLies`): a leva inteira vai numa chamada e o
 * núcleo monta a chave, descarta a vencida e devolve só o hash com `lie` vivo
 * em alguma conta — o TS não enumera mais o namespace nem faz slice de chave.
 * SEM memo: a varredura roda a cada flush com hashes, então uma mentira
 * recém-gravada antes do flush é vista. Sem `infoHash`/`bad` por conta (isso é
 * do `mag`). O `try/catch` fica: sem o núcleo carregado a ponte lança.
 */
export function globalLieHashes(hashes: Set<string>): Set<string> {
  const out = new Set<string>();
  if (hashes.size === 0) return out;
  if (!config.magnetDb?.enabled || !config.magnetDb?.lieEnabled) return out;
  try {
    return new Set(magnetState().liveLies([...hashes], Date.now()));
  } catch (err: unknown) {
    log.warn('[magnetbank] leitura do lie global falhou:', log.errorMessage(err));
  }
  return out;
}
