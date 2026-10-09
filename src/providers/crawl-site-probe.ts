// Sonda AMOSTRAL por site (plano "Raspagem total", Fase 8 — item 8.3).
//
// Pergunta que ela responde, antes de ligar qualquer site novo na rotação: "se o
// motor raspar este site por 12 h, o que ele volta?" — medida numa amostra
// ESPALHADA de páginas, com o MESMO adaptador que a produção usa, sem gravar
// uma linha de acervo.
//
// Onde mora: aqui fica o CONTRATO — o que é gravado no `crawl_state`, a
// classificação de página, os limiares e o codec. A agregação (Wilson,
// `summarize`, média e p95 de custo) vive em `crawl-site-probe-stats.ts` e é
// reexportada aqui, que é a superfície pública do módulo. A rede e a gravação
// do veredito ficam no operador (`scripts/crawl-site-probe.ts`). Nenhum import
// daqui abre banco nem rede — é por isso que o teste cobre tudo sem stub.
//
// DENOMINADORES (decisão registrada, e a parte que mais importa do desenho):
// cada taxa responde a uma pergunta diferente e por isso NÃO divide pela
// amostra inteira:
//   - `validRate`       = páginas válidas ÷ AMOSTRA. "O site responde?";
//   - `magnetRate`      = páginas com release ÷ páginas COM BOTÃO DE TORRENT.
//     Página só de streaming (`no-torrent`) não tem botão: contá-la no
//     denominador faria um site 60% streaming e 100% produtivo parecer 40%;
//   - `magnetsPerPage`  = magnets OBSERVADOS ÷ páginas COM BOTÃO — mesma régua;
//   - `identifyRate`    = identificadas ÷ páginas COM RELEASE, MENOS as páginas
//     em que o TMDB NÃO respondeu. `no-work` (a obra não veio) é RESPOSTA da
//     identificação e entra no denominador como negativa; só `error` com
//     `tmdb-indisponivel` fica de fora, porque mediria a NOSSA dependência e
//     não o site (e `tmdbDown` sai no relatório à parte).
//
// v2 — BUMP DELIBERADO (medido na rodada real do NerdFilmes, 2026-09-28). A v1
// tratava `no-work` como "identificação não respondida" E o desfecho devolvia 0
// releases nessa página. Com 40 páginas (20 de série) isso produziu
// identificação 19/19 = 100% FALSO e `magnetsPerPage` 22/40 = 0.55: a sonda
// afirmava que o site identificava tudo e rendia pouco, quando a verdade é a
// inversa — 21 das 40 eram série que o TMDB não resolve por título, e elas
// rendiam sim. O gate passa a recusar v1 (falhando fechado, `sem-veredito`):
// veredito medido com o denominador errado não autoriza rotação, e remedir é o
// procedimento normal da sonda.
//
// O `GO` exige o LIMITE INFERIOR do intervalo de Wilson 95%, não a taxa bruta:
// com 40 páginas, 22 acertos dariam 55% — acima de qualquer limiar razoável —
// e o site entraria na rotação por sorte. O ponto e o limite saem os dois no
// relatório, para o operador ver o que passou e por quanto.
//
// Erro de página NUNCA vira botão quebrado sem prova, e o botão quebrado
// NUNCA vira "site fora": as duas confusões custam caro em direções opostas
// (falso GO de uma fonte morta; falso NO-GO de um site bom num dia ruim). Onde
// a prova falta, a classificação é CONSERVADORA — a página não conta como boa —
// e `counts` traz o detalhe para o olho humano auditar.
import type { CrawlPageKind } from './crawl-types.js';

// A estatística mora no módulo irmão; a reexportação mantém a superfície
// pública da sonda num import só (o gate e o painel importam daqui).
import { costOf, classesOf, emptyClasses, emptyCost, evenlySpaced, percentile, summarize, wilsonLower } from './crawl-site-probe-stats.js';
export { costOf, classesOf, emptyClasses, emptyCost, evenlySpaced, percentile, summarize, wilsonLower };

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
 * Defaults. A taxa bruta é meta de LEITURA; o que aprova é o limite inferior
 * (ver o cabeçalho). `magnetsPerPage >= 1` é o piso de produtividade: abaixo
 * disso a fonte não compensa o custo de manter o site no teto por hora.
 */
export const DEFAULT_PROBE_THRESHOLDS: ProbeThresholds = {
  validRate: 0.6, magnetRate: 0.5, identifyRate: 0.5, magnetsPerPage: 1,
};

/** Amostra do plano (mede 40 como foi feito no Vaca) e o piso para veredito. */
export const PROBE_SAMPLE = 40;
export const PROBE_MIN_SAMPLE = 20;
/** Abaixo disto o site provavelmente estava fora/desafio: inconclusivo, não NO-GO. */
export const PROBE_MIN_VALID_PAGES = 8;

// --- Classificação de página -----------------------------------------------

export type PageBucket = 'withRelease' | 'buttonNoMagnet' | 'noTorrent' | 'pageError' | 'siteDown';

export interface PageReading {
  bucket: PageBucket;
  /** A CLASSE do desfecho, para o relatório separar o que o balde agrupa. */
  class: ProbeClass;
  /** Releases ÚNICAS que o adaptador viu nesta página (0 se não houve). */
  magnets: number;
  /** A identificação foi RESPONDIDA (false = TMDB fora, fora do denominador). */
  identifyAnswered: boolean;
  identified: boolean;
  requests: number;
  /** Latência MEDIDA da leitura da página (ms), cronometrada pela CLI. */
  latencyMs: number;
  /** Slug da página — o relatório nunca carrega a URL completa. */
  slug: string;
}

/** Desfechos do `processCrawlPage` que só existem DEPOIS de haver release. */
const RELEASE_KINDS: ReadonlySet<string> = new Set(['done', 'simulated', 'no-work', 'partial']);

export interface ClassifyInput {
  kind: string;
  siteLevelError?: boolean;
  detail?: string | null;
  /** Releases vistas no desfecho — o observado, nunca o gravado. */
  releases?: number;
  requests?: number;
  /** Latência medida da página em ms (a CLI cronometra; ausente = 0). */
  latencyMs?: number;
  slug: string;
}

/**
 * O adaptador sinaliza "havia botão e nenhum magnet saiu" pelo TEXTO do erro —
 * não há campo estruturado para isso no contrato `CrawlWorkResult` (a promessa
 * é `no-torrent`/`error`, e o "erro" cobre layout E botão morto). A lista é
 * declarativa e versionada com a sonda: o marcador do adaptador é a única
 * prova disponível, e sem ele a página cai em `pageError` (conservadora).
 */
export const NO_MAGNET_MARKERS: readonly RegExp[] = [
  /nenhum\s+magnet/i,
  /botão\(ões\)\s+anunciados/i,
  /nenhum\s+(?:botão|magnet)/i,
];

const TMDB_DOWN_RE = /^tmdb-indisponivel/i;

export function classifyPage(input: ClassifyInput): PageReading {
  const slug = String(input.slug || '');
  const requests = Math.max(0, Math.trunc(Number(input.requests) || 0));
  const releases = Math.max(0, Math.trunc(Number(input.releases) || 0));
  const latency = Math.max(0, Math.round(Number(input.latencyMs) || 0));
  const detail = String(input.detail || '');
  const base = { magnets: 0, identifyAnswered: false, identified: false, requests, latencyMs: latency, slug };
  const kind = String(input.kind || '');

  if (kind === 'no-torrent') return { ...base, class: 'sem-botao', bucket: 'noTorrent' };
  if (RELEASE_KINDS.has(kind)) {
    // Houve release na página. `no-work` é a resposta NEGATIVA da identificação
    // (o TMDB respondeu que não é esta obra): conta no denominador de
    // identificação como não identificada, e as releases que o adaptador viu
    // entram em `magnets` — sem isso a média de magnets/página contava a
    // série (que é onde a maior parte do acervo BR está) como se fosse vazia.
    if (kind === 'no-work') {
      return { ...base, class: 'no-work', bucket: 'withRelease', magnets: releases, identifyAnswered: true, identified: false };
    }
    return { ...base, class: 'identificada', bucket: 'withRelease', magnets: releases, identifyAnswered: true, identified: true };
  }
  if (kind === 'error' || kind === '') {
    if (input.siteLevelError) return { ...base, class: 'site-fora', bucket: 'siteDown' };
    if (TMDB_DOWN_RE.test(detail)) {
      // Página COM release (o `PageOutcome` carrega o lote) e identificação
      // NÃO respondida: fora do denominador, e conta em `tmdbDown` — o que o
      // `no-work` NÃO pode fazer, porque aqui a resposta nunca chegou.
      return { ...base, class: 'tmdb-down', bucket: 'withRelease', magnets: releases };
    }
    if (NO_MAGNET_MARKERS.some((re) => re.test(detail))) {
      return { ...base, class: 'botao-sem-magnet', bucket: 'buttonNoMagnet' };
    }
    return { ...base, class: 'erro-pagina', bucket: 'pageError' };
  }
  return { ...base, class: 'erro-pagina', bucket: 'pageError' };
}

export interface ProbeSummary {
  counts: ProbeCounts;
  rates: ProbeRates;
  bounds: ProbeBounds;
  /** Denominadores EFFECTIVOS de cada taxa — impressos para não haver dúvida. */
  denominators: { sample: number; buttonPages: number; identifyAnswered: number; validPages: number };
  /** Histograma por classe (o `no-work` separado do `tmdb-down`). */
  classes: ProbeClasses;
  /** Custo medido por página (requisições e latência, com p95). */
  cost: ProbeCost;
}

// `evenlySpaced` e a agregação (Wilson, `summarize`, classes, custo) foram para
// `crawl-site-probe-stats.ts` — reexportadas no topo deste arquivo.

// --- Veredito ---------------------------------------------------------------

export type ProbeStop = 'amostra-completa' | 'descoberta-pequena' | 'site-fora' | 'tmdb-indisponivel' | 'erro';

export interface ProbeDecision {
  verdict: ProbeVerdictName;
  /** Códigos curtos e ESTÁVEIS (o painel agrupa por eles, nunca pelo texto). */
  reasons: string[];
}

export interface ProbeVerdict {
  v: 2;
  site: string;
  verdict: ProbeVerdictName;
  at: number;
  sample: number;
  counts: ProbeCounts;
  rates: ProbeRates;
  bounds: ProbeBounds;
  denominators: ProbeSummary['denominators'];
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

/**
 * Regra do veredito, na ordem em que as travas valem:
 *   1. amostra pequena demais → inconclusivo (não se mede com 8 páginas);
 *   2. poucas páginas válidas → inconclusivo: o SITE estava fora/desafio, e
 *      isso não é veredito sobre a fonte (remede outro dia);
 *   3. site responde e não tem botão nenhum → NO-GO, que é veredito honesto;
 *   4. release com identificação nunca respondida → inconclusivo (é o TMDB);
 *   5. fora isso, cada eixo compara o LIMITE INFERIOR com o limiar.
 * `site-fora`/`tmdb-parcial`/`no-work-dominante` são informativos: explicam a
 * nota sem mudar o veredito, e o painel mostra por quê. `no-work-dominante`
 * aponta a lacuna que é NOSSA (o TMDB não resolve série por título), para
 * ninguém ler a taxa de identificação baixa como falha do site.
 */
export function decide(
  summary: ProbeSummary,
  thresholds: ProbeThresholds = DEFAULT_PROBE_THRESHOLDS,
): ProbeDecision {
  const { counts, rates, bounds, denominators } = summary;
  const reasons: string[] = [];
  // Informativos: explicam a nota sem mudar o veredito.
  if (counts.siteLevel > 0) reasons.push('site-fora');
  if (counts.tmdbDown > 0) reasons.push('tmdb-parcial');
  if (counts.noWork > counts.identified) reasons.push('no-work-dominante');

  if (counts.sample < PROBE_MIN_SAMPLE) return { verdict: 'inconclusive', reasons: [...reasons, 'amostra-pequena'] };
  if (counts.valid < PROBE_MIN_VALID_PAGES) return { verdict: 'inconclusive', reasons: [...reasons, 'poucas-paginas-validas'] };
  if (denominators.buttonPages === 0) return { verdict: 'no-go', reasons: [...reasons, 'sem-botao-de-torrent'] };
  if (counts.withRelease > 0 && denominators.identifyAnswered === 0) {
    return { verdict: 'inconclusive', reasons: [...reasons, 'tmdb-indisponivel'] };
  }

  if (bounds.valid < thresholds.validRate) reasons.push('abaixo-limiar:valid');
  if (bounds.magnet < thresholds.magnetRate) reasons.push('abaixo-limiar:magnet');
  if (denominators.identifyAnswered > 0 && bounds.identify < thresholds.identifyRate) {
    reasons.push('abaixo-limiar:identify');
  }
  if (rates.magnetsPerPage < thresholds.magnetsPerPage) reasons.push('abaixo-limiar:magnets-por-pagina');
  return {
    verdict: reasons.some((r) => r.startsWith('abaixo-limiar:')) ? 'no-go' : 'go',
    reasons,
  };
}

// --- Codec do crawl_state ---------------------------------------------------

export function renderProbeVerdict(v: ProbeVerdict): string {
  return JSON.stringify(v);
}

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
    denominators: (o.denominators ?? { sample: 0, buttonPages: 0, identifyAnswered: 0, validPages: 0 }) as ProbeSummary['denominators'],
    thresholds: (o.thresholds ?? DEFAULT_PROBE_THRESHOLDS) as ProbeThresholds,
    reasons: o.reasons as string[],
    stop: o.stop as ProbeStop,
    kind: (o.kind ?? 'mixed') as CrawlPageKind | 'mixed',
    classes: { ...emptyClasses(), ...(o.classes ?? {}) } as ProbeClasses,
    cost: { ...emptyCost(), ...(o.cost ?? {}) } as ProbeCost,
  };
}

