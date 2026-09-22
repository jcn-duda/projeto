/**
 * Probe Jev audio-classify (ETAPA 3) — prova local SEM REDE:
 *   1. corpus válido, famílias, ids únicos, rejeição de BTIH 40-hex;
 *   2. allowlist do payload (só post_title — nada de indexer/arquivo);
 *   3. fingerprint estável de pergunta+corpus;
 *   4. cliente compartilhado (jev-dub-lie-client.mjs) com questionId
 *      próprio (is_ptbr_dub) — as demais garantias de retry/auth/timeout/
 *      concorrência já são provadas por jev-dub-lie-probe.test.ts contra
 *      o MESMO módulo; aqui só se prova que o questionId troca a leitura.
 *
 * Os testes de CLI/spawn estão em jev-audio-classify-probe-cli.test.ts.
 * Import dinâmico com URL resolvida da raiz do repo — mesmo padrão do
 * probe dub-lie: os módulos são `.mjs` de fonte, import estático
 * quebraria o caminho em dist/test.
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

const casesMod = await load('jev-audio-classify-cases.mjs');
const payloadMod = await load('jev-audio-classify-payload.mjs');
const clientMod = await load('jev-dub-lie-client.mjs');

const CASES: any[] = casesMod.CASES;

function fakeRes(status: number, body: any): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

const okBody = (noul: number) => ({ answers: { is_ptbr_dub: { noul } } });

test('corpus: contratos, famílias e os dois lados presentes', () => {
  assert.deepEqual(payloadMod.validateCorpus(CASES), []);
  const ids = new Set(CASES.map((c: any) => c.id));
  assert.equal(ids.size, CASES.length);
  assert.ok(CASES.length >= 25, `corpus: ${CASES.length} casos`);
  const ptbr = CASES.filter((c: any) => c.expectPtBr === true).length;
  const other = CASES.length - ptbr;
  assert.ok(ptbr > 0 && other > 0, 'os dois lados presentes');
  const groups = new Set(CASES.map((c: any) => c.group));
  for (const required of ['cena-en', 'idioma-nomeado', 'cirilico-rus', 'rutracker', 'legenda', 'pt-context']) {
    assert.ok(groups.has(required), `família exigida ausente: ${required}`);
  }
  // Famílias de guarda precisam ter os dois lados: caso desmentido pelo
  // idioma estrangeiro E caso onde o PT explícito vence de volta.
  for (const g of ['idioma-nomeado', 'cirilico-rus', 'rutracker', 'cena-en']) {
    const inGroup = CASES.filter((c: any) => c.group === g);
    assert.ok(inGroup.some((c: any) => c.expectPtBr), `${g}: sem caso ptbr`);
    assert.ok(inGroup.some((c: any) => !c.expectPtBr), `${g}: sem caso other`);
  }
});

test('validateCorpus: reprova campo estranho, id duplicado e BTIH 40-hex', () => {
  const base = (over: any) => ({ id: 'x', group: 'g', expectPtBr: true, title: 'Filme Dublado 1080p', ...over });
  const extra = payloadMod.validateCorpus([base({ indexer: 'nao-permitido' })]);
  assert.ok(extra.some((e: string) => /campo fora do contrato/.test(e)));
  const dup = payloadMod.validateCorpus([base({}), base({ title: 'Outro Dublado' })]);
  assert.ok(dup.some((e: string) => /duplicado/.test(e)));
  const btih = payloadMod.validateCorpus([base({ title: `Filme Dublado ${'a'.repeat(40)}` })]);
  assert.ok(btih.some((e: string) => /proibido/.test(e)), 'BTIH 40-hex solto é rejeitado');
});

test('allowlist: estado só com post_title', () => {
  for (const c of CASES) {
    const state = payloadMod.buildState(c);
    assert.deepEqual(Object.keys(state), ['post_title']);
    assert.equal(state.post_title, c.title);
    assert.ok(!/magnet|xt=urn:btih|apikey|bearer|sig=/i.test(JSON.stringify(state)), `payload sujo em ${c.id}`);
  }
  const dirty = payloadMod.buildState({
    title: 'X', indexer: 'y', files: ['x.mkv'], magnet: 'magnet:?xt=urn:btih:abc',
  });
  assert.deepEqual(Object.keys(dirty), ['post_title']);
});

test('fingerprint: estável e sensível ao corpus', () => {
  const a = payloadMod.corpusFingerprint(CASES);
  assert.equal(a.sha256, payloadMod.corpusFingerprint(CASES).sha256);
  assert.match(a.short, /^[0-9a-f]{12}$/);
  const mutated = payloadMod.corpusFingerprint(
    CASES.map((c: any, i: number) => (i === 0 ? { ...c, title: c.title + '!' } : c)),
  );
  assert.notEqual(mutated.sha256, a.sha256);
});

test('cliente: questionId próprio lê answers.is_ptbr_dub (não is_dub_lie)', async () => {
  const bodies: any[] = [];
  const fetchImpl = async (_url: any, opts: any) => {
    bodies.push(JSON.parse(opts.body));
    return fakeRes(200, okBody(0.9));
  };
  const casesForClient = [CASES[0], CASES[1]].map((c) => ({ ...c, expectLie: c.expectPtBr }));
  const rows = await clientMod.runCorpus({
    cases: casesForClient, buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    questionId: 'is_ptbr_dub',
    key: 'segredo', endpoint: 'http://inexistente', model: 'jev-latest', threshold: 0.55,
    concurrency: 2, maxAttempts: 1, timeoutMs: 5000, fetchImpl,
  });
  assert.equal(bodies.length, 2);
  for (const b of bodies) assert.deepEqual(Object.keys(b.state), ['post_title']);
  assert.equal(rows[0].noul, 0.9);
  assert.equal(rows[0].kind, casesForClient[0].expectLie ? 'tp' : 'fp');
});

test('cliente: resposta com is_dub_lie (chave errada) não é lida sem o questionId certo', async () => {
  // Prova negativa do parâmetro: sem passar questionId, o default
  // continua sendo is_dub_lie — a resposta deste probe (is_ptbr_dub) não
  // seria encontrada, e o caso vira erro em vez de silenciosamente
  // interpretar o campo errado.
  const fetchImpl = async () => fakeRes(200, okBody(0.9));
  const casesForClient = [{ ...CASES[0], expectLie: CASES[0].expectPtBr }];
  const rows = await clientMod.runCorpus({
    cases: casesForClient, buildState: payloadMod.buildState, questions: payloadMod.QUESTIONS,
    // questionId OMITIDO de propósito.
    key: 'k', endpoint: 'http://x', model: 'm', threshold: 0.55,
    concurrency: 1, maxAttempts: 1, timeoutMs: 5000, fetchImpl,
  });
  assert.match(rows[0].error, /resposta sem noul numérico/);
});
