import { AsyncLocalStorage } from 'node:async_hooks';
import config from './config.js';
import autofetchLive from './utils/autofetch-live.js';
import * as secretBox from './utils/secret-box.js';

/**
 * Configuração POR USUÁRIO, no modelo do Torrentio: o install URL carrega as
 * opções codificadas (`/<config>/manifest.json`), então a mesma instância serve
 * gente com preferências diferentes sem estado no servidor.
 *
 * O `.env` continua sendo o padrão; o que vem da URL é só um overlay por
 * requisição, guardado em AsyncLocalStorage para não precisar arrastar um
 * parâmetro por toda a cadeia de busca.
 */
interface RuntimeContext {
  opts?: RuntimeOptions;
  encoded?: string | null;
  origin?: string | null;
}
type RuntimeOptions = ReturnType<typeof defaults>;
const store = new AsyncLocalStorage<RuntimeContext>();
// 2048 não comporta um catálogo Jackett real selecionado no campo `ji`. Ainda
// fica abaixo dos limites usuais de request line de Node/proxies e impede que
// um segmento arbitrariamente grande seja decodificado como JSON.
const MAX_CONFIG_SEGMENT = 8192;
const SAFE_INDEXER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Entrada do SCHEMA. O literal de `type` é o discriminante: sem ele o TS amplia
 * para `string` e o `spec.type === 'int'` não estreita para a variante com
 * `min`/`max`, exigidos por `clampInt`.
 */
type SchemaEntry =
  | { type: 'list'; key: string }
  | { type: 'int'; key: string; min: number; max: number }
  | { type: 'intmap'; key: string; min: number; max: number }
  | { type: 'bool'; key: string }
  | { type: 'string'; key: string }
  | { type: 'secret'; key: string };

/** Só estas chaves podem vir da URL — o resto é decisão do operador da instância. */
const SCHEMA: Record<string, SchemaEntry> = {
  providers: { type: 'list', key: 'p' },
  qualities: { type: 'list', key: 'q' },
  maxResults: { type: 'int', key: 'm', min: 1, max: 100 },
  minSeeders: { type: 'int', key: 's', min: 0, max: 1000 },
  brReservedSlots: { type: 'int', key: 'b', min: 0, max: 40 },
  brFirst: { type: 'bool', key: 'bf' },
  jackettIndexers: { type: 'list', key: 'ji' },
  indexerPriority: { type: 'list', key: 'ip' },
  indexerLimits: { type: 'intmap', key: 'jl', min: 0, max: 20 },
  brOnly: { type: 'bool', key: 'o' },
  dubbedOnly: { type: 'bool', key: 'd' },
  preferDubbed: { type: 'bool', key: 'a' },
  excludeCam: { type: 'bool', key: 'c' },
  maxSizeGb: { type: 'int', key: 'z', min: 0, max: 200 },
  max2160p: { type: 'int', key: 'q4', min: 0, max: 100 },
  max1080p: { type: 'int', key: 'q1', min: 0, max: 100 },
  max720p: { type: 'int', key: 'q7', min: 0, max: 100 },
  max480p: { type: 'int', key: 'q5', min: 0, max: 100 },
  maxSd: { type: 'int', key: 'qs', min: 0, max: 100 },
  maxUnknown: { type: 'int', key: 'qn', min: 0, max: 100 },
  maxPerIndexer: { type: 'int', key: 'qi', min: 0, max: 100 },
  debridService: { type: 'string', key: 'ds' },
  // `secret`: aceita a chave em texto puro (install URL antigo) ou selada com o
  // RESOLVE_SECRET. Daqui pra dentro do addon ela é sempre texto puro.
  debridApiKey: { type: 'secret', key: 'dk' },
  debridCachedOnly: { type: 'bool', key: 'dc' },
  showUncachedBr: { type: 'bool', key: 'bu' },
  autoFetchBr: { type: 'bool', key: 'ab' },
  streamNameStyle: { type: 'string', key: 'ns' },
  streamNameShowSource: { type: 'bool', key: 'st' },
};

function defaultProviders(): string[] {
  const selected = String(config.provider)
    .split(/[,+]/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const base = selected.includes('both')
    ? [...new Set([...selected.filter((name) => name !== 'both'), 'jackett', 'prowlarr'])]
    : [...new Set(selected)];
  // Demo fica isolado (sem rede). Torrentio pode ser a fonte única quando o
  // operador escolhe isso explicitamente; nas demais fontes reais entra junto.
  if (base.includes('demo')) return ['demo'];
  const hasKnownSearchProvider = base.some((name) => ['jackett', 'prowlarr', 'torrentio'].includes(name));
  if (config.torrentio.enabled && hasKnownSearchProvider && !base.includes('torrentio')) base.push('torrentio');
  return base.length ? base : ['demo'];
}

function defaults() {
  return {
    // Pool global Torrentio entra por PADRÃO quando o operador usa uma fonte de
    // busca real (jackett/prowlarr/both) e a env habilita — o demo segue
    // isolado (sem rede). O usuário ainda pode desligar/ligar por instalação
    // via o toggle da página (p... sem/com torrentio).
    providers: defaultProviders(),
    qualities: config.qualityFilter,
    maxResults: config.maxResults,
    minSeeders: config.minSeeders,
    brReservedSlots: config.brReservedSlots,
    brFirst: true,
    jackettIndexers: [...config.jackett.indexers],
    indexerPriority: [],
    indexerLimits: {},
    brOnly: false,
    dubbedOnly: config.bludv.dubbedOnly,
    preferDubbed: config.preferDubbed,
    excludeCam: false,
    maxSizeGb: 0,
    max2160p: config.qualityLimits['2160p'],
    max1080p: config.qualityLimits['1080p'],
    max720p: config.qualityLimits['720p'],
    max480p: config.qualityLimits['480p'],
    maxSd: config.qualityLimits.SD,
    maxUnknown: config.qualityLimits.unknown,
    maxPerIndexer: config.maxPerIndexer,
    debridService: config.debrid.service,
    debridApiKey: config.debrid.allowEnvKey ? config.debrid.apiKey : '',
    debridCachedOnly: config.debrid.cachedOnly,
    showUncachedBr: config.debrid.showUncachedBr,
    autoFetchBr: autofetchLive.effective().autoFetchBr,
    streamNameStyle: config.streamNameStyle,
    streamNameShowSource: config.streamNameShowSource,
  };
}

function clampInt(value: unknown, { min, max }: { min: number; max: number }, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Mapa compacto `id:limite,id:limite`; 0 é override explícito sem limite. */
function normalizeIntMap(value: unknown, spec: any) {
  let entries;
  if (Array.isArray(value)) {
    entries = value.map((item) => String(item).split(':', 2));
  } else if (value && typeof value === 'object') {
    entries = Object.entries(value);
  } else {
    entries = String(value).split(',').map((item) => item.split(':', 2));
  }

  const parsed = new Map();
  for (const entry of entries.slice(0, 100)) {
    const id = String(entry[0] || '').trim().toLowerCase();
    const rawLimit = entry[1];
    if (!SAFE_INDEXER_ID.test(id) || rawLimit === '' || rawLimit == null) continue;
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit)) continue;
    parsed.set(id, Math.min(spec.max, Math.max(spec.min, Math.trunc(limit))));
  }
  return Object.fromEntries([...parsed.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Aplica o overlay sobre os defaults, ignorando qualquer chave desconhecida. */
function normalize(raw: any) {
  // Indexado por nome de opção (as chaves do SCHEMA), não por chave conhecida.
  const base: Record<string, any> = defaults();
  if (!raw || typeof raw !== 'object') return base;

  for (const [name, spec] of Object.entries(SCHEMA)) {
    const value = raw[spec.key];
    if (value === undefined || value === null) continue;

    if (spec.type === 'list') {
      // `+` é um separador alternativo de lista (ex.: `p: jackett+torrentio`),
      // além da vírgula. IDs/qualidades nunca contêm `+`, então é seguro.
      const items = (Array.isArray(value) ? value : [value])
        .flatMap((item) => String(item).split(/[,+]/))
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean);
      base[name] = items;
    } else if (spec.type === 'int') {
      base[name] = clampInt(value, spec, base[name]);
    } else if (spec.type === 'intmap') {
      base[name] = normalizeIntMap(value, spec);
    } else if (spec.type === 'bool') {
      base[name] = value === true || value === 1 || value === '1' || value === 'true';
    } else if (spec.type === 'secret') {
      // Teto maior que o dos demais: o selo é bem mais longo que a chave crua
      // (IV + tag + base64url), e cortá-lo faria a abertura falhar.
      base[name] = secretBox.open(String(value).slice(0, 400));
    } else {
      base[name] = String(value).slice(0, 200);
    }
  }
  return base;
}

function encode(raw: unknown) {
  return Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url');
}

/**
 * Devolve o mesmo segmento com a chave de debrid selada, ou `null` se ele não
 * for uma config. Existe porque o install URL é montado no NAVEGADOR, que não
 * tem (nem pode ter) o RESOLVE_SECRET — a página manda o segmento pronto e
 * recebe de volta a versão protegida.
 *
 * Reescreve o objeto cru, sem normalizar: o que o usuário escolheu tem que
 * voltar exatamente igual, só com o `dk` trocado.
 */
function sealSegment(segment: string) {
  if (!segment || segment.length > MAX_CONFIG_SEGMENT || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const dk = SCHEMA.debridApiKey.key;
    // Sem chave (P2P puro) ou já selada: nada a fazer, devolve como veio.
    if (!parsed[dk] || secretBox.isSealed(parsed[dk])) return segment;
    return encode({ ...parsed, [dk]: secretBox.seal(String(parsed[dk]).slice(0, 200)) });
  } catch {
    return null;
  }
}

/**
 * `null` quando o segmento não é uma config — é assim que o roteador distingue
 * `/<config>/manifest.json` de qualquer outra rota de um segmento só.
 */
function decode(segment: string | null | undefined) {
  if (!segment || segment.length > MAX_CONFIG_SEGMENT || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
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

/**
 * Contexto da requisição corrente (`{opts, encoded, origin}`) para restaurar
 * depois com `run` — timers agendados durante a busca disparam FORA do
 * AsyncLocalStorage e precisam da conta/opts da requisição que os criou.
 */
function capture() {
  return store.getStore() || null;
}

/**
 * Origin da requisição corrente: o endereço que o cliente usou para falar com o
 * addon. Por definição é um endereço que ele alcança, então é o origin honesto
 * para montar o `externalUrl` do aviso de lista vazia sem config nenhuma. Fora
 * de request (warmup, teste, chamada interna) devolve `null`.
 */
function origin() {
  return store.getStore()?.origin || null;
}

/**
 * Roda `fn` com um patch de contexto MESCLADO sobre o store atual, em vez de
 * substituí-lo. É o que deixa o middleware de origin (acima do router) conviver
 * com o middleware de config (`/:userConfig`): o segundo roda `run({ opts,
 * encoded })` depois do primeiro e não pode apagar o origin que aquele capturou.
 */
function run<T>(patch: any, fn: () => T): T {
  return store.run({ ...store.getStore(), ...patch }, fn);
}

export {
  MAX_CONFIG_SEGMENT,
  SCHEMA,
  defaults,
  normalize,
  encode,
  sealSegment,
  decode,
  opts,
  prefix,
  origin,
  capture,
  run,
};
export type { RuntimeContext, RuntimeOptions };
