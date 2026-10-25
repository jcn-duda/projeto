import config from '../config.js';

/**
 * Addon público "Mico Leão Dublado V2" como card de indexer VIRTUAL.
 *
 * O card aparece no catálogo da /configure (id `mico`) ao lado dos cards do
 * Jackett, obedece a seleção `ji`, a prioridade `ip` e o limite `jl` como
 * qualquer indexer, mas NÃO passa pelo Jackett: o Mico é um addon Stremio,
 * consultado por IMDb.
 *
 * A CONSULTA ao Mico não mora mais aqui: a busca ao vivo é do gateway nativo
 * (`adom-search`) e a descoberta/captura é do raspador (`adom-crawl`). O Node
 * mantém só a identidade do card e a entrada do catálogo — sem fetch, sem
 * breaker e sem escrita no banco de magnets.
 */
export const MICO_ID = 'mico';

/** Entrada do catálogo da /configure (mesmo shape dos cards do Jackett). */
export function catalogEntry(): { id: string; label: string; language: string; isBr: boolean; virtual: true } | null {
  if (!config.mico.enabled) return null;
  // `virtual` separa o card da prova de vida do Jackett: catálogo vivo só com
  // ele continua sendo "Jackett sem indexer" no painel.
  return { id: MICO_ID, label: 'Mico Leão Dublado', language: 'pt-BR', isBr: true, virtual: true };
}
