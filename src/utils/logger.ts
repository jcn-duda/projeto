import config from '../config.js';

/**
 * Níveis de log do addon.
 *
 * A variável é ADDON_LOG_LEVEL, e NÃO LOG_LEVEL: no container único o addon, o
 * Jackett e o FlareSolverr dividem o mesmo ambiente, e LOG_LEVEL já está no
 * docker-compose.yml valendo para o FlareSolverr. Reaproveitar o nome faria uma
 * mudança pensada para um mudar o outro junto.
 *
 * Não mexe no formato das mensagens: elas continuam saindo com o prefixo de
 * subsistema ("[jackett] ...") que o supervisor e os logs de produção já usam.
 */
// Record<string, number> e não o literal: o nível chega como string livre do
// ambiente (ADDON_LOG_LEVEL) e é indexado por ela, não por chave conhecida.
const LEVELS: Record<string, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const DEFAULT = 'info';

function resolve(raw: unknown) {
  const name = String(raw || '').trim().toLowerCase();
  if (!name) return LEVELS[DEFAULT];
  if (LEVELS[name] === undefined) {
    console.warn(`[log] ADDON_LOG_LEVEL desconhecido: "${raw}" — usando ${DEFAULT}`);
    return LEVELS[DEFAULT];
  }
  return LEVELS[name];
}

let threshold = resolve(config.logging.level);

/** Só para teste: em produção o nível é decidido uma vez, na subida. */
function setLevel(name: unknown) {
  threshold = resolve(name);
}

function level() {
  return Object.keys(LEVELS).find((name) => LEVELS[name] === threshold) || DEFAULT;
}

const error = (...args: unknown[]) => {
  if (threshold >= LEVELS.error) console.error(...args);
};
const warn = (...args: unknown[]) => {
  if (threshold >= LEVELS.warn) console.warn(...args);
};
const info = (...args: unknown[]) => {
  if (threshold >= LEVELS.info) console.log(...args);
};
/** Por requisição: útil para diagnosticar, ruído demais para o dia a dia. */
const debug = (...args: unknown[]) => {
  if (threshold >= LEVELS.debug) console.log(...args);
};

/** Vale a pena medir só o que vai ser logado — formatar custa. */
const enabled = (name: string) => threshold >= (LEVELS[name] ?? LEVELS.info);

export { LEVELS, error, warn, info, debug, enabled, setLevel, level };
