import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogVerdict,
  applyCatalogFilter,
  verdictFilterOptions,
  emptyCatalogFilter,
  toggleAllSelection,
  type CatalogListRow,
} from '../src/client/painel/limpeza/catalogo-model.js';
import {
  workVersionsPlan,
  workGroupLabel,
  filterWorkGroups,
  type WorkVersionGroup,
} from '../src/client/painel/limpeza/versoes-model.js';
import { limpezaHeader } from '../src/client/painel/limpeza-model.js';

function row(overrides: Partial<CatalogListRow>): CatalogListRow {
  return {
    serviceId: '', hashShort: '', filename: '', sizeBytes: 0, bucket: '', bucketName: '',
    active: false, protected: false, foreignProof: '', ptProof: '', cached: '',
    ...overrides,
  };
}

// --- catalogVerdict sem prova ---

test('catalogVerdict sem prova retorna "sem prova" neutral', () => {
  const v = catalogVerdict(row({ bucketName: '' }));
  assert.equal(v.text, 'sem prova', 'sem foreignProof nem ptProof cai em "sem prova"');
  assert.equal(v.variant, 'neutral');
});

test('catalogVerdict com foreignProof retorna "estrangeiro" err', () => {
  const v = catalogVerdict(row({ foreignProof: 'korean', bucketName: 'Lixo / indefinido' }));
  assert.equal(v.text, 'estrangeiro');
  assert.equal(v.variant, 'err');
});

test('catalogVerdict com ptProof retorna "PT" ok', () => {
  const v = catalogVerdict(row({ ptProof: 'titulo' }));
  assert.equal(v.text, 'PT');
  assert.equal(v.variant, 'ok');
});

// --- applyCatalogFilter ---

test('applyCatalogFilter: busca por texto no filename', () => {
  const rows = [
    row({ serviceId: '1', filename: 'House of the Dragon S01E01 DUB' }),
    row({ serviceId: '2', filename: 'Goliath S03E01 DUAL' }),
    row({ serviceId: '3', filename: 'House of the Dragon S01E02 DUB' }),
  ];
  const filtered = applyCatalogFilter(rows, { search: 'house', verdict: '', sort: 'default' });
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].serviceId, '1');
  assert.equal(filtered[1].serviceId, '3');
});

test('applyCatalogFilter: filtro por veredito estrangeiro', () => {
  const rows = [
    row({ serviceId: '1', filename: 'A', foreignProof: 'korean' }),
    row({ serviceId: '2', filename: 'B', ptProof: 'titulo' }),
    row({ serviceId: '3', filename: 'C' }),
  ];
  const filtered = applyCatalogFilter(rows, { search: '', verdict: 'foreign', sort: 'default' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].serviceId, '1');
});

test('applyCatalogFilter: filtro por veredito PT', () => {
  const rows = [
    row({ serviceId: '1', filename: 'A', foreignProof: 'korean' }),
    row({ serviceId: '2', filename: 'B', ptProof: 'titulo' }),
    row({ serviceId: '3', filename: 'C' }),
  ];
  const filtered = applyCatalogFilter(rows, { search: '', verdict: 'pt', sort: 'default' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].serviceId, '2');
});

test('applyCatalogFilter: filtro "sem prova"', () => {
  const rows = [
    row({ serviceId: '1', filename: 'A', foreignProof: 'korean' }),
    row({ serviceId: '2', filename: 'B', ptProof: 'titulo' }),
    row({ serviceId: '3', filename: 'C' }),
  ];
  const filtered = applyCatalogFilter(rows, { search: '', verdict: 'unknown', sort: 'default' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].serviceId, '3');
});

test('applyCatalogFilter: ordenação por tamanho', () => {
  const rows = [
    row({ serviceId: '1', filename: 'Small', sizeBytes: 100 }),
    row({ serviceId: '2', filename: 'Big', sizeBytes: 9999 }),
    row({ serviceId: '3', filename: 'Mid', sizeBytes: 500 }),
  ];
  const sorted = applyCatalogFilter(rows, { search: '', verdict: '', sort: 'size' });
  assert.equal(sorted[0].serviceId, '2');
  assert.equal(sorted[1].serviceId, '3');
  assert.equal(sorted[2].serviceId, '1');
});

test('applyCatalogFilter: ordenação por nome', () => {
  const rows = [
    row({ serviceId: '1', filename: 'Charlie' }),
    row({ serviceId: '2', filename: 'Alpha' }),
    row({ serviceId: '3', filename: 'Bravo' }),
  ];
  const sorted = applyCatalogFilter(rows, { search: '', verdict: '', sort: 'name' });
  assert.equal(sorted[0].serviceId, '2');
  assert.equal(sorted[1].serviceId, '3');
  assert.equal(sorted[2].serviceId, '1');
});

test('toggleAllSelection marca só as linhas filtradas', () => {
  const rows = [
    row({ serviceId: '1', filename: 'A', foreignProof: 'korean' }),
    row({ serviceId: '2', filename: 'B', ptProof: 'titulo' }),
    row({ serviceId: '3', filename: 'C' }),
  ];
  const filtered = applyCatalogFilter(rows, { search: '', verdict: 'foreign', sort: 'default' });
  const selected = toggleAllSelection(filtered, []);
  assert.deepEqual(selected, ['1'], 'só o estrangeiro foi selecionado');
});

// --- verdictFilterOptions ---

test('verdictFilterOptions tem 4 opções', () => {
  const opts = verdictFilterOptions();
  assert.equal(opts.length, 4);
  assert.equal(opts[0].value, '');
  assert.equal(opts[1].value, 'foreign');
});

// --- workVersionsPlan (cliente) ---

test('workVersionsPlan normaliza o contrato do backend', () => {
  const data = {
    ok: true,
    plan: {
      groups: [{
        key: 'tt1234\x001\x00pack',
        workTitle: 'Obra',
        season: 1,
        episode: null,
        imdbId: 'tt1234',
        keep: { serviceId: '1', hash: 'a', filename: 'DUB.mkv', size: 5e9, bucket: 'dub', foreignProof: '', ptProof: '', ready: true, active: false, protected: false, workTitle: 'Obra', season: 1, episode: null },
        kill: [{ serviceId: '2', hash: 'b', filename: 'DUAL.mkv', size: 4e9, bucket: 'dual', foreignProof: '', ptProof: '', ready: false, active: false, protected: false, workTitle: 'Obra', season: 1, episode: null }],
        recoverableBytes: 4e9,
      }],
      withoutImdb: 3,
    },
  };
  const plan = workVersionsPlan(data);
  assert.equal(plan.ok, true);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].keep.bucketName, 'Dublado');
  assert.equal(plan.groups[0].kill[0].bucketName, 'Dual');
  assert.equal(plan.withoutImdb, 3);
});

test('workVersionsPlan falha retorna ok:false', () => {
  const plan = workVersionsPlan({ ok: false, reason: 'sem-adapter' });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'sem-adapter');
  assert.equal(plan.groups.length, 0);
});

test('workGroupLabel monta rótulo com temporada e episódio', () => {
  const g = { workTitle: 'House of the Dragon', season: 1, episode: 3, imdbId: 'tt1234' } as any;
  assert.equal(workGroupLabel(g), 'House of the Dragon · S01E03');
  const pack = { workTitle: 'Filme', season: null, episode: null, imdbId: 'tt5678' } as any;
  assert.equal(workGroupLabel(pack), 'Filme');
  const seasonOnly = { workTitle: 'Serie', season: 2, episode: null, imdbId: 'tt9999' } as any;
  assert.equal(workGroupLabel(seasonOnly), 'Serie · S02');
});

test('filterWorkGroups: "foreign" mantém só grupos com kill estrangeiro', () => {
  const groups: WorkVersionGroup[] = [
    { key: 'a', workTitle: 'A', season: null, episode: null, imdbId: 'tt1', keep: {} as any, kill: [{ foreignProof: 'korean' } as any], recoverableBytes: 0 },
    { key: 'b', workTitle: 'B', season: null, episode: null, imdbId: 'tt2', keep: {} as any, kill: [{ foreignProof: '' } as any], recoverableBytes: 0 },
  ];
  assert.equal(filterWorkGroups(groups, 'foreign').length, 1);
  assert.equal(filterWorkGroups(groups, '').length, 2);
});

// --- limpezaHeader com debrid ---

test('limpezaHeader com debrid usa contaView para preencher conta', () => {
  const conta = { ok: false };
  const debrid = {
    active: 'alldebrid',
    accounts: {
      alldebrid: { ok: true, service: 'alldebrid', magnets: 933, ready: 895, error: 3, label: 'AllDebrid' },
    },
  };
  const head = limpezaHeader(null, conta, debrid);
  assert.equal(head.accountService, 'alldebrid', 'conta do operador via debrid.accounts');
  assert.equal(head.accountTotal, 933);
  assert.equal(head.accountReady, 895);
  assert.equal(head.accountDead, 3);
});
