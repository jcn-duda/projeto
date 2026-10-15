// A GRAVAÇÃO do veredito da sonda (Fase 8, 8.3) é a autorização de entrada do
// site na rotação — o único `--write` que libera. O que decide se a rodada
// pode gravar é `probeWriteDrifts`, no módulo puro da fronteira: lista de
// desvios VAZIA é a única condição que escreve em `crawl_state["<site>"]
// ["probe:verdict"]`, e qualquer desvio recusa a gravação dizendo por quê.
//
// A trava do TIPO de página é a que estava furada, e ela é o assunto deste
// arquivo. A política do plano mede 40 páginas de FILME; a trava antiga só
// barrava a rodada `mixed`, então uma rodada PURA de série (`--series`, que
// produz `tv_show`) passava e gravava um GO autorizando o site inteiro —
// medido na população que o motor nem consegue identificar por título. O que
// libera é `kind === 'movie'`; série e mista só em OBSERVAÇÃO (rodada sem
// `--write`, que é o default e não grava nada).
//
// O último teste é ESTRUTURAL de propósito: a decisão mora no módulo puro e a
// CLI só a consulta, então reintroduzir um `kind` solto no entry-point
// reabriria o furo sem nenhum teste de unidade reclamar.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.CACHE_PERSIST = 'false';

const { DEFAULT_PROBE_THRESHOLDS, PROBE_SAMPLE } = await import('../src/providers/crawl-site-probe.js');
const { PROBE_USAGE, probeWriteDrifts } = await import('../src/providers/crawl-site-probe-report.js');

describe('sonda: só a rodada de filme grava o veredito', () => {
  const base = { sample: PROBE_SAMPLE, thresholds: DEFAULT_PROBE_THRESHOLDS };
  const cli = () => fileURLToPath(new URL('../scripts/crawl-site-probe.js', import.meta.url));

  test('filme com amostra 40 e limiar padrão não tem desvio; série e mista têm', () => {
    assert.deepEqual(probeWriteDrifts({ ...base, kind: 'movie' }), [], 'a política do plano libera o filme');
    for (const kind of ['tv_show', 'mixed'] as const) {
      const drifts = probeWriteDrifts({ ...base, kind });
      assert.equal(drifts.length, 1, `${kind}: um desvio só, e ele é o tipo de página`);
      assert.match(drifts[0], /autorizacao e por tipo de pagina/, kind);
    }
  });

  test('a trava do tipo não relaxou amostra nem limiar', () => {
    assert.match(probeWriteDrifts({ ...base, kind: 'movie', sample: 8 })[0], /amostra 8 != 40/);
    assert.match(
      probeWriteDrifts({ kind: 'movie', sample: PROBE_SAMPLE, thresholds: { ...DEFAULT_PROBE_THRESHOLDS, magnetRate: 0.1 } })[0],
      /magnetRate=0.1/,
    );
    // Os desvios se SOMAM: lista vazia é a única condição que grava.
    assert.equal(
      probeWriteDrifts({ kind: 'tv_show', sample: 8, thresholds: { ...DEFAULT_PROBE_THRESHOLDS, magnetRate: 0.1 } }).length,
      3,
    );
  });

  test('a CLI usa a trava compartilhada (não existe `mixed` solto no entry-point)', () => {
    const src = fs.readFileSync(cli(), 'utf8');
    assert.match(src, /probeWriteDrifts\(\{/, 'a gravação é decidida pelo módulo puro');
    assert.doesNotMatch(src, /kind === 'mixed'/, 'a trava de rodada mista solta é o defeito');
    assert.match(src, /kind !== 'movie'/, 'a nota do relatório cobre a série pura também');
    assert.match(PROBE_USAGE, /SO FILME/, 'o uso diz o que libera');
  });
});
