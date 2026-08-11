const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');

/**
 * Configuração POR USUÁRIO, no modelo do Torrentio: o install URL carrega as
 * opções codificadas (`/<config>/manifest.json`), então a mesma instância serve
 * gente com preferências diferentes sem estado no servidor.
 *
 * O `.env` continua sendo o padrão; o que vem da URL é só um overlay por
 * requisição, guardado em AsyncLocalStorage para não precisar arrastar um
 * parâmetro por toda a cadeia de busca.
 */
const store = new AsyncLocalStorage();

/** Só estas chaves podem vir da URL — o resto é decisão do operador da instância. */
const SCHEMA = {
  providers: { type: 'list', key: 'p' },
  qualities: { type: 'list', key: 'q' },
  maxResults: { type: 'int', key: 'm', min: 1, max: 100 },
  minSeeders: { type: 'int', key: 's', min: 0, max: 1000 },
  brReservedSlots: { type: 'int', key: 'b', min: 0, max: 40 },
  brOnly: { type: 'bool', key: 'o' },
  dubbedOnly: { type: 'bool', key: 'd' },
  debridService: { type: 'string', key: 'ds' },
  debridApiKey: { type: 'string', key: 'dk' },
  debridCachedOnly: { type: 'bool', key: 'dc' },
};

function defaults() {
  return {
    providers: config.provider === 'both' ? ['jackett', 'prowlarr'] : [config.provider],
    qualities: config.qualityFilter,
    maxResults: config.maxResults,
    minSeeders: config.minSeeders,
    brReservedSlots: config.brReservedSlots,
    brOnly: false,
    dubbedOnly: config.bludv.dubbedOnly,
    debridService: config.debrid.service,
    debridApiKey: config.debrid.apiKey,
    debridCachedOnly: config.debrid.cachedOnly,
  };
}

function clampInt(value, { min, max }, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Aplica o overlay sobre os defaults, ignorando qualquer chave desconhecida. */
function normalize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;

  for (const [name, spec] of Object.entries(SCHEMA)) {
    const value = raw[spec.key];
    if (value === undefined || value === null) continue;

    if (spec.type === 'list') {
      const items = (Array.isArray(value) ? value : String(value).split(','))
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean);
      base[name] = items;
    } else if (spec.type === 'int') {
      base[name] = clampInt(value, spec, base[name]);
    } else if (spec.type === 'bool') {
      base[name] = value === true || value === 1 || value === '1' || value === 'true';
    } else {
      base[name] = String(value).slice(0, 200);
    }
  }
  return base;
}

function encode(raw) {
  return Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url');
}

/**
 * `null` quando o segmento não é uma config — é assim que o roteador distingue
 * `/<config>/manifest.json` de qualquer outra rota de um segmento só.
 */
function decode(segment) {
  if (!segment || segment.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalize(parsed);
  } catch {
    return null;
  }
}

/** Opções válidas para a requisição corrente (ou os defaults, fora de request). */
function opts() {
  return store.getStore()?.opts || normalize(null);
}

/**
 * Segmento de config da requisição corrente, já com barra ("/abc123" ou "").
 * A rota /resolve precisa dele: o link de play tem que voltar carregando a
 * MESMA config, senão o debrid do usuário some na hora do play.
 */
function prefix() {
  const segment = store.getStore()?.encoded;
  return segment ? `/${segment}` : '';
}

function run({ opts: userOpts, encoded }, fn) {
  return store.run({ opts: userOpts, encoded }, fn);
}

module.exports = { SCHEMA, defaults, normalize, encode, decode, opts, prefix, run };
