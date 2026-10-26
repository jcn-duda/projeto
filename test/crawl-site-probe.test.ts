// Sonda amostral por site (Fase 8, 8.3): o CODEC do `crawl_state` — o que o
// portão (`crawl-probe-gate.ts`) lê para liberar um site. A sonda que media
// (amostra, classificação, Wilson, `decide`) saiu com o motor TS do raspador;
// o veredito aqui é literal, no formato v2 que ela gravava.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  DEFAULT_PROBE_THRESHOLDS, PROBE_STATE_KEY, PROBE_VERDICT_VERSION, parseProbeVerdict,
} = await import('../src/providers/crawl-site-probe.js');
import type { ProbeVerdict } from '../src/providers/crawl-site-probe.js';

const verdictValido = (over: Partial<ProbeVerdict> = {}): ProbeVerdict => ({
  v: PROBE_VERDICT_VERSION, site: 'vacatorrent', verdict: 'go', at: 1_700_000_000_000, sample: 40,
  counts: {
    sample: 40, valid: 40, pageErrors: 0, siteLevel: 0, noTorrent: 6, buttonNoMagnet: 4,
    withRelease: 30, magnets: 30, identified: 25, noWork: 5, tmdbDown: 0, requests: 40,
  },
  rates: { valid: 1, magnet: 0.882, identify: 0.833, magnetsPerPage: 0.882 },
  bounds: { valid: 0.912, magnet: 0.734, identify: 0.664 },
  denominators: { sample: 40, buttonPages: 34, identifyAnswered: 30, validPages: 40 },
  thresholds: DEFAULT_PROBE_THRESHOLDS,
  reasons: ['site-fora'], stop: 'amostra-completa', kind: 'movie',
  classes: {
    identificada: 25, 'no-work': 5, 'tmdb-down': 0, 'botao-sem-magnet': 4,
    'sem-botao': 6, 'erro-pagina': 0, 'site-fora': 0,
  },
  cost: {
    requests: 40, requestsPerPage: 1, p95RequestsPerPage: 1, latencyMs: 4000,
    meanLatencyMs: 100, p95LatencyMs: 180, maxLatencyMs: 200, measuredPages: 40,
  },
  ...over,
});

describe('sonda: codec do crawl_state', () => {
  test('round-trip preserva o que o painel e o gate leem, mais o custo e as classes', () => {
    const v = verdictValido();
    const lido = parseProbeVerdict(JSON.stringify(v));
    assert.ok(lido);
    assert.equal(lido.site, v.site);
    assert.equal(lido.verdict, 'go');
    assert.equal(lido.at, v.at);
    assert.equal(lido.sample, 40);
    assert.equal(lido.counts.withRelease, 30);
    assert.equal(lido.counts.noWork, 5);
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
    const velho = JSON.stringify({ ...verdictValido(), v: 1 });
    assert.equal(parseProbeVerdict(velho), null, 'veredito com o denominador antigo não é veredito');
  });

  test('lixo, ausente, versão alheia, `stop` fora e `noWork` faltando: "sem veredito"', () => {
    for (const raw of [null, undefined, '', '   ', 'lixo', '{', '[]', '42', '"go"']) {
      assert.equal(parseProbeVerdict(raw), null, `raw=${String(raw)}`);
    }
    const base = JSON.parse(JSON.stringify(verdictValido())) as Record<string, unknown>;
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
    const base = JSON.parse(JSON.stringify(verdictValido())) as Record<string, unknown>;
    const { classes: _c, cost: _k, ...semCusto } = base;
    const lido = parseProbeVerdict(JSON.stringify(semCusto));
    assert.ok(lido, 'campo de relatório ausente não invalida o veredito');
    assert.equal(lido.classes['no-work'], 0);
    assert.equal(lido.cost.measuredPages, 0, 'zero medido, nunca p95 inventado');
  });
});
