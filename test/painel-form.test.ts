// Base interativa do /painel - SEM DOM, SEM rede.
// PURO: os controles de form.ts sao funcoes sem estado; chamamos o componente
// e percorremos o VNode (rotulo, atributos e handler).
// SOURCE-REGEX: ConfirmModal/ToastStack/useAction vivem em hook/DOM e sao
// cobrados no fonte .ts, tolerante a formatacao.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Field,
  TextField,
  NumberField,
  SelectField,
  ToggleField,
  Button,
  FormActions,
} from '../src/client/painel/form.js';
import { actionError } from '../src/client/painel/action.js';
import { configFieldId, configRows } from '../src/client/painel/config-model.js';
import {
  getPainelToasts,
  pushPainelToast,
  dismissPainelToast,
  resetPainelToasts,
} from '../src/client/painel/store.js';

const PAINEL_DIR = new URL('../../src/client/painel/', import.meta.url);

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, PAINEL_DIR), 'utf8');
}

interface HostNode {
  type: string;
  props: Record<string, any>;
  children: HostNode[];
  text: string;
}

/** Texto visivel do VNode, expandindo componentes puros (funcao chamada com as
 * props). Strings/numbers somam; qualquer outro objeto vira o texto de seus
 * children. */
function nodeText(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(' ');
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return nodeText(node.type(node.props || {}));
    return nodeText(node.props?.children);
  }
  return '';
}

/** Expande o VNode em arvore de elementos HOST (type string). Componente puro e
 * chamado e o retorno e expandido - e o que permite inspecionar o <input> que
 * nasce dentro de <${Field}>. */
function toHostTree(node: any): HostNode[] {
  if (node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(toHostTree);
  const type = node.type;
  const props = node.props || {};
  if (typeof type === 'function') return toHostTree(type(props));
  if (typeof type === 'string') {
    return [{ type, props, children: toHostTree(props.children), text: nodeText(props.children) }];
  }
  return [];
}

function findByType(nodes: HostNode[], type: string): HostNode[] {
  const out: HostNode[] = [];
  const walk = (list: HostNode[]) => {
    for (const node of list) {
      if (node.type === type) out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function hasClass(node: HostNode, cls: string): boolean {
  return String(node.props.class || '').split(/\s+/).includes(cls);
}

function findByClass(nodes: HostNode[], cls: string): HostNode[] {
  const out: HostNode[] = [];
  const walk = (list: HostNode[]) => {
    for (const node of list) {
      if (hasClass(node, cls)) out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

// ---------------------------------------------------------------------------
// Controles puros
// ---------------------------------------------------------------------------

test('Field: rotulo e dica ficam no mesmo <label> que envolve o controle', () => {
  const tree = toHostTree(Field({ label: 'Teto', hint: 'de 1 a 12', children: 'CONTROLE' }));
  assert.deepEqual(tree.map((n) => n.type), ['label'], 'a raiz e <label>: associacao implicita ao controle');
  const root = tree[0];
  assert.ok(hasClass(root, 'painel-field'));

  const labelSpan = findByClass(tree, 'painel-field-label');
  assert.equal(labelSpan.length, 1, 'exatamente um rotulo textual');
  assert.equal(labelSpan[0].text.trim(), 'Teto');
  assert.ok(root.text.includes('CONTROLE'), 'o controle vive DENTRO do label');

  const hint = findByClass(tree, 'painel-field-hint');
  assert.equal(hint.length, 1);
  assert.equal(hint[0].text.trim(), 'de 1 a 12');

  const semHint = toHostTree(Field({ label: 'So rotulo', children: 'C' }));
  assert.equal(findByClass(semHint, 'painel-field-hint').length, 0, 'sem dica, o span nem e renderizado');
});

test('TextField: input carrega type/value/placeholder/disabled e onInput emite o texto', () => {
  let seen: string | null = null;
  const tree = toHostTree(TextField({
    label: 'Chave',
    value: 'abc',
    onChange: (value) => { seen = value; },
    placeholder: 'cole aqui',
    disabled: true,
  }));
  const inputs = findByType(tree, 'input');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].props.type, 'text', 'default e text');
  assert.equal(inputs[0].props.value, 'abc');
  assert.equal(inputs[0].props.placeholder, 'cole aqui');
  assert.equal(inputs[0].props.disabled, true);
  inputs[0].props.onInput({ target: { value: 'novo' } });
  assert.equal(seen, 'novo');

  // Credencial entra em campo mascarado, nunca em text.
  const pw = findByType(toHostTree(TextField({ label: 'Chave', value: '', type: 'password', onChange: () => {} })), 'input');
  assert.equal(pw[0].props.type, 'password');

  assert.equal(findByClass(tree, 'painel-field-label')[0].text.trim(), 'Chave', 'rotulo associado');
});

test('NumberField: min/max/step passam ao <input> e entrada invalida e ignorada', () => {
  const emitted: number[] = [];
  const tree = toHostTree(NumberField({
    label: 'Teto',
    value: 3,
    onChange: (value) => emitted.push(value),
    min: 1,
    max: 12,
    step: 1,
  }));
  const input = findByType(tree, 'input')[0];
  assert.equal(input.props.type, 'number');
  assert.deepEqual(
    [input.props.min, input.props.max, input.props.step],
    [1, 12, 1],
    'os atributos refletem as props (que o card derivam do schema)',
  );
  assert.equal(input.props.value, 3);

  const onInput = input.props.onInput;
  onInput({ target: { value: '5' } });
  assert.deepEqual(emitted, [5], 'string numerica vira numero');
  onInput({ target: { value: '' } });
  onInput({ target: { value: 'abc' } });
  assert.deepEqual(emitted, [5], 'vazio/NaN nao emitem - 0 silencioso seria escolha falsa');
  onInput({ target: { value: '0' } });
  assert.deepEqual(emitted, [5, 0], '0 e numero finito e passa');
});

test('NumberField: min/max/step espelham o schema da config ao vivo (clamps)', () => {
  const [row] = configRows({
    config: {
      effective: { autoFetchMax: 3 },
      envDefaults: {},
      overriddenKeys: [],
      schema: [{ key: 'autoFetchMax', label: 'Teto', type: 'number', min: 1, max: 12, step: 1 }],
    },
  });
  assert.equal(row.min, 1);
  assert.equal(row.max, 12);
  assert.equal(row.step, 1);

  // O card da config repassa exatamente estes metadados ao controle puro.
  const input = findByType(toHostTree(NumberField({
    label: row.label,
    value: Number(row.value),
    onChange: () => {},
    min: row.min ?? undefined,
    max: row.max ?? undefined,
    step: row.step ?? undefined,
  })), 'input')[0];
  assert.deepEqual([input.props.min, input.props.max, input.props.step], [1, 12, 1]);
});

test('SelectField: cada opcao vira <option> e onChange emite o value', () => {
  let seen = '';
  const tree = toHostTree(SelectField({
    label: 'Grupo',
    value: 'a',
    options: [
      { value: 'a', label: 'Alfa' },
      { value: 'b', label: 'Beta' },
    ],
    onChange: (value) => { seen = value; },
  }));
  const select = findByType(tree, 'select')[0];
  assert.equal(select.props.value, 'a');

  const options = findByType(tree, 'option');
  assert.deepEqual(options.map((o) => o.props.value), ['a', 'b']);
  assert.deepEqual(options.map((o) => o.text.trim()), ['Alfa', 'Beta']);

  select.props.onChange({ target: { value: 'b' } });
  assert.equal(seen, 'b');
  assert.equal(findByClass(tree, 'painel-field-label')[0].text.trim(), 'Grupo');
});

test('ToggleField: checkbox nativo com checked/onChange booleano e rotulo no mesmo <label>', () => {
  const emitted: boolean[] = [];
  const tree = toHostTree(ToggleField({ label: 'Dublado global', checked: true, onChange: (c) => emitted.push(c) }));
  assert.deepEqual(tree.map((n) => n.type), ['label'], 'o <label> envolve o switch (associacao implicita)');

  const input = findByType(tree, 'input')[0];
  assert.equal(input.props.type, 'checkbox', 'checkbox NATIVO: preserva teclado/leitor de tela sem role artificial');
  assert.equal(input.props.checked, true);
  assert.equal(findByClass(tree, 'painel-field-label')[0].text.trim(), 'Dublado global');

  input.props.onChange({ target: { checked: true } });
  input.props.onChange({ target: { checked: false } });
  assert.deepEqual(emitted, [true, false], 'onChange entrega boolean, nao string');

  const noHint = toHostTree(ToggleField({ label: 'X', checked: false, onChange: () => {} }));
  assert.equal(findByClass(noHint, 'painel-field-hint').length, 0);
});

test('todo controle do form associa um <label> com texto ao input/select', () => {
  const cases: Array<[string, any]> = [
    ['TextField', TextField({ label: 'Nome', value: '', onChange: () => {} })],
    ['NumberField', NumberField({ label: 'Numero', value: 0, onChange: () => {} })],
    ['SelectField', SelectField({ label: 'Escolha', value: 'a', options: [{ value: 'a', label: 'A' }], onChange: () => {} })],
    ['ToggleField', ToggleField({ label: 'Ligado', checked: false, onChange: () => {} })],
  ];
  for (const [name, vnode] of cases) {
    const tree = toHostTree(vnode);
    assert.deepEqual(tree.map((n) => n.type), ['label'], name + ': a raiz precisa ser <label>');
    const label = findByClass(tree, 'painel-field-label');
    assert.equal(label.length, 1, name + ': precisa de exatamente um rotulo textual');
    assert.ok(label[0].text.trim().length > 0, name + ': o rotulo nao pode ser vazio');
    assert.equal(
      findByType(tree, 'input').length + findByType(tree, 'select').length,
      1,
      name + ': exatamente um controle dentro do <label>',
    );
  }
});

test('Button: texto acessivel, variantes e estado pendente desabilita o clique', () => {
  const plain = findByType(toHostTree(Button({ children: 'Salvar' })), 'button')[0];
  assert.equal(plain.text.trim(), 'Salvar', 'botao precisa de texto acessivel');
  assert.equal(plain.props.type, 'button');
  assert.equal(plain.props.disabled, false);
  assert.ok(hasClass(plain, 'painel-btn'));

  const danger = findByType(toHostTree(Button({ children: 'Apagar', variant: 'danger' })), 'button')[0];
  assert.ok(hasClass(danger, 'painel-btn-danger'));
  const accent = findByType(toHostTree(Button({ children: 'Aplicar', variant: 'accent' })), 'button')[0];
  assert.ok(hasClass(accent, 'painel-btn-accent'));

  const pending = findByType(toHostTree(Button({ children: 'Aplicar', pending: true })), 'button')[0];
  assert.equal(pending.props.disabled, true, 'pending desabilita sem mudar o texto');
  const disabled = findByType(toHostTree(Button({ children: 'X', disabled: true })), 'button')[0];
  assert.equal(disabled.props.disabled, true);

  const submit = findByType(toHostTree(Button({ children: 'Enviar', type: 'submit' })), 'button')[0];
  assert.equal(submit.props.type, 'submit');
});

test('FormActions: fileira .painel-btn-row contendo os botoes', () => {
  const tree = toHostTree(FormActions({
    children: [Button({ children: 'A' }), Button({ children: 'B', variant: 'danger' })],
  }));
  const row = tree[0];
  assert.equal(row.type, 'div');
  assert.ok(hasClass(row, 'painel-btn-row'));
  assert.deepEqual(findByType(tree, 'button').map((b) => b.text.trim()), ['A', 'B']);
});

test('configFieldId: id deterministico compartilhado pelo card da config e pelo gate', () => {
  assert.equal(configFieldId('autoFetchMax'), 'cfg-field-autoFetchMax');
  assert.equal(configFieldId('a b/c'), 'cfg-field-a-b-c', 'sanitiza para [A-Za-z0-9_-]');
  assert.equal(configFieldId('   '), 'cfg-field-', 'vazio nao quebra o id');

  const configSrc = readSrc('view-config.ts');
  assert.match(configSrc, /id=\$\{configFieldId\(row\.key\)\}/, 'o campo carrega o id do modelo');
  const gateSrc = readSrc('view-gate.ts');
  assert.match(gateSrc, /configFieldId\(d\.key\)/, 'o link do gate aponta para o mesmo id');
});

test('o card de config ao vivo encaminha min/max/step do schema ao NumberField', () => {
  const src = readSrc('view-config.ts');
  assert.match(src, /\$\{NumberField\}/, 'usa o controle puro NumberField');
  assert.match(src, /min=\$\{row\.min \?\? undefined\}/);
  assert.match(src, /max=\$\{row\.max \?\? undefined\}/);
  assert.match(src, /step=\$\{row\.step \?\? undefined\}/);
});

// ---------------------------------------------------------------------------
// Contracts que vivem dentro de hooks/DOM - cobrados no FONTE
// ---------------------------------------------------------------------------

test('ConfirmModal: role=dialog/aria-modal, Esc, clique fora e foco inicial no cancelar', () => {
  const src = readSrc('confirm.ts');
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal="true"/);
  assert.match(src, /aria-labelledby="painel-confirm-title"/, 'o dialogo precisa de nome acessivel');

  // Esc fecha RECUSANDO (nao confirma por teclado).
  assert.match(src, /event\.key === 'Escape'[\s\S]{0,160}?onResolve\(false\)/);
  // So o clique no backdrop (target === currentTarget) cancela; clique no cartao nao.
  assert.match(src, /event\.target === event\.currentTarget[\s\S]{0,120}?onResolve\(false\)/);

  // O foco inicial NUNCA vai para o confirmar: um Enter repetido nao pode
  // disparar a acao destrutiva que o modal existe para segurar.
  assert.match(src, /if \(cancel[\s\S]{0,80}?cancel\.focus\(\)/);
  assert.doesNotMatch(src, /confirmRef/, 'nao existe ref de confirmar para receber foco');
  assert.match(src, /previousFocus/, 'guarda o foco anterior');
  assert.match(src, /previous\.focus\(\)/, 'devolve o foco ao fechar');
});

test('ConfirmModal: Tab/Shift+Tab prendem o foco dentro do cartao (focus trap)', () => {
  const src = readSrc('confirm.ts');
  assert.match(src, /event\.key !== 'Tab'/);
  assert.match(src, /card\.querySelectorAll<HTMLElement>/);
  assert.match(src, /'button, \[href\], input/, 'a lista de focaveis inclui botoes/links/inputs');
  assert.match(src, /event\.shiftKey/, 'distingue Shift+Tab do Tab');
  assert.match(src, /first\.focus\(\)/, 'Tab no ultimo volta ao primeiro');
  assert.match(src, /last\.focus\(\)/, 'Shift+Tab no primeiro vai ao ultimo');
});

test('ToastStack: regiao role=status aria-live=polite e botao de fechar rotulado', () => {
  const src = readSrc('toast.ts');
  const stackTag = src.match(/<div[^>]*painel-toasts[^>]*>/);
  assert.ok(stackTag, 'o stack e um container proprio');
  assert.match(stackTag![0], /role="status"/);
  assert.match(stackTag![0], /aria-live="polite"/);
  assert.match(src, /aria-label="Fechar aviso"/, 'o botao de fechar precisa de nome acessivel');
  assert.match(src, /TOAST_TTL_MS = 4000/);
});

test('store de toasts: fila com teto e dismiss por id (fonte do ToastStack)', () => {
  resetPainelToasts();
  const ids = [1, 2, 3, 4, 5].map((n) => pushPainelToast('t' + n, 'ok'));
  assert.equal(getPainelToasts().length, 4, 'TOAST_MAX=4');
  assert.deepEqual(getPainelToasts().map((t) => t.text), ['t2', 't3', 't4', 't5']);

  dismissPainelToast(ids[0]);
  assert.equal(getPainelToasts().length, 4, 'id ja despejado nao altera a fila');
  dismissPainelToast(ids[4]);
  assert.equal(getPainelToasts().length, 3);
  resetPainelToasts();
});

test('useAction: trava de reentrada por ref e confirm:true injetado nas destrutivas', () => {
  const src = readSrc('action.ts');
  // Trava em ref (nao estado): dois cliques no mesmo frame nao passam. A espera
  // do modal tambem e coberta - senao duas confirmacoes abririam para a mesma acao.
  assert.match(src, /if\s*\(\s*busy\.current\s*\)\s*return\s*\{\s*ok:\s*false,\s*aborted:\s*true\s*\}/);
  assert.match(src, /busy\.current\s*=\s*true/);
  assert.match(src, /busy\.current\s*=\s*false/, 'a trava e liberada no finally');

  // Destrutivas: aprovado o modal, o corpo recebe `confirm: true` (o backend
  // exige isso nas DESTRUCTIVE_ACTIONS).
  assert.match(src, /request\.confirm[\s\S]{0,160}?confirm:\s*true/);
  assert.match(src, /if\s*\(\s*!approved\s*\)\s*return\s*\{\s*ok:\s*false,\s*aborted:\s*true\s*\}/, 'cancelar aborta sem POST');
  assert.match(src, /confirm\?:\s*string\s*\|\s*ConfirmOptions/, 'aceita mensagem ou objeto do modal');
});

test('actionError: null em ok/abortado, mensagem quando a acao falha', () => {
  assert.equal(actionError({ ok: true, data: {} }), null);
  assert.equal(actionError({ ok: false, aborted: true }), null);
  assert.equal(actionError({ ok: false, status: 400, error: 'campo invalido' }), 'campo invalido');
});

test('nenhum botao sem rotulo acessivel e nada de window.confirm na base interativa', () => {
  for (const file of ['form.ts', 'confirm.ts', 'toast.ts', 'view-config.ts', 'view-diagnostico.ts']) {
    const src = readSrc(file);
    assert.doesNotMatch(src, /<button[^>]*>\s*<\/button>/, file + ': botao sem texto/nome acessivel');
    assert.doesNotMatch(src, /window\.confirm\(/, file + ': a confirmacao e o modal do ConfirmModal');
  }
  // Conteudo puramente simbolico (o x do toast) carrega nome acessivel.
  assert.match(readSrc('toast.ts'), /aria-label=/);
});