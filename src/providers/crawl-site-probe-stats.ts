// Estatística da SONDA por site (Fase 8, 8.3) — o agregador PURO.
//
// Saiu de `crawl-site-probe.ts` por um motivo prático e um honesto. O
// prático: o contrato (o que é gravado no `crawl_state`, a classificação de
// página, os limiares, o codec) já estava no teto de 400 linhas, e a correção
// de honestidade da rodada real do NerdFilmes exigiu campos novos. O honesto:
// agregação é responsabilidade diferente de contrato, e o agregador é o único
// lugar onde um número do relatório pode ser inventado — quem julga o veredito
// (`decide`) lê o que este módulo mede, e os dois no mesmo arquivo dariam a
// chance de o limiar ser calibrado contra o número que ele próprio produz.
//
// NENHUMA decisão mora aqui: este módulo mede, `decide` julga. O `p95` é
// PERCENTIL NEAREST-RANK sobre as amostras reais da rodada — medido, nunca
// estimado, e `measuredPages` diz sobre quantas páginas ele foi medido (uma
// página não cronometrada não some da média em silêncio).
import type {
  PageBucket,
  PageReading,
  ProbeBounds,
  ProbeClass,
  ProbeClasses,
  ProbeCost,
  ProbeCounts,
  ProbeRates,
  ProbeSummary,
} from './crawl-site-probe.js';

/** z de 95% (bilateral). */
const WILSON_Z = 1.96;

/**
 * Amostra ESPALHADA e determinística: `k` posições igualmente distribuídas
 * sobre a descoberta, com `offset` girando o conjunto entre rodadas. Pegar as
 * primeiras 40 mede um pedaço contíguo do acervo (e o mesmo pedaço toda
 * rodada); espalhar cobre a Posting/entrada/saída do sitemap.
 */
export function evenlySpaced<T>(items: readonly T[], k: number, offset = 0): T[] {
  const n = items.length;
  const want = Math.max(0, Math.trunc(k));
  if (!n || !want) return [];
  if (n <= want) return items.slice();
  const shift = ((Math.trunc(offset) % want) + want) % want;
  const stride = n / want;
  const out: T[] = [];
  for (let i = 0; i < want; i += 1) out.push(items[Math.min(n - 1, Math.floor((i + shift) * stride))]);
  return out;
}

/** Baldes que provam que a página foi lida e tem destino no acervo. */
export const VALID_BUCKETS: ReadonlySet<PageBucket> = new Set<PageBucket>(['withRelease', 'buttonNoMagnet', 'noTorrent']);

/**
 * Limite inferior de Wilson 95% da proportion `successes/n`. É a estatística
 * certa para "o site é bom?": com n pequeno, o ponto mente para cima e a assimetria
 * da distribuição também — o limite inferior é o pior caso ainda compatível com
 * o que medimos. `n = 0` é INDEFINIDO, e a regra do veredito trata isso como
 * "não medido" em vez de 0 (que diria "site ruim" sem nenhuma evidência).
 */
export function wilsonLower(successes: number, n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const k = Math.max(0, Math.min(n, Math.trunc(successes)));
  const p = k / n;
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (WILSON_Z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, Math.min(1, center - margin));
}

/**
 * Percentil NEAREST-RANK: o menor valor com pelo menos `p` das amostras ≤ ele
 * (`sorted[ceil(p·n)-1]`). É a régua do p95 de rede — o que a sonda publica é
 * uma MEDIDA de uma amostra real, não uma interpolação que parece mais
 * precisa do que é. Sem amostras devolve 0, e quem chama diz que não mediu.
 */
export function percentile(samples: readonly number[], p: number): number {
  const vals = samples.filter((n) => Number.isFinite(n));
  if (!vals.length) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const rank = Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const round = (n: number, casas: number): number => {
  const f = 10 ** casas;
  return Math.round(n * f) / f;
};

const total = (vals: readonly number[]): number => vals.reduce((t, n) => t + n, 0);

/** Maior sem `Math.max(...vals)`: o spread estoura em lote grande. */
const maxOf = (vals: readonly number[]): number => vals.reduce((m, n) => (n > m ? n : m), 0);

/**
 * CUSTO por página: requisições (medidas pelo adaptador, com o piso 1 do
 * motor) e LATÊNCIA (cronometrada pela CLI em volta da leitura da página).
 * As duas entram medidas e as duas dizem o denominador: `requests` soma o que
 * a rodada gastou, `requestsPerPage` e `p95RequestsPerPage` são por página da
 * amostra, e `measuredPages` é quantas páginas a CLI de fato cronometrou — o
 * p95 de latência é sobre essas, não sobre a amostra inteira.
 */
export function costOf(readings: readonly PageReading[]): ProbeCost {
  const req = readings.map((r) => Math.max(0, Math.trunc(Number(r.requests) || 0)));
  const lat = readings.map((r) => Number(r.latencyMs)).filter((n) => Number.isFinite(n) && n >= 0);
  const n = readings.length;
  return {
    requests: total(req),
    requestsPerPage: n ? round(total(req) / n, 2) : 0,
    p95RequestsPerPage: round(percentile(req, 0.95), 2),
    latencyMs: total(lat),
    meanLatencyMs: lat.length ? round(total(lat) / lat.length, 0) : 0,
    p95LatencyMs: round(percentile(lat, 0.95), 0),
    maxLatencyMs: lat.length ? maxOf(lat) : 0,
    measuredPages: lat.length,
  };
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

/**
 * Histograma por CLASSE. É o campo que separa o que o balde agrupava: a
 * rodada real do NerdFilmes tinha 21 páginas `no-work` e ZERO `tmdb-down`, e
 * as duas coisas estavam no mesmo contador `tmdbDown` — o que fazia a sonda
 * dizer que o TMDB estava fora quando ele tinha respondido "não é esta obra".
 */
export function classesOf(readings: readonly PageReading[]): ProbeClasses {
  const out = emptyClasses();
  for (const r of readings) out[r.class] = (out[r.class] ?? 0) + 1;
  return out;
}

const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);
const rate = (n: number): number => round(n, 3);

/**
 * Agrega a rodada. Denominadores explícitos (ver o cabeçalho do módulo da
 * sonda): `identifyAnswered` é `withRelease` MENOS as páginas em que o TMDB
 * não respondeu — o `no-work` fica dentro, porque ele É resposta.
 */
export function summarize(readings: readonly PageReading[]): ProbeSummary {
  const counts: ProbeCounts = {
    sample: readings.length, valid: 0, pageErrors: 0, siteLevel: 0, noTorrent: 0,
    buttonNoMagnet: 0, withRelease: 0, magnets: 0, identified: 0, noWork: 0,
    tmdbDown: 0, requests: 0,
  };
  for (const r of readings) {
    counts.requests += r.requests;
    if (VALID_BUCKETS.has(r.bucket)) counts.valid += 1;
    if (r.bucket === 'noTorrent') counts.noTorrent += 1;
    if (r.bucket === 'buttonNoMagnet') counts.buttonNoMagnet += 1;
    if (r.bucket === 'pageError') counts.pageErrors += 1;
    if (r.bucket === 'siteDown') counts.siteLevel += 1;
    if (r.bucket === 'withRelease') {
      counts.withRelease += 1;
      // `magnets` conta as releases ÚNICAS que o adaptador viu na página (o
      // desfecho do `processCrawlPage` já vem deduplicado por hash), com ou
      // sem obra: release sem `no-work` é release, e escondê-la subcontava a
      // produtividade do site.
      counts.magnets += r.magnets;
      if (r.identifyAnswered) {
        if (r.identified) counts.identified += 1;
        else counts.noWork += 1;
      } else counts.tmdbDown += 1;
    }
  }
  const buttonPages = counts.withRelease + counts.buttonNoMagnet;
  const identifyAnswered = counts.withRelease - counts.tmdbDown;
  return {
    counts,
    rates: {
      valid: rate(ratio(counts.valid, counts.sample)),
      magnet: rate(ratio(counts.withRelease, buttonPages)),
      identify: rate(ratio(counts.identified, identifyAnswered)),
      magnetsPerPage: rate(ratio(counts.magnets, buttonPages)),
    },
    bounds: {
      valid: rate(wilsonLower(counts.valid, counts.sample)),
      magnet: rate(wilsonLower(counts.withRelease, buttonPages)),
      identify: rate(wilsonLower(counts.identified, identifyAnswered)),
    },
    denominators: { sample: counts.sample, buttonPages, identifyAnswered, validPages: counts.valid },
    classes: classesOf(readings),
    cost: costOf(readings),
  };
}
