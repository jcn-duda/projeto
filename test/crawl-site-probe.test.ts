// Sonda amostral por site (Fase 8, 8.3), parte 1: o NÚCLEO PURO —
//
//   - amostra ESPALHADA e determinística (com rotação por `offset`);
//   - o limiar de cada eixo (e por que o `GO` exige o limite INFERIOR de
//     Wilson 95%, não a taxa bruta);
//   - a classificação de página e a CLASSE do desfecho, que é onde `no-work`
//     (resposta negativa) deixou de ser confundido com `tmdb-down` (TMDB
//     fora) — o defeito medido na rodada real do NerdFilmes (40 páginas, 21
//     `no-work` lidos como TMDB fora, identificação 19/19 = 100% falsa);
//   - os DENOMINADORES: cada taxa com a régua da decisão registrada, que é a
//     parte que mais importa e a mais fácil de errar em silêncio;
//   - o custo por página: média e p95 MEDIDOS de requisições e latência;
//   - o codec do `crawl_state` (round-trip, v1 recusado e leitura tolerante).
//
// A fronteira do processo — relatório sem segredo, parse de CLI/env e a prova
// de que dry-run+noPersist não escreve a fila — está em
// `crawl-site-probe-guard.test.ts` (mesma suíte, arquivo separado pela
// catraca de 400 linhas).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  DEFAULT_PROBE_THRESHOLDS, PROBE_MIN_SAMPLE, PROBE_STATE_KEY, PROBE_VERDICT_VERSION,
  classifyPage, costOf, decide, evenlySpaced, parseProbeVerdict, percentile,
  renderProbeVerdict, summarize, wilsonLower,
} = await import('../src/providers/crawl-site-probe.js');
import type { PageReading, ProbeCounts, ProbeVerdict } from '../src/providers/crawl-site-probe.js';

// --- Amostragem -------------------------------------------------------------

describe('sonda: amostra ESPALHADA e determinística', () => {
  const items = Array.from({ length: 100 }, (_, i) => i);

  test('cobre o acervo inteiro, não o começo dele', () => {
    const picked = evenlySpaced(items, 40, 0);
    assert.equal(picked.length, 40);
    assert.equal(picked[0], 0);
    assert.equal(picked[picked.length - 1], 97, 'a última posição é o fim da faixa, não 39');
    // A primeira página sozinha não pode ser representativa do acervo inteiro.
    const metade = picked.filter((i) => i >= 50).length;
    assert.ok(metade >= 18, `amostra concentrada no começo: só ${metade} na segunda metade`);
  });

  test('offset gira o conjunto (a 2ª rodada não mede as mesmas páginas)', () => {
    const first = evenlySpaced(items, 40, 0);
    const second = evenlySpaced(items, 40, 1);
    assert.notDeepEqual(first, second, 'offset 1 mudou o conjunto');
    assert.deepEqual(second, evenlySpaced(items, 40, 1), 'mesmo offset = mesma amostra');
    assert.deepEqual(evenlySpaced(items, 40, 40), first, 'offset ciclo de 40 volta ao original');
    assert.deepEqual(evenlySpaced(items, 40, -1), evenlySpaced(items, 40, 39), 'offset negativo é normalizado');
  });

  test('acervo menor que a amostra: devolve tudo, uma vez só', () => {
    assert.deepEqual(evenlySpaced([1, 2, 3], 40, 0), [1, 2, 3]);
    assert.deepEqual(evenlySpaced(items, 0), []);
    assert.deepEqual(evenlySpaced([], 40), []);
  });
});

// --- Wilson + classificação das páginas -------------------------------------

describe('sonda: o GO exige LIMITE INFERIOR, não a taxa bruta', () => {
  test('22/40 (55%) tem taxa bruta acima de 0.5 e limite abaixo', () => {
    assert.ok(22 / 40 > 0.5, 'a taxa bruta passaria');
    assert.ok(wilsonLower(22, 40) < 0.5, 'mas o limite inferior barra — evita GO por sorte');
    assert.ok(wilsonLower(550, 1000) > wilsonLower(22, 40), 'mesma taxa, amostra maior: limite mais fino');
    assert.ok(wilsonLower(1, 1) < 0.9, '1 de 1 não é 100% de certeza');
    assert.equal(wilsonLower(0, 0), 0, 'sem denominador não há limite (inconclusivo, não 0)');
  });

  test('monótono: mais acertos no mesmo denominador nunca piora o limite', () => {
    let anterior = 0;
    for (let k = 0; k <= 40; k += 1) {
      const atual = wilsonLower(k, 40);
      assert.ok(atual >= anterior, `regressão em k=${k}`);
      anterior = atual;
    }
  });
});

const reading = (over: Partial<PageReading> = {}): PageReading => ({
  bucket: 'withRelease', class: 'identificada', magnets: 1,
  identifyAnswered: true, identified: true, requests: 3, latencyMs: 500, slug: 'x', ...over,
});

/** Página com release e obra que NÃO veio (resposta negativa do TMDB). */
const noWork = (over: Partial<PageReading> = {}): PageReading => reading({ class: 'no-work', identified: false, ...over });

describe('sonda: classificação de página', () => {
  test('cada desfecho tem balde E classe, e as duas de identificação são distintas', () => {
    assert.equal(classifyPage({ kind: 'no-torrent', slug: 'a' }).class, 'sem-botao');
    assert.equal(classifyPage({ kind: 'no-torrent', slug: 'a' }).bucket, 'noTorrent');
    assert.equal(classifyPage({ kind: 'done', releases: 1, slug: 'a' }).class, 'identificada');
    assert.equal(classifyPage({ kind: 'error', detail: 'nenhum magnet', slug: 'a' }).class, 'botao-sem-magnet');
    assert.equal(classifyPage({ kind: 'error', detail: 'layout', slug: 'a' }).class, 'erro-pagina');
    assert.equal(classifyPage({ kind: 'error', siteLevelError: true, detail: '403', slug: 'a' }).class, 'site-fora');
  });

  test('botão anunciado sem magnet sai do texto do adaptador (única prova)', () => {
    const b = classifyPage({ kind: 'error', detail: 'vacatorrent: 3 botão(ões) anunciados, nenhum magnet', slug: 'a' });
    assert.equal(b.bucket, 'buttonNoMagnet');
    assert.equal(b.magnets, 0);
  });

  test('erro sem prova é CONSERVADOR, e o site fora é a sua própria classe', () => {
    assert.equal(classifyPage({ kind: 'error', detail: 'layout: página sem <h1> de título', slug: 'a' }).bucket, 'pageError');
    assert.equal(classifyPage({ kind: 'error', siteLevelError: true, detail: '403', slug: 'a' }).bucket, 'siteDown');
    assert.equal(classifyPage({ kind: 'desconhecido', slug: 'a' }).bucket, 'pageError');
  });

  test('TMDB fora: página COM release, identificação não respondida', () => {
    const b = classifyPage({ kind: 'error', detail: 'tmdb-indisponivel:tmdb', releases: 4, slug: 'a' });
    assert.equal(b.bucket, 'withRelease');
    assert.equal(b.magnets, 4, 'o desfecho carrega o lote — o magnet está contado');
    assert.equal(b.identifyAnswered, false, 'fora do denominador de identificação');
    assert.equal(b.class, 'tmdb-down', 'classe própria: a RESPOSTA nunca chegou');
  });

  // O defeito medido na rodada real: `no-work` era lido como "TMDB fora", e o
  // desfecho devolvia 0 releases — 21 páginas de série viravam 21 "TMDB
  // caídos", identificação 19/19 = 100% e magnets/página pela metade.
  test('no-work é RESPOSTA negativa: conta no denominador e mantém as releases vistas', () => {
    const b = classifyPage({ kind: 'no-work', releases: 7, detail: 'nome-sem-casamento', slug: 'a', latencyMs: 900 });
    assert.equal(b.bucket, 'withRelease', 'houve release na página');
    assert.equal(b.magnets, 7, 'as releases que o adaptador viu continuam contadas');
    assert.equal(b.identifyAnswered, true, 'o TMDB respondeu — não saiu do denominador');
    assert.equal(b.identified, false, 'e a resposta foi negativa');
    assert.equal(b.class, 'no-work');
    assert.equal(b.latencyMs, 900, 'a latência medida viaja com a leitura');
  });
});

/** n páginas com release (o resto: sem torrent, botão sem magnet, erro). Toda
 *  página com release que não foi identificada sai como `no-work` — a única
 *  leitura honesta de "houve torrent e a obra não veio". */
function mix(n: {
  release: number; identified: number; tmdbDown: number; noTorrent: number;
  noMagnet: number; error: number; magnetsPerRelease?: number;
}) {
  const out: PageReading[] = [];
  const mpr = n.magnetsPerRelease ?? 1;
  for (let i = 0; i < n.identified; i += 1) out.push(reading({ magnets: mpr }));
  for (let i = 0; i < n.release - n.identified - n.tmdbDown; i += 1) out.push(noWork({ magnets: mpr }));
  for (let i = 0; i < n.tmdbDown; i += 1) {
    out.push(reading({ magnets: mpr, class: 'tmdb-down', identifyAnswered: false, identified: false }));
  }
  for (let i = 0; i < n.noTorrent; i += 1) {
    out.push(reading({ bucket: 'noTorrent', class: 'sem-botao', magnets: 0, identifyAnswered: false, identified: false, requests: 2 }));
  }
  for (let i = 0; i < n.noMagnet; i += 1) {
    out.push(reading({ bucket: 'buttonNoMagnet', class: 'botao-sem-magnet', magnets: 0, identifyAnswered: false, identified: false, requests: 9 }));
  }
  for (let i = 0; i < n.error; i += 1) {
    out.push(reading({ bucket: 'pageError', class: 'erro-pagina', magnets: 0, identifyAnswered: false, identified: false, requests: 1 }));
  }
  return out;
}

describe('sonda: denominadores explícitos', () => {
  test('página só de streaming NÃO derruba a taxa de magnet', () => {
    // 40 páginas: 20 com release (20 magnets), 20 só de streaming.
    const s = summarize(mix({ release: 20, identified: 20, tmdbDown: 0, noTorrent: 20, noMagnet: 0, error: 0 }));
    assert.equal(s.counts.valid, 40, 'streaming é página válida');
    assert.equal(s.denominators.buttonPages, 20, 'o denominador de botão são só as 20 com botão');
    assert.equal(s.rates.magnet, 1, 'taxa de magnet 100%, não 50%');
    assert.equal(s.rates.magnetsPerPage, 1, '1 magnet por página COM botão');
  });

  test('botão sem magnet CONTA no denominador (é a falha que a taxa mede)', () => {
    const s = summarize(mix({ release: 10, identified: 10, tmdbDown: 0, noTorrent: 0, noMagnet: 30, error: 0 }));
    assert.equal(s.denominators.buttonPages, 40);
    assert.equal(s.rates.magnet, 0.25);
    assert.equal(s.rates.magnetsPerPage, 0.25);
  });

  test('erro de página SAI do numerador E do denominador de magnet', () => {
    const s = summarize(mix({ release: 20, identified: 20, tmdbDown: 0, noTorrent: 0, noMagnet: 0, error: 20 }));
    assert.equal(s.counts.valid, 20, 'página errada não é página válida');
    assert.equal(s.denominators.buttonPages, 20, 'não vira botão quebrado por falta de prova');
    assert.equal(s.rates.valid, 0.5);
    assert.equal(s.rates.magnet, 1, 'o que deu certo mede 100% do que deu certo');
  });

  test('os denominadores são declarados, não inferidos', () => {
    const s = summarize(mix({ release: 20, identified: 15, tmdbDown: 5, noTorrent: 10, noMagnet: 5, error: 0 }));
    assert.deepEqual(s.denominators, { sample: 35, validPages: 35, buttonPages: 25, identifyAnswered: 15 });
  });

  // A rodada real do NerdFilmes: 40 páginas, 20 de série. As 21 `no-work` são
  // resposta do TMDB ("não é esta obra"), NÃO TMDB fora — e elas rendem.
  test('`no-work` conta como resposta negativa e `no-work` ≠ `tmdbDown`', () => {
    const s = summarize(mix({ release: 40, identified: 19, tmdbDown: 0, noTorrent: 0, noMagnet: 0, error: 0 }));
    assert.equal(s.counts.withRelease, 40);
    assert.equal(s.counts.identified, 19);
    assert.equal(s.counts.noWork, 21, 'contagem própria da resposta negativa');
    assert.equal(s.counts.tmdbDown, 0, 'o TMDB respondeu em todas: nenhuma página saiu do denominador');
    assert.equal(s.denominators.identifyAnswered, 40, 'o denominador é a página com release, menos TMDB fora');
    assert.equal(s.rates.identify, 0.475, 'a lacuna aparece, em vez de 100% falso');
    assert.equal(s.counts.magnets, 40, 'as 40 páginas renderam release — inclusive as de série');
    assert.deepEqual(s.classes, {
      identificada: 19, 'no-work': 21, 'tmdb-down': 0, 'botao-sem-magnet': 0,
      'sem-botao': 0, 'erro-pagina': 0, 'site-fora': 0,
    });
  });

  test('`no-work` e `tmdb-down` são contagens independentes', () => {
    const s = summarize(mix({ release: 10, identified: 4, tmdbDown: 2, noTorrent: 0, noMagnet: 0, error: 0 }));
    assert.equal(s.counts.noWork, 4);
    assert.equal(s.counts.tmdbDown, 2);
    assert.equal(s.denominators.identifyAnswered, 8, '10 com release − 2 sem resposta do TMDB');
    assert.equal(s.rates.identify, 0.5);
    assert.equal(s.counts.magnets, 10, 'as 10 releases contam em magnets, com ou sem obra');
    const todas = summarize(mix({ release: 20, identified: 15, tmdbDown: 5, noTorrent: 0, noMagnet: 0, error: 0 }));
    assert.equal(todas.rates.identify, 1, '15 respondidas, 15 identificadas');
  });
});

// --- Custo por página (medido, não estimado) --------------------------------

describe('sonda: custo por página com p95 MEDIDO', () => {
  test('percentil nearest-rank sobre as amostras reais', () => {
    const dez = Array.from({ length: 10 }, (_, i) => i + 1);
    assert.equal(percentile(dez, 0.95), 10, 'ceil(0.95·10)=10 → o maior');
    assert.equal(percentile(dez, 0.5), 5);
    assert.equal(percentile([7], 0.95), 7, 'amostra única: o p95 é a própria medida');
    assert.equal(percentile([], 0.95), 0, 'sem amostra o p95 é 0 — e `measuredPages` diz 0');
  });

  test('média e p95 saem das leituras, e o denominador é declarado', () => {
    const leituras = Array.from({ length: 40 }, (_, i) => reading({
      requests: i + 1, latencyMs: (i + 1) * 100,
    }));
    const c = costOf(leituras);
    assert.equal(c.requests, 820, 'soma de 1..40');
    assert.equal(c.requestsPerPage, 20.5, '820/40');
    assert.equal(c.p95RequestsPerPage, 38, 'nearest-rank: ceil(0.95·40)=38 → 38ª menor = 38');
    assert.equal(c.meanLatencyMs, 2050, '(100+…+4000)/40');
    assert.equal(c.p95LatencyMs, 3800);
    assert.equal(c.maxLatencyMs, 4000);
    assert.equal(c.measuredPages, 40, 'o p95 diz sobre quantas páginas foi medido');
  });

  test('página sem cronômetro não some em silêncio: `measuredPages` cai', () => {
    const c = costOf([
      reading({ latencyMs: 100 }), reading({ latencyMs: 300 }), reading({ latencyMs: Number.NaN }),
    ]);
    assert.equal(c.measuredPages, 2);
    assert.equal(c.meanLatencyMs, 200, 'média só das medidas');
    assert.equal(c.p95LatencyMs, 300, 'p95 é a maior medida — de 2, não de 3');
  });
});

// --- Veredito ---------------------------------------------------------------

describe('sonda: veredito', () => {
  test('GO exige os três limites inferiores acima do limiar', () => {
    // 40 páginas: 20 com botão e 2 magnet cada (2.0/página), 20 só streaming.
    const s = summarize(mix({
      release: 20, identified: 18, tmdbDown: 0, noTorrent: 20, noMagnet: 0,
      error: 0, magnetsPerRelease: 2,
    }));
    const d = decide(s, DEFAULT_PROBE_THRESHOLDS);
    assert.equal(d.verdict, 'go', `esperado go, reasons=${d.reasons.join(',')} bounds=${JSON.stringify(s.bounds)}`);
  });

  test('mesma amostra, 1 magnet por página com botão: reprova no piso de produtividade', () => {
    const s = summarize(mix({
      release: 20, identified: 18, tmdbDown: 0, noTorrent: 0, noMagnet: 4,
      error: 0, magnetsPerRelease: 1,
    }));
    const d = decide(s, DEFAULT_PROBE_THRESHOLDS);
    assert.equal(d.verdict, 'no-go');
    assert.ok(d.reasons.includes('abaixo-limiar:magnets-por-pagina'), d.reasons.join(','));
  });

  test('NO-GO nomeia o eixo que reprovou', () => {
    const s = summarize(mix({ release: 20, identified: 20, tmdbDown: 0, noTorrent: 0, noMagnet: 0, error: 20 }));
    const d = decide(s, DEFAULT_PROBE_THRESHOLDS);
    assert.equal(d.verdict, 'no-go');
    assert.ok(d.reasons.includes('abaixo-limiar:valid'), d.reasons.join(','));
  });

  test('site fora é INCONCLUSIVO, não NO-GO: foi o dia, não a fonte', () => {
    const base = mix({ release: 4, identified: 4, tmdbDown: 0, noTorrent: 0, noMagnet: 0, error: 0 });
    assert.equal(decide(summarize(base)).verdict, 'inconclusive', '4 páginas é amostra pequena');
    const d = decide(summarize([...base, ...Array.from({ length: 6 }, () => reading({ bucket: 'siteDown' }))]));
    assert.equal(d.verdict, 'inconclusive');
    assert.ok(d.reasons.includes('site-fora'), d.reasons.join(','));
  });

  test('amostra pequena não vira veredito', () => {
    const pequeno = summarize(mix({ release: 10, identified: 10, tmdbDown: 0, noTorrent: 0, noMagnet: 0, error: 0 }));
    assert.ok(pequeno.counts.sample < PROBE_MIN_SAMPLE);
    const d = decide(pequeno);
    assert.equal(d.verdict, 'inconclusive');
    assert.ok(d.reasons.includes('amostra-pequena'));
  });

  test('site que responde e não publica torrent é NO-GO (veredito honesto)', () => {
    const s = summarize(mix({ release: 0, identified: 0, tmdbDown: 0, noTorrent: 40, noMagnet: 0, error: 0 }));
    const d = decide(s);
    assert.equal(d.verdict, 'no-go');
    assert.ok(d.reasons.includes('sem-botao-de-torrent'));
  });

  test('TMDB fora em TODA página com release é inconclusivo, não culpa do site', () => {
    const s = summarize(mix({ release: 30, identified: 0, tmdbDown: 30, noTorrent: 10, noMagnet: 0, error: 0 }));
    const d = decide(s);
    assert.equal(d.verdict, 'inconclusive');
    assert.ok(d.reasons.includes('tmdb-indisponivel'), d.reasons.join(','));
  });

  test('no-work dominante é INFORMATIVO: a lacuna de identificação é nossa', () => {
    const s = summarize(mix({ release: 30, identified: 10, tmdbDown: 0, noTorrent: 0, noMagnet: 0, error: 0, magnetsPerRelease: 2 }));
    const d = decide(s);
    assert.ok(d.reasons.includes('no-work-dominante'), d.reasons.join(','));
    assert.ok(d.reasons.includes('abaixo-limiar:identify'), 'e a taxa reprova de verdade, não só o aviso');
    assert.equal(d.verdict, 'no-go');
    assert.ok(!d.reasons.includes('tmdb-indisponivel'), 'o TMDB respondeu: não é inconclusivo por dependência nossa');
  });

  test('limiar customizado move o portão (o default é só default)', () => {
    const s = summarize(mix({ release: 30, identified: 25, tmdbDown: 0, noTorrent: 0, noMagnet: 0, error: 0 }));
    assert.equal(decide(s, DEFAULT_PROBE_THRESHOLDS).verdict, 'go');
    const exigente = { ...DEFAULT_PROBE_THRESHOLDS, identifyRate: 0.99 };
    const d = decide(s, exigente);
    assert.equal(d.verdict, 'no-go');
    assert.ok(d.reasons.includes('abaixo-limiar:identify'));
  });
});

// --- Codec ------------------------------------------------------------------

const verdictValido = (over: Partial<ProbeVerdict> = {}): ProbeVerdict => {
  const readings = mix({ release: 30, identified: 25, tmdbDown: 0, noTorrent: 6, noMagnet: 4, error: 0 });
  const s = summarize(readings);
  return {
    v: PROBE_VERDICT_VERSION, site: 'vacatorrent', verdict: 'go', at: 1_700_000_000_000, sample: 40,
    counts: s.counts as ProbeCounts, rates: s.rates, bounds: s.bounds,
    denominators: s.denominators, thresholds: DEFAULT_PROBE_THRESHOLDS,
    reasons: ['site-fora'], stop: 'amostra-completa', kind: 'movie',
    classes: s.classes, cost: s.cost, ...over,
  };
};

describe('sonda: codec do crawl_state', () => {
  test('round-trip preserva o que o painel e o gate leem, mais o custo e as classes', () => {
    const v = verdictValido();
    const lido = parseProbeVerdict(renderProbeVerdict(v));
    assert.ok(lido);
    assert.equal(lido.site, v.site);
    assert.equal(lido.verdict, 'go');
    assert.equal(lido.at, v.at);
    assert.equal(lido.sample, 40);
    assert.equal(lido.counts.withRelease, 30);
    assert.equal(lido.counts.noWork, 5, 'as 5 páginas restantes têm release e obra não veio');
    assert.deepEqual(lido.reasons, ['site-fora']);
    assert.equal(lido.cost.requestsPerPage, v.cost?.requestsPerPage);
    assert.equal(lido.classes.identificada, 25);
    assert.equal(lido.classes['no-work'], 5);
    assert.equal(PROBE_STATE_KEY, 'probe:verdict', 'a chave é a única que a sonda escreve');
  });

  // Bump deliberado: o v1 media identificação com o denominador errado (o
  // `no-work` não contava) e devolvia 0 releases na página sem obra. Um veredito
  // medido assim não pode continuar autorizando a rotação.
  test('v1 é recusado: o gate compara a versão e falha fechado', () => {
    assert.equal(PROBE_VERDICT_VERSION, 2);
    const velho = JSON.stringify({ ...JSON.parse(renderProbeVerdict(verdictValido())), v: 1 });
    assert.equal(parseProbeVerdict(velho), null, 'veredito com o denominador antigo não é veredito');
  });

  test('lixo, ausente, versão alheia, `stop` fora e `noWork` faltando: "sem veredito"', () => {
    for (const raw of [null, undefined, '', '   ', 'lixo', '{', '[]', '42', '"go"']) {
      assert.equal(parseProbeVerdict(raw), null, `raw=${String(raw)}`);
    }
    const base = JSON.parse(renderProbeVerdict(verdictValido())) as Record<string, unknown>;
    assert.equal(parseProbeVerdict(JSON.stringify({ ...base, v: 99 })), null, 'versão alheia');
    assert.equal(parseProbeVerdict(JSON.stringify({ ...base, site: '' })), null, 'sem site');
    assert.equal(parseProbeVerdict(JSON.stringify({ ...base, verdict: 'talvez' })), null, 'veredito fora do enum');
    assert.equal(parseProbeVerdict(JSON.stringify({ ...base, rates: undefined })), null, 'sem rates');
    // `stop` é EXIGIDO: o gate o compara com `amostra-completa`, e assumir o
    // valor que libera quando o campo falta seria fail-OPEN.
    assert.equal(parseProbeVerdict(JSON.stringify({ ...base, stop: undefined })), null, 'sem `stop`');
    assert.equal(parseProbeVerdict(JSON.stringify({ ...base, stop: 'livre' })), null, '`stop` fora do enum');
    const { noWork: _omitido, ...counts } = base.counts as Record<string, unknown>;
    assert.equal(parseProbeVerdict(JSON.stringify({ ...base, counts })), null, 'v2 sem `noWork` é de outra regra');
  });

  test('`classes`/`cost` são OPCIONAIS: ausentes viram zero, veredito continua válido', () => {
    const base = JSON.parse(renderProbeVerdict(verdictValido())) as Record<string, unknown>;
    const { classes: _c, cost: _k, ...semCusto } = base;
    const lido = parseProbeVerdict(JSON.stringify(semCusto));
    assert.ok(lido, 'campo de relatório ausente não invalida o veredito');
    assert.equal(lido.classes['no-work'], 0);
    assert.equal(lido.cost.measuredPages, 0, 'zero medido, nunca p95 inventado');
  });
});

