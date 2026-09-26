import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canApplyDedup,
  catalogSummary,
  catalogBucketRows,
  dedupPreviewSummary,
  limpezaHeader,
  CATALOG_BUCKETS,
  bucketLabel,
} from '../src/client/painel/view-limpeza.js';
import { dedupTableRows, dedupGroupViews } from '../src/client/painel/limpeza-model.js';

test('limpezaHeader resume prévia e conta via contaView', () => {
  // Nunca rodou: idle, sem alvos, conta real do bloco `conta` com ok:true.
  const idle = limpezaHeader(null, { ok: true, service: 'alldebrid', total: 933, cap: 1000, ready: 895, dead: 3 });
  assert.equal(idle.previewState, 'idle');
  assert.equal(idle.duplicates, 0);
  assert.equal(idle.accountService, 'alldebrid');
  assert.equal(idle.accountTotal, 933);
  assert.equal(idle.accountCap, 1000);
  assert.equal(idle.accountReady, 895);
  assert.equal(idle.accountDead, 3);

  // Rodou e não há o que remover: empty (estado vazio útil, não “idle”).
  const empty = limpezaHeader({ t1Groups: 0, t2Groups: 0, candidates: [], t1: [], t2: [] }, null);
  assert.equal(empty.previewState, 'empty');
  assert.equal(empty.duplicates, 0);
  assert.equal(empty.accountService, '', 'sem conta não inventa serviço');

  // Rodou com alvos: ready e a contagem de kills.
  const ready = limpezaHeader({ t1Groups: 1, t2Groups: 2, candidates: [{}, {}, {}], t1: [{}], t2: [{}, {}] }, undefined);
  assert.equal(ready.previewState, 'ready');
  assert.equal(ready.duplicates, 3);
  assert.equal(ready.t1Groups, 1);
  assert.equal(ready.t2Groups, 2);
  assert.equal(ready.accountCap, 1000, 'cap ausente cai no padrão (1000) via contaView');
});

test('catalogBucketRows cobre os quatro baldes com rótulo e zeros preenchidos', () => {
  const rows = catalogBucketRows(catalogSummary({
    ok: true,
    report: { byBucket: { dub: { count: 60, bytes: 100 }, lixo: { count: 2, bytes: 4 } } },
  }));
  assert.deepEqual(rows.map((r) => r.key), CATALOG_BUCKETS);
  assert.equal(rows[0].label, 'Dublado');
  assert.equal(rows[0].count, 60);
  assert.equal(rows[0].bytes, 100);
  assert.equal(rows[1].label, 'Dual');
  assert.equal(rows[1].count, 0, 'balde ausente entra zerado');
  assert.equal(rows[3].label, 'Lixo / indefinido');
  assert.equal(rows[3].count, 2);
  assert.equal(bucketLabel('pt'), 'Português');
  assert.equal(bucketLabel('desconhecido'), 'desconhecido', 'balde fora da lista não desaparece');
});

test('dedupTableRows normaliza o kill real (filename/tamanho/hash e sobrevivente)', () => {
  const rows = dedupTableRows([
    { hash: 'abcdef1234567890', filename: 'Devoradores 2026.mkv', size: 3357116179, group: 'T2 (mesmo arquivo)', keep: { hash: 'ffffffffffffffff' } },
    { serviceId: 7, group: 'T1 (mesmo hash)', keep: { serviceId: 9 } },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hashShort, 'abcdef12');
  assert.equal(rows[0].filename, 'Devoradores 2026.mkv');
  assert.equal(rows[0].sizeBytes, 3357116179);
  assert.equal(rows[0].group, 'T2 (mesmo arquivo)');
  assert.equal(rows[0].keepShort, 'ffffffff');
  assert.equal(rows[1].filename, '—', 'filename ausente não some a linha');
  assert.equal(rows[1].hashShort, '—');
  assert.equal(rows[1].keepShort, '#9', 'sem hash no keep, cai para o serviceId');
  assert.deepEqual(dedupTableRows(null), []);
});

test('canApplyDedup só libera a ação destrutiva com prévia não vazia', () => {
  assert.equal(canApplyDedup(null), false);
  assert.equal(canApplyDedup(undefined), false);
  assert.equal(canApplyDedup({ t1Groups: 0, t2Groups: 0, candidates: [], t1: [], t2: [] }), false, 'zero alvos não habilita');
  assert.equal(canApplyDedup({ t1Groups: 1, t2Groups: 0, candidates: [{ hash: 'a' }], t1: [{ keep: {}, kill: [{}] }], t2: [] }), true);
});

test('dedupPreviewSummary inclui o hint do backend no motivo da falha', () => {
  const comHint = dedupPreviewSummary({ ok: false, reason: 'inventario-frio', hint: 'rode a varredura antes' });
  assert.equal(comHint.ok, false);
  assert.match(String(comHint.reason), /inventario-frio/);
  assert.match(String(comHint.reason), /rode a varredura antes/, 'o conserto precisa viajar junto do motivo');
  assert.equal(dedupPreviewSummary({ ok: false, reason: 'sem-adapter' }).reason, 'sem-adapter', 'sem hint, só o motivo');
});

test('ViewLimpeza agrupa ações por risco e centraliza confirmação no useAction/useConfirm', () => {
  const src = readFileSync(new URL('../../src/client/painel/view-limpeza.ts', import.meta.url), 'utf8');
  // Resumo operacional + separação leitura × destrutivo no markup.
  assert.match(src, /painel-summary-bar/);
  assert.match(src, /painel-action-group-danger/);
  assert.match(src, /NÃO DESTRUTIVO/);
  assert.match(src, /IRREVERSÍVEL/);
  // A habilitação do aplicar sai do helper testado acima, não de condição inline.
  assert.match(src, /canApplyDedup\(previewResult\)/);
  // Trocar de conta zera a prévia (plano era da credencial anterior) antes de recarregar.
  assert.match(src, /subscribePainelToken\(\(\) => \{[\s\S]*?setPreviewResult\(null\)[\s\S]*?refreshCatalog\(true\)/);
  // Feedback e estado ocupado são anunciados a leitores de tela.
  assert.match(src, /role="status" aria-live="polite"/);
  // Contratos de backend preservados: a LEITURA do catálogo vai por postAction
  // direto; as ações passam pelo useAction (que usa o useConfirm do modal).
  assert.match(src, /postAction\(token, 'catalog-report'/, 'a leitura do catálogo é preservada');
  assert.match(src, /useAction\(\)/, 'as ações usam o executor central');
  for (const action of ['sweep-dead', 'dedup-preview', 'dedup-apply']) {
    assert.match(src, new RegExp(`action: '${action}'`), action + ' preservado');
  }
  // Destrutivas continuam exigindo confirmação — pelo modal real, nunca window.confirm.
  assert.doesNotMatch(src, /window\.confirm\(/, 'nada de window.confirm no painel');
  assert.ok((src.match(/confirm:\s*\{/g) || []).length >= 2, 'as destrutivas carregam bloco de confirmação');
  // Todos os botões têm rótulo legível (nenhum vazio).
  assert.doesNotMatch(src, /<button[^>]*>\s*<\/button>/);
});

test('dedupGroupViews: critério legível, o que fica/sai e espaço liberado, maior primeiro', () => {
  const plan = {
    t1Groups: 1, t2Groups: 1, candidates: [], bytesFreed: 0,
    t1: [{ keep: { hash: 'a'.repeat(40), filename: 'Filme A.mkv', size: 100 }, kill: [{ filename: 'Filme A.mkv', size: 100 }] }],
    t2: [{ keep: { serviceId: 7, filename: 'Filme B 1080p.mkv', size: 3000 }, kill: [{ filename: 'Filme.B.1080p.mkv', size: 3010 }, { size: 2990 }] }],
  };
  const groups = (dedupGroupViews as any)(plan);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].kind, 'T2', 'o grupo que libera mais vem primeiro');
  assert.equal(groups[0].bytesFreed, 6000);
  assert.match(groups[0].criterion, /nome/);
  assert.equal(groups[0].keep.ref, '#7', 'sem hash, o sobrevivente é citado pelo id');
  assert.equal(groups[0].kills[1].name, '—', 'kill sem nome não some da lista');
  assert.equal(groups[1].keep.ref, 'aaaaaaaa');
  assert.match(groups[1].criterion, /hash/);
  assert.deepEqual((dedupGroupViews as any)(null), []);
});

test('dedupPreviewSummary e limpezaHeader somam o espaço que a deduplicação libera', () => {
  const preview = dedupPreviewSummary({ ok: true, plan: { t1: [], t2: [{ keep: {}, kill: [{ size: 1500 }, { size: 500 }] }] } });
  assert.equal(preview.bytesFreed, 2000);
  assert.equal(limpezaHeader(preview, null).bytesFreed, 2000);
  assert.equal(dedupPreviewSummary({ ok: false, reason: 'x' }).bytesFreed, 0);
});

test('ViewLimpeza calcula a prévia sozinha ao abrir (leitura pura, sem toast)', () => {
  const src = readFileSync(new URL('../../src/client/painel/view-limpeza.ts', import.meta.url), 'utf8');
  assert.match(src, /postAction\(token, 'dedup-preview'\)/, 'prévia silenciosa por postAction direto');
  assert.match(src, /useEffect\(\(\) => \{\s*refreshCatalog\(true\);\s*void refreshPreview\(\);/);
  assert.match(src, /dedupGroupViews\(plan\)/);
});
