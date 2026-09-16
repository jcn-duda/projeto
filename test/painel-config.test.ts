// Modelo puro da configuracao AO VIVO (Chupim/Colhedor) - sem DOM, sem rede.
// Contratos cobertos: diff so do delta, validacao pelos clamps/type do schema,
// ausencia preservada (nunca vira envDefault/0/false) e linhas derivadas do
// schema (nao de lista hardcoded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configSnapshot,
  configRows,
  configRowsFromSnapshot,
  configFormSeed,
  configSchema,
  configGroups,
  configDiff,
  validateConfigForm,
} from '../src/client/painel/config-model.js';

test('configSnapshot aceita o corpo inteiro e normaliza os ausentes', () => {
  const snapshot = configSnapshot({
    ok: true,
    action: 'autofetch-config-get',
    config: {
      effective: { autoFetchMax: 3 },
      envDefaults: { autoFetchMax: 3, autoFetchAnyDubbed: true },
      overriddenKeys: ['autoFetchMax', 7],
      paused: true,
      pausedSince: 1700000000000,
      schema: [{ key: 'autoFetchMax', label: 'Teto', type: 'number', min: 1, max: 12 }],
    },
  });
  assert.ok(snapshot, 'payload com config precisa virar snapshot');
  assert.deepEqual(snapshot.effective, { autoFetchMax: 3 });
  assert.deepEqual(snapshot.envDefaults, { autoFetchMax: 3, autoFetchAnyDubbed: true });
  assert.deepEqual(snapshot.overriddenKeys, ['autoFetchMax', '7'], 'chave nao-string vira string');
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.pausedSince, 1700000000000);
  assert.equal(snapshot.schema.length, 1);

  assert.equal(configSnapshot(null), null, 'sem objeto, sem snapshot');
  assert.equal(configSnapshot(undefined), null);

  // paused nao-booleano e pausedSince nao-numerico nao inventam valor.
  const loose = configSnapshot({ config: { paused: 'sim', pausedSince: 'ontem' } });
  assert.ok(loose);
  assert.equal(loose.paused, undefined);
  assert.equal(loose.pausedSince, null);
  assert.deepEqual(loose.schema, [], 'schema ausente vira lista vazia');
});

test('configRows deriva do schema em vez de lista hardcoded e preserva a ordem', () => {
  // Chaves inventadas de proposito: se a lista fosse hardcoded, nada apareceria.
  const rows = configRows({
    config: {
      effective: { mExtra: 1, zKnob: 5 },
      envDefaults: { bExtra: 2 },
      overriddenKeys: ['zKnob', 'qExtra'],
      schema: [
        { key: 'zKnob', label: 'Knob Z', type: 'number', group: 'G1' },
        { key: 'aKnob', label: 'Knob A', type: 'boolean', group: 'G1' },
      ],
    },
  });

  assert.deepEqual(rows.map((r) => r.key), ['zKnob', 'aKnob', 'bExtra', 'mExtra', 'qExtra'],
    'schema primeiro (na ordem), drift depois em ordem alfabetica');

  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey.zKnob.inSchema, true);
  assert.equal(byKey.zKnob.label, 'Knob Z');
  assert.equal(byKey.zKnob.type, 'number');
  assert.equal(byKey.zKnob.overridden, true);
  assert.equal(byKey.zKnob.hasValue, true);
  assert.equal(byKey.zKnob.value, 5);

  assert.equal(byKey.aKnob.inSchema, true);
  assert.equal(byKey.aKnob.hasValue, false, 'campo do schema sem effective continua ausente');
  assert.equal(byKey.aKnob.value, undefined);

  assert.equal(byKey.qExtra.inSchema, false, 'chave fora do schema vira linha de drift');
  assert.equal(byKey.qExtra.label, 'qExtra');
  assert.equal(byKey.qExtra.type, 'unknown');
  assert.equal(byKey.qExtra.overridden, true);
  assert.equal(byKey.bExtra.hasEnvDefault, true);
  assert.equal(byKey.bExtra.envDefault, 2);
  assert.equal(byKey.bExtra.hasValue, false);
});

test('campo ausente permanece ausente - nao vira envDefault, 0 nem false', () => {
  const rows = configRowsFromSnapshot({
    effective: {},
    envDefaults: { novo: 7 },
    overriddenKeys: [],
    schema: [{ key: 'novo', label: 'Novo', type: 'number' }],
  });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.hasValue, false);
  assert.equal(row.value, undefined, 'sem effective nao ha valor');
  assert.equal(row.hasEnvDefault, true);
  assert.equal(row.envDefault, 7, 'envDefault e declarado separado do valor');

  // E o seed do formulario NAO rebatiza o default do operador como escolha.
  assert.deepEqual(configFormSeed(rows), {});
  assert.deepEqual(configFormSeed(null), {});

  const seed = configFormSeed(rows.concat(configRows({
    config: { effective: { ligado: true }, schema: [{ key: 'ligado', label: 'Ligado', type: 'boolean' }] },
  })));
  assert.deepEqual(seed, { ligado: true }, 'so effective entra no seed');
});

test('configSchema declara so o schema, sem linhas sinteticas de drift', () => {
  const fields = configSchema({
    config: {
      effective: { fora: 1 },
      envDefaults: { tambemFora: 2 },
      schema: [
        { key: 'k1', label: 'K1', type: 'number' },
        { key: 'k1', label: 'K1 duplicado', type: 'number' },
        { key: 'k2', label: 'K2', type: 'boolean', min: 1, max: 5, unit: 's', envDefault: true },
        { label: 'sem chave', type: 'number' },
      ],
    },
  });
  assert.deepEqual(fields.map((f) => f.key), ['k1', 'k2'], 'dedupe e descarte do campo sem key');
  assert.equal(fields[1].unit, 's');
  assert.equal(fields[1].envDefault, true);
});

test('configGroups agrupa preservando a ordem do schema', () => {
  const rows = configRows({
    config: {
      effective: {},
      envDefaults: {},
      overriddenKeys: [],
      schema: [
        { key: 'a', label: 'A', type: 'number', group: 'G1' },
        { key: 'b', label: 'B', type: 'number', group: 'G2' },
        { key: 'c', label: 'C', type: 'number', group: 'G1' },
        { key: 'd', label: 'D', type: 'number' },
      ],
    },
  });
  const groups = configGroups(rows);
  assert.deepEqual(groups.map((g) => g.group), ['G1', 'G2', null]);
  assert.deepEqual(groups[0].rows.map((r) => r.key), ['a', 'c']);
  assert.deepEqual(groups[1].rows.map((r) => r.key), ['b']);
  assert.deepEqual(groups[2].rows.map((r) => r.key), ['d']);
  assert.deepEqual(configGroups(null), []);
});

test('configDiff devolve so o delta e coerce o par checkbox/input', () => {
  // Referencia booleana: checkbox entrega boolean, string true tambem vale.
  const booleanDiff = configDiff(
    { ligado: true, desligado: 'false' },
    { ligado: false, desligado: false },
  );
  assert.deepEqual(booleanDiff.patch, { ligado: true });
  assert.deepEqual(booleanDiff.changedKeys, ['ligado'], 'desligado ja era false');

  // Referencia numerica: 5 do input nao e mudanca contra 5.
  const numberDiff = configDiff(
    { autoFetchMax: '5', fila: '9' },
    { autoFetchMax: 5, fila: 3 },
  );
  assert.deepEqual(numberDiff.patch, { fila: 9 });
  assert.deepEqual(numberDiff.changedKeys, ['fila']);

  // Chave que nao existe em effective entra no patch (criacao, nao remocao).
  const created = configDiff({ novaChave: 4 }, {});
  assert.deepEqual(created.patch, { novaChave: 4 });
  assert.deepEqual(created.changedKeys, ['novaChave']);

  // Boolean cru invalido contra referencia booleana viaja como veio (o
  // backend recusa); nao e engolido silenciosamente.
  const invalidBool = configDiff({ ligado: 'talvez' }, { ligado: false });
  assert.deepEqual(invalidBool.patch, { ligado: 'talvez' });
});

test('configDiff ignora campo ausente - nem como remocao', () => {
  const diff = configDiff(
    { vazio: '', nulo: null, indefinido: undefined, igual: 5 },
    { vazio: 1, nulo: 2, indefinido: 3, igual: 5 },
  );
  assert.deepEqual(diff.patch, {}, 'ausencia nunca gera patch');
  assert.deepEqual(diff.changedKeys, []);

  const formOnlyUndefined = configDiff({ a: undefined }, { a: 1 });
  assert.deepEqual(formOnlyUndefined.patch, {});

  // Entrada vazia/ausente e no-op.
  assert.deepEqual(configDiff(null, { a: 1 }).patch, {});
  assert.deepEqual(configDiff(undefined, null).changedKeys, []);
  assert.deepEqual(configDiff({ a: '   ' }, { a: 1 }).patch, {}, 'espaco em branco e ausencia');
});

test('validateConfigForm honra clamps e type declarados no schema', () => {
  const schema = [
    { key: 'autoFetchMax', label: 'Teto', type: 'number', min: 1, max: 12 },
    { key: 'autoFetchAnyDubbed', label: 'Dublado global', type: 'boolean' },
  ];

  const tooLow = validateConfigForm({ autoFetchMax: 0 }, schema);
  assert.equal(tooLow.ok, false);
  assert.equal(tooLow.errors[0].key, 'autoFetchMax');
  assert.equal(tooLow.errors[0].reason, 'min');
  assert.match(tooLow.errors[0].message, /menor que 1/);

  const tooHigh = validateConfigForm({ autoFetchMax: 13 }, schema);
  assert.equal(tooHigh.errors[0].reason, 'max');
  assert.match(tooHigh.errors[0].message, /maior que 12/);

  const wrongNumber = validateConfigForm({ autoFetchMax: 'abc' }, schema);
  assert.equal(wrongNumber.errors[0].reason, 'type');
  assert.match(wrongNumber.errors[0].message, /deve ser um n/);

  const wrongBoolean = validateConfigForm({ autoFetchAnyDubbed: 'talvez' }, schema);
  assert.equal(wrongBoolean.errors[0].reason, 'type');
  assert.match(wrongBoolean.errors[0].message, /ligado ou desligado/);
  assert.equal(wrongBoolean.errors[0].label, 'Dublado global');

  // 5 e numero aceito (mesma coercao do diff) e boolean textual converte.
  const valid = validateConfigForm({ autoFetchMax: '5', autoFetchAnyDubbed: 'false' }, schema);
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.errors, []);

  // Ausente nao valida (e nao inventa erro).
  assert.equal(validateConfigForm({ autoFetchMax: '' }, schema).ok, true);
  assert.equal(validateConfigForm({}, schema).ok, true);
  assert.equal(validateConfigForm(null, schema).ok, true);
});

test('validateConfigForm acusa chave fora do schema e aceita snapshot/payload', () => {
  const schema = [{ key: 'autoFetchMax', label: 'Teto', type: 'number', min: 1, max: 12 }];

  const unknown = validateConfigForm({ naoExiste: 1 }, schema);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errors[0].reason, 'unknown-key');
  assert.match(unknown.errors[0].message, /Campo desconhecido/);

  // Campo declarado no schema mas sem tipo e tratado como sem schema (evita
  // mandar um campo que o backend recusaria).
  const untyped = validateConfigForm({ semTipo: 1 }, [{ key: 'semTipo', label: 'Sem tipo', type: 'unknown' }]);
  assert.equal(untyped.ok, false);
  assert.equal(untyped.errors[0].reason, 'unknown-key');

  // O 2o parametro aceita o payload inteiro ({ config: { schema } }).
  const viaPayload = validateConfigForm(
    { autoFetchMax: 99 },
    { config: { schema, effective: {}, envDefaults: {}, overriddenKeys: [] } },
  );
  assert.equal(viaPayload.ok, false);
  assert.equal(viaPayload.errors[0].reason, 'max');

  // ...e o snapshot direto (sem envelope config).
  const viaSnapshot = validateConfigForm({ autoFetchMax: 0 }, { schema });
  assert.equal(viaSnapshot.errors[0].reason, 'min');
});