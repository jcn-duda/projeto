// Contrato da SONDA AMOSTRAL por site (plano "Raspagem total", Fase 8 — item
// 8.3): o veredito gravado no `crawl_state` e o codec que o portão lê.
//
// A sonda que MEDIA (amostra espalhada, classificação de página, Wilson,
// `decide`) saiu junto com o motor TS do raspador: os nove sites são do
// sidecar Rust, e o `adom-crawl probe` lê uma URL só. O que sobra aqui é a
// leitura FECHADA do veredito já gravado — o `crawl-probe-gate.ts` só libera
// site com `go` válido, e a régua (oráculo do golden `crawl-policy`) vive no
// branch `esm`.
//
// v2 — BUMP DELIBERADO (rodada real do NerdFilmes, 2026-09-28): a v1 media a
// identificação com o denominador errado (`no-work` fora) e afirmava 100% de
// identificação num site que identificava menos da metade. O gate recusa v1
// (falhando fechado, `sem-veredito`): veredito medido com o denominador
// errado não autoriza rotação.
import type { CrawlPageKind } from './crawl-types.js';

// --- Contrato gravado no crawl_state ----------------------------------------

/** Chave do `crawl_state` (única que a sonda escreve). */
export const PROBE_STATE_KEY = 'probe:verdict';
/**
 * 2 = `no-work` como resposta negativa e releases observadas (ver o cabeçalho).
 * O gate compara com esta constante, então o bump é o que impede um veredito
 * v1 — medido com o denominador errado — de liberar um site.
 */
export const PROBE_VERDICT_VERSION = 2;

export type ProbeVerdictName = 'go' | 'no-go' | 'inconclusive';

/**
 * CLASSE da página: o desfecho que o relatório mostra, mais fina que o balde
 * porque `no-work` e `tmdb-down` são coisas OPOSTAS — a primeira é RESPOSTA da
 * identificação (o TMDB respondeu "não é esta obra"), a segunda é AUSÊNCIA de
 * resposta. Juntas num contador só, a rodada real do NerdFilmes leu 21
 * `no-work` como se o TMDB estivesse fora.
 */
export type ProbeClass =
  | 'identificada' | 'no-work' | 'tmdb-down' | 'botao-sem-magnet'
  | 'sem-botao' | 'erro-pagina' | 'site-fora';

export type ProbeClasses = Record<ProbeClass, number>;

export interface ProbeCounts {
  /** Páginas efetivamente lidas (as da amostra, não as descobertas). */
  sample: number;
  /** Páginas lidas com desfecho aproveitável (release, botão sem magnet ou `no-torrent`). */
  valid: number;
  /** Página não lida: erro de layout/rede sem prova de botão. */
  pageErrors: number;
  /** Erros que provam o SITE fora (403/desafio/DNS) — `isSiteLevelError`. */
  siteLevel: number;
  /** Página só de streaming: o adaptador não achou botão de torrent. */
  noTorrent: number;
  /** Botão anunciado e nenhum magnet saiu (cadeia do protetor morreu). */
  buttonNoMagnet: number;
  /** Página que produziu ao menos uma release. */
  withRelease: number;
  /** Releases ÚNICAS vistas pelo adaptador (somadas), com ou sem obra. */
  magnets: number;
  identified: number;
  /** Página com release cuja obra NÃO veio: resposta negativa da identificação. */
  noWork: number;
  /** Páginas com release cuja identificação NÃO foi respondida (TMDB fora). */
  tmdbDown: number;
  /** Custo real de requisições somado (o teto por hora do motor é por request). */
  requests: number;
}

export interface ProbeRates {
  valid: number;
  magnet: number;
  identify: number;
  magnetsPerPage: number;
}

/** Limite INFERIOR de Wilson 95% de cada taxa com denominador binário. */
export interface ProbeBounds {
  valid: number;
  magnet: number;
  identify: number;
}

/**
 * Custo por página, MEDIDO: requisições do adaptador e latência cronometrada
 * pela CLI. `measuredPages` é o denominador honesto do p95 — sem ele, um p95 de
 * 1 página pareceria o mesmo de um p95 de 40.
 */
export interface ProbeCost {
  requests: number;
  requestsPerPage: number;
  p95RequestsPerPage: number;
  latencyMs: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  measuredPages: number;
}

export interface ProbeThresholds {
  validRate: number;
  magnetRate: number;
  identifyRate: number;
  magnetsPerPage: number;
}

/**
 * Limiares da régua da sonda: o codec os entrega quando o veredito gravado não
 * traz os seus. A taxa bruta é meta de LEITURA; o que aprovava era o limite
 * inferior de Wilson. `magnetsPerPage >= 1` é o piso de produtividade.
 */
export const DEFAULT_PROBE_THRESHOLDS: ProbeThresholds = {
  validRate: 0.6, magnetRate: 0.5, identifyRate: 0.5, magnetsPerPage: 1,
};

/** Amostra do plano (mede 40 como foi feito no Vaca): o gate exige exatamente ela. */
export const PROBE_SAMPLE = 40;

/** Denominadores EFETIVOS de cada taxa, gravados junto do veredito. */
export interface ProbeDenominators {
  sample: number;
  buttonPages: number;
  identifyAnswered: number;
  validPages: number;
}

/** Classes zeradas — a base do histograma, com TODAS as chaves presentes. */
export function emptyClasses(): ProbeClasses {
  return {
    identificada: 0, 'no-work': 0, 'tmdb-down': 0, 'botao-sem-magnet': 0,
    'sem-botao': 0, 'erro-pagina': 0, 'site-fora': 0,
  };
}

/** Custo zerado — o que o codec entrega quando o veredito não traz `cost`.
 *  Zeros explícitos (e não um objeto vazio) para o painel ler sem adivinhar. */
export function emptyCost(): ProbeCost {
  return {
    requests: 0, requestsPerPage: 0, p95RequestsPerPage: 0, latencyMs: 0,
    meanLatencyMs: 0, p95LatencyMs: 0, maxLatencyMs: 0, measuredPages: 0,
  };
}

// --- Veredito ---------------------------------------------------------------

export type ProbeStop = 'amostra-completa' | 'descoberta-pequena' | 'site-fora' | 'tmdb-indisponivel' | 'erro';

export interface ProbeVerdict {
  v: 2;
  site: string;
  verdict: ProbeVerdictName;
  at: number;
  sample: number;
  counts: ProbeCounts;
  rates: ProbeRates;
  bounds: ProbeBounds;
  denominators: ProbeDenominators;
  thresholds: ProbeThresholds;
  reasons: string[];
  stop: ProbeStop;
  kind: CrawlPageKind | 'mixed';
  /** Histograma por classe — ausente = zero em todas (ver o codec). */
  classes?: ProbeClasses;
  /** Custo medido (média e p95 de requisições e latência) por página. */
  cost?: ProbeCost;
}

/**
 * O que o codec ENTREGA: `classes` e `cost` sempre preenchidos, porque são
 * optional na escrita (campo versionado) e obrigatório na leitura — quem lê
 * não precisa tratar "medido" e "não medido" como o mesmo zero.
 */
export type ParsedProbeVerdict = ProbeVerdict & { classes: ProbeClasses; cost: ProbeCost };

const PROBE_STOPS: readonly ProbeStop[] = ['amostra-completa', 'descoberta-pequena', 'site-fora', 'tmdb-indisponivel', 'erro'];

/** Contagens que a v2 promete: sem `noWork` o payload veio de outra regra. */
const COUNTS_V2: Array<keyof ProbeCounts> = ['sample', 'valid', 'withRelease', 'magnets', 'identified', 'noWork', 'buttonNoMagnet', 'noTorrent'];

/**
 * Leitura TOLERANTE no que é apresentação e FECHADA no que autoriza. Ausente,
 * lixo, versão diferente, `stop` fora do enum ou contagem faltando é `null` — o
 * gate trata como "sem veredito" e nunca como "aprovado", que é o pior desfecho
 * possível de um portão. `classes`/`cost` são versionados OPCIONAIS (ausentes
 * viram zero; só o relatório os usa). `stop`, ao contrário, é EXIGIDO: o gate o
 * compara com `amostra-completa`, e assumir o valor que LIBERA quando o campo
 * falta seria fail-OPEN dentro de um codec fail-closed (assim um veredito
 * forjado sem `stop` passaria pela trava de amostragem).
 */
export function parseProbeVerdict(raw: string | null | undefined): ParsedProbeVerdict | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Partial<ProbeVerdict>;
  if (o.v !== PROBE_VERDICT_VERSION) return null;
  if (typeof o.site !== 'string' || !o.site) return null;
  if (o.verdict !== 'go' && o.verdict !== 'no-go' && o.verdict !== 'inconclusive') return null;
  if (!o.counts || typeof o.counts !== 'object' || !o.rates || typeof o.rates !== 'object') return null;
  if (!Array.isArray(o.reasons)) return null;
  if (!PROBE_STOPS.includes(o.stop as ProbeStop)) return null;
  const counts = o.counts as Partial<ProbeCounts>;
  for (const k of COUNTS_V2) if (!Number.isFinite(counts[k])) return null;
  return {
    v: PROBE_VERDICT_VERSION,
    site: o.site,
    verdict: o.verdict,
    at: Number.isFinite(o.at) ? Number(o.at) : 0,
    sample: Number(counts.sample),
    counts: { ...counts } as ProbeCounts,
    rates: o.rates as ProbeRates,
    bounds: (o.bounds ?? { valid: 0, magnet: 0, identify: 0 }) as ProbeBounds,
    denominators: (o.denominators ?? { sample: 0, buttonPages: 0, identifyAnswered: 0, validPages: 0 }) as ProbeDenominators,
    thresholds: (o.thresholds ?? DEFAULT_PROBE_THRESHOLDS) as ProbeThresholds,
    reasons: o.reasons as string[],
    stop: o.stop as ProbeStop,
    kind: (o.kind ?? 'mixed') as CrawlPageKind | 'mixed',
    classes: { ...emptyClasses(), ...(o.classes ?? {}) } as ProbeClasses,
    cost: { ...emptyCost(), ...(o.cost ?? {}) } as ProbeCost,
  };
}

