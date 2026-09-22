/**
 * Probe Jev dub-lie (ETAPA 2) — prova local SEM REDE do núcleo:
 *   1. corpus válido e assimétrico (viés honesto, famílias, claim
 *      explícito de áudio em todo lie, rejeição de BTIH 40-hex);
 *   2. allowlist do payload (só post_title, indexer, video_files);
 *   3. fingerprint estável de pergunta+corpus;
 *   4. plano de fan-out (batching sem perda/duplicação);
 *   5. métricas puras (matriz, latência, custo, render defensivo);
 *   6. cliente: attempts reais, auth com concorrência, onRow que lança,
 *      threshold default seguro, timeout — tudo com fetchImpl injetado.
 *
 * Os testes de CLI/spawn (exit codes, --flag=value) estão em
 * jev-dub-lie-probe-cli.test.ts. Os módulos do probe são `.mjs` de
 * fonte, então o import é DINÂMICO com URL resolvida da raiz do repo —
 * o mesmo padrão do helper do cliente ESM: o import estático puxaria o
 * `.mjs` para o programa do tsc ou quebraria o caminho em `dist/test`.
 * Nenhuma função daqui abre socket: rede é só injetada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('raiz do repo não encontrada a partir do teste');
}

const ROOT = repoRoot();
const load = (name: string): Promise<any> =>
  import(pathToFileURL(join(ROOT, 'scripts', name)).href);

const casesMod = await load('jev-dub-lie-cases.mjs');
const payloadMod = await load('jev-dub-lie-payload.mjs');
const metricsMod = await load('jev-dub-lie-metrics.mjs');
const clientMod = await load('jev-dub-lie-client.mjs');

const CASES: any[] = casesMod.CASES;

/** Response-like mínimo que o cliente do probe consome. */
function fakeRes(status: number, body: any, retryAfter?: string): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
    text: async () => JSON.stringify(body),
  };
}

const okBody = (noul: number, usage?: any) => ({
  answers: { is_dub_lie: { noul } },
  ...(usage ? { usage } : {}),
});

const baseCase = (over: any) => ({
  id: 'x', group: 'g', expectLie: true, post: 'Filme Dublado 1080p', indexer: 'i', files: ['a.mkv'], ...over,
});

test('corpus: contratos, famílias, viés honesto e claim explícito', () => {
  assert.deepEqual(payloadMod.validateCorpus(CASES), []);
  const ids = new Set(CASES.map((c: any) => c.id));
  assert.equal(ids.size, CASES.length);
  assert.ok(CASES.length >= 30, `corpus ampliado: ${CASES.length} casos`);
  const lies = CASES.filter((c: any) => c.expectLie === true).length;
  const honest = CASES.length - lies;
  assert.ok(lies > 0 && honest > 0, 'os dois lados presentes');
  // Assimetria documentada: viés HONESTO (falso positivo é o erro caro).
  assert.ok(honest > lies, `honest=${honest} deve superar lie=${lies}`);
  const groups = new Set(CASES.map((c: any) => c.group));
  for (const required of [
    'cena-en', 'idioma-nomeado', 'cirilico-rus', 'pack', 'promo', 'legenda', 'pt-context', 'ano',
  ]) {
    assert.ok(groups.has(required), `família exigida ausente: ${required}`);
  }
  for (const g of ['idioma-nomeado', 'cirilico-rus', 'promo', 'pack', 'legenda', 'ano']) {
    const inGroup = CASES.filter((c: any) => c.group === g);
    assert.ok(inGroup.some((c: any) => c.expectLie), `${g}: sem lie`);
    assert.ok(inGroup.some((c: any) => !c.expectLie), `${g}: sem honesto`);
  }
  // Todo lie carrega claim EXPLÍCITO de áudio PT — "BR" solto é ambíguo
  // (região/lote) e não pode ser a base de nenhuma acusação.
  const claimExplicito = /dublado|dublada|dual\s*(á|a)udio|pt-br|dub\b/i;
  for (const c of CASES.filter((x: any) => x.expectLie)) {
    assert.match(c.post, claimExplicito, `${c.id}: lie sem claim explícito de dub`);
  }
  const metcon = CASES.find((c: any) => c.id === 'lie-metcon');
  assert.match(metcon.post, /dublado/i, 'lie-metcon não pode depender de "BR" ambíguo');
});

test('validateCorpus: reprova campo estranho, id duplicado e BTIH 40-hex', () => {
  const extra = payloadMod.validateCorpus([{ ...baseCase({ magnet: 'magnet:?xt=urn:btih:abc' }) }]);
  assert.ok(extra.some((e: string) => /campo fora do contrato/.test(e)));
  const dup = payloadMod.validateCorpus([baseCase({}), baseCase({ post: 'Outro Dublado' })]);
  assert.ok(dup.some((e: string) => /duplicado/.test(e)));
  const btih = payloadMod.validateCorpus([baseCase({ post: `Filme Dublado ${'a'.repeat(40)}` })]);
  assert.ok(btih.some((e: string) => /proibido/.test(e)), 'BTIH 40-hex solto é rejeitado');
  // Fronteira: 39 e 41 hex NÃO são hash BTIH solto.
  assert.deepEqual(
    payloadMod.validateCorpus([baseCase({ post: `Filme ${'a'.repeat(39)}` })]),
    [],
  );
  assert.deepEqual(
    payloadMod.validateCorpus([baseCase({ post: `Filme ${'a'.repeat(41)}` })]),
    [],
  );
});

test('allowlist: estado só com post_title, indexer e video_files', () => {
  for (const c of CASES) {
    const state = payloadMod.buildState(c);
    assert.deepEqual(Object.keys(state).sort(), ['indexer', 'post_title', 'video_files']);
    assert.equal(state.post_title, c.post);
    assert.equal(state.indexer, c.indexer);
    assert.deepEqual(state.video_files, c.files);
    const wire = JSON.stringify(state);
    assert.ok(!/magnet|xt=urn:btih|apikey|bearer|sig=/i.test(wire), `payload sujo em ${c.id}`);
  }
  // Caso contaminado de propósito: campos extra NUNCA atravessam.
  const dirty = payloadMod.buildState({
    post: 'X', indexer: 'y', files: ['x.mkv'],
    magnet: 'magnet:?xt=urn:btih:abc', hash: 'f'.repeat(40), apiKey: 'sk-z', sig: 's', config: { a: 1 },
  });
  assert.deepEqual(Object.keys(dirty).sort(), ['indexer', 'post_title', 'video_files']);
});

test('fingerprint: estável, sensível e curto', () => {
  const a = payloadMod.corpusFingerprint(CASES);
  assert.equal(a.sha256, payloadMod.corpusFingerprint(CASES).sha256);
  assert.match(a.short, /^[0-9a-f]{12}$/);
  const mutated = payloadMod.corpusFingerprint(
    CASES.map((c: any, i: number) => (i === 0 ? { ...c, post: c.post + '!' } : c)),
  );
  assert.notEqual(mutated.sha256, a.sha256);
  const otherQuestion = payloadMod.corpusFingerprint(CASES, {
    questions: { is_dub_lie: { ...payloadMod.QUESTIONS.is_dub_lie } },
    promptVersion: 'outra-versao',
  });
  assert.notEqual(otherQuestion.sha256, a.sha256);
});

test('planBatches: divide sem perder, duplicar ou reordenar', () => {
  const batches = payloadMod.planBatches(CASES, 7);
  assert.equal(batches.length, Math.ceil(CASES.length / 7));
  assert.deepEqual(batches.flat().map((c: any) => c.id), CASES.map((c: any) => c.id));
  for (const b of batches.slice(0, -1)) assert.equal(b.length, 7);
  assert.ok(batches[batches.length - 1].length >= 1);
  assert.throws(() => payloadMod.planBatches(CASES, 0));
});

test('métricas puras: matriz, latência, custo e render defensivo', () => {
  assert.equal(metricsMod.classifyRow(true, true), 'tp');
  assert.equal(metricsMod.classifyRow(false, true), 'fp');
  assert.equal(metricsMod.classifyRow(true, false), 'fn');
  assert.equal(metricsMod.classifyRow(false, false), 'tn');
  assert.equal(metricsMod.judge(0.55, 0.55), true);
  assert.equal(metricsMod.judge(0.5499, 0.55), false);
  const lat = metricsMod.latencyStats([10, 20, 30, 40, 100]);
  assert.equal(lat.p50Ms, 30);
  assert.equal(lat.p95Ms, 100);
  assert.equal(metricsMod.latencyStats([]), null);
  assert.equal(metricsMod.estimateCost(1e6, 1e6, 2, 8), 10);
  assert.equal(metricsMod.estimateCost(1000, 1000, 0, 8), null);

  const row = (i: number, expectLie: boolean, noul: number | null, group = 'g') =>
    noul === null
      ? { id: `c${i}`, group, expectLie, error: 'HTTP 500' }
      : {
          id: `c${i}`, group, expectLie, noul, error: null,
          predLie: metricsMod.judge(noul, 0.55),
          kind: metricsMod.classifyRow(expectLie, metricsMod.judge(noul, 0.55)),
          latencyMs: 100 + i, usage: { input: 10, output: 5 },
        };
  const rows = [
    row(1, true, 0.9), row(2, true, 0.2), row(3, false, 0.9), row(4, false, 0.1), row(5, true, null),
  ];
  const s = metricsMod.summarize({ rows, meta: { model: 'jev-latest', threshold: 0.55, corpusSha256: 'a'.repeat(64) } });
  assert.deepEqual(s.matrix, { tp: 1, fp: 1, fn: 1, tn: 1 });
  assert.equal(s.decided, 4);
  assert.equal(s.errors, 1);
  assert.equal(s.accPct, 50);
  assert.deepEqual(s.fpIds, ['c3']);
  assert.deepEqual(s.fnIds, ['c2']);
  assert.equal(s.latency.n, 4);
  assert.equal(s.tokens.input, 40);
  const sCost = metricsMod.summarize({
    rows, meta: { corpusSha256: 'a'.repeat(64), costInputPerM: 2, costOutputPerM: 8 },
  });
  assert.equal(sCost.cost.configured, true);
  const expectedCost = (40 / 1e6) * 2 + (20 / 1e6) * 8;
  assert.ok(Math.abs(sCost.cost.estimatedUsd - expectedCost) < 1e-9);
  const report = metricsMod.renderReport(s);
  assert.ok(report.includes('falsos positivos'));
  assert.ok(report.includes('c2'));
  assert.ok(!report.includes('Bearer'), 'relatório nunca imprime credencial');
  // Render defensivo: resumo vazio/parcial degrada para n/d sem lançar.
  const vazio = metricsMod.renderReport({});
  assert.ok(vazio.includes('n/d'));
  assert.doesNotThrow(() => metricsMod.renderReport(null as any));
});

test('cliente: sucesso, uso e allowlist no wire sem rede', async () => {
  const bodies: any[] = [];
  const fetchImpl = async (_url: any, opts: any) => {
    bodies.push(JSON.parse(opts.body));
    return fakeRes(200, okBody(0.9, { input_tokens: 100, output_tokens: 20 }));
  };
  const rows = await clientMod.runCorpus({
    cases: [CASES[0], CASES[1]], buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    key: 'segredo', endpoint: 'http://inexistente', model: 'jev-latest', threshold: 0.55,
    concurrency: 2, maxAttempts: 1, timeoutMs: 5000, fetchImpl,
  });
  assert.equal(bodies.length, 2);
  for (const b of bodies) {
    assert.deepEqual(Object.keys(b.state).sort(), ['indexer', 'post_title', 'video_files']);
    assert.equal(b.model, 'jev-latest');
  }
  assert.equal(rows[0].kind, 'tp');
  assert.equal(rows[0].usage.input, 100);
  assert.equal(rows[0].attempts, 1);
});

test('cliente: ordem do corpus preservada com término fora de ordem', async () => {
  const first4 = CASES.slice(0, 4);
  const fetchImpl = async (_url: any, opts: any) => {
    const post = JSON.parse(opts.body).state.post_title;
    const i = first4.findIndex((c: any) => c.post === post);
    // O ÚLTIMO da ordem termina primeiro; a linha sai na posição certa.
    await new Promise((r) => setTimeout(r, 5 * (first4.length - i)));
    return fakeRes(200, okBody(i % 2 === 0 ? 0.9 : 0.1));
  };
  const rows = await clientMod.runCorpus({
    cases: first4, buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    key: 'k', endpoint: 'http://x', model: 'm', threshold: 0.55,
    concurrency: 4, maxAttempts: 1, timeoutMs: 5000, fetchImpl,
  });
  assert.deepEqual(rows.map((r: any) => r.id), first4.map((c: any) => c.id));
});

test('cliente: 429 tenta de novo; 5xx esgota com attempts reais', async () => {
  let calls429 = 0;
  const fetch429 = async () => {
    calls429++;
    if (calls429 === 1) return fakeRes(429, { error: 'rate' }, '0.05');
    return fakeRes(200, okBody(0.9));
  };
  const rows = await clientMod.runCorpus({
    cases: [CASES[0]], buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    key: 'k', endpoint: 'http://x', model: 'm', threshold: 0.55,
    concurrency: 1, maxAttempts: 2, timeoutMs: 5000, fetchImpl: fetch429,
  });
  assert.equal(calls429, 2);
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].attempts, 2, 'sucesso após retry reflete as tentativas feitas');
  assert.equal(rows[0].kind, 'tp');

  let calls503 = 0;
  const fetch503 = async () => {
    calls503++;
    return fakeRes(503, { error: 'boom' });
  };
  const rowsErr = await clientMod.runCorpus({
    cases: [CASES[0], CASES[1]], buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    key: 'k', endpoint: 'http://x', model: 'm', threshold: 0.55,
    concurrency: 2, maxAttempts: 2, timeoutMs: 5000, fetchImpl: fetch503,
  });
  assert.equal(calls503, 4, 'fail-open: a corrida NÃO para por 5xx');
  assert.equal(rowsErr[0].error, 'HTTP 503');
  assert.equal(rowsErr[0].attempts, 2, 'attempts é o contador real, não maxAttempts fixo');
});

test('cliente: 401 sequencial — attempts 1 na falha, 0 nos não enviados', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return fakeRes(401, { error: 'bad key' });
  };
  const rows = await clientMod.runCorpus({
    cases: CASES.slice(0, 5), buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    key: 'k', endpoint: 'http://x', model: 'm', threshold: 0.55,
    concurrency: 1, maxAttempts: 2, timeoutMs: 5000, fetchImpl,
  });
  assert.equal(calls, 1, 'auth para SEM retry e SEM novos requests');
  assert.match(rows[0].error, /auth-recusada/);
  assert.equal(rows[0].attempts, 1);
  for (const r of rows.slice(1)) {
    assert.equal(r.error, 'auth-parada');
    assert.equal(r.attempts, 0, 'nunca enviado = zero tentativas');
  }
});

test('cliente: auth com concorrência — em voo concluem, nada novo agenda', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return fakeRes(401, { error: 'bad key' });
  };
  const rows = await clientMod.runCorpus({
    cases: CASES.slice(0, 5), buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    key: 'k', endpoint: 'http://x', model: 'm', threshold: 0.55,
    concurrency: 3, maxAttempts: 2, timeoutMs: 5000, fetchImpl,
  });
  // Os 3 requests já em voo no momento da 1ª observação concluem; os
  // 2 restantes nunca são agendados.
  assert.equal(calls, 3);
  for (const r of rows.slice(0, 3)) {
    assert.match(r.error, /auth-recusada/);
    assert.equal(r.attempts, 1);
  }
  for (const r of rows.slice(3)) {
    assert.equal(r.error, 'auth-parada');
    assert.equal(r.attempts, 0);
  }
});

test('cliente: onRow que lança não derruba a corrida nem repete request', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return fakeRes(200, okBody(0.9));
  };
  let emitted = 0;
  const rows = await clientMod.runCorpus({
    cases: [CASES[0], CASES[1]], buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    key: 'k', endpoint: 'http://x', model: 'm', threshold: 0.55,
    concurrency: 2, maxAttempts: 1, timeoutMs: 5000, fetchImpl,
    onRow: () => {
      emitted++;
      throw new Error('callback quebrado');
    },
  });
  assert.equal(calls, 2, 'nenhum request repetido por causa do callback');
  assert.equal(emitted, 2, 'callback continua sendo chamado');
  assert.equal(rows[0].kind, 'tp');
  assert.equal(rows[1].kind, 'tp');
});

test('cliente: threshold ausente cai em 0.55, nunca em 0', async () => {
  const fetchImpl = async () => fakeRes(200, okBody(0.3));
  const rows = await clientMod.runCorpus({
    cases: [baseCase({ id: 'sem-threshold', expectLie: false })],
    buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    key: 'k', endpoint: 'http://x', model: 'm',
    // threshold AUSENTES de propósito; com default 0 o 0.3 viraria fp.
    concurrency: 1, maxAttempts: 1, timeoutMs: 5000, fetchImpl,
  } as any);
  assert.equal(rows[0].kind, 'tn', 'noul 0.3 com threshold 0.55 absolve o honesto');
});

test('cliente: AbortSignal próprio converte hang em timeout', async () => {
  const fetchImpl = (_url: any, opts: any) =>
    new Promise((_, rej) => {
      opts.signal.addEventListener('abort', () => {
        const e: any = new Error('aborted');
        e.name = 'AbortError';
        rej(e);
      });
    });
  const rows = await clientMod.runCorpus({
    cases: [CASES[0]], buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    key: 'k', endpoint: 'http://x', model: 'm', threshold: 0.55,
    concurrency: 1, maxAttempts: 1, timeoutMs: 50, fetchImpl,
  });
  assert.match(rows[0].error, /timeout após 50ms/);
});
