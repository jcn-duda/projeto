#!/usr/bin/env node
/**
 * Fixtures de CONTRATO dos quatro passos novos do worker do Chupim.
 *
 * `probe_step` + `probe_job`, `season_step`, `suppressed_step` e `evict_step`
 * moram no BINÁRIO `adom-server` (não há alvo `lib`): nenhum deles é alcançável
 * de `crates/adom-core/tests/`, e nenhum tem função 1:1 no TypeScript que dê um
 * oráculo honesto (`requestBrProbe`/`drainSuppressed`/`maybeEvictFallbacks` são
 * procedurais, com rede e store). Por isso estes goldens são de CONTRATO: a
 * decisão esperada é escrita AQUI, lida do contrato documentado no módulo Rust e
 * no TS do worktree `../adom-esm`, e o teste Rust só confere "a régua ainda
 * responde isto?".
 *
 * O que este script NÃO faz: rodar código de produção para descobrir a saída.
 * Um gerador que chama a implementação e grava o resultado é falso-verde — ele
 * congela o bug junto com o comportamento. Aqui a tabela é a fonte; o JSONL é
 * só a serialização dela, e o manifest prende o hash para o fixture não derivar
 * em silêncio.
 *
 * Geração: `node scripts/golden/contract-autofetch-steps.mjs`
 * Conferência (só leitura): `node scripts/golden/contract-autofetch-steps.mjs --check`
 *
 * Quem roda no CI são os testes Rust (`cargo test -p adom-server`); este script
 * é MANUAL, como os demais geradores de `scripts/golden/`.
 *
 * # Prova de mutação (manual — o repo NÃO tem harness de mutação em Rust)
 *
 * Fixture que passa por construção não prova nada. Cada régua crítica foi
 * mutada à mão no código de produção, o golden rodou e o mutante morreu; depois
 * o texto voltou ao original. A receita é sempre a mesma: editar, rodar
 * `cargo test -p adom-server --bin adom-server <filtro>`, ver o `caso <id>`
 * divergir e reverter. Os pares abaixo são a prova de que cada caso tem dente:
 *
 * | # | mutante (código de produção)                          | caso que mata     |
 * |---|-------------------------------------------------------|-------------------|
 * | 1 | `queue_full`: `queue_len >= queue_max` → `>`          | afps-014          |
 * | 2 | `settle`: `if !directed` → `if !directed && false`    | afps-031          |
 * | 3 | `season_fill_decision`: `gap None` → `Fill{1}`        | afss-017          |
 * | 4 | `defended`: chave `adhold:v1:{conta}:{hash}` invertida | afsp-002          |
 * | 5 | `skip_reason`: gate `no-br-proof` desligado           | afev-018          |
 * | 6 | `skip_reason`: `held` antes de `pool-br`              | afev-028          |
 * | 7 | `normalize`: `account == "none"` desligado             | afss-002          |
 *
 * Se um dia entrar um harness de mutação de verdade, estes sete viram a
 * primeira leva dele — não invente um runner que edita fonte sem reverter no
 * fim.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN_DIR = path.join(REPO, 'rust', 'golden');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';

/** Relógio fixo de todos os casos: nada aqui depende de `Date.now()`. */
const NOW = 1_700_000_000_000;
const MIN_AGE_MS = 1_800_000;
const HOUR_MS = 3_600_000;
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const out = (value) => JSON.stringify(value);

// ─── Sonda dirigida (`probe_step::plan` + `settle`) ─────────────────────────
//
// Alvos da sonda: index-only ∩ pt-BR, na ordem de `index_only`, MENOS os isentos
// da busca viva (`BrProbe::probe_indexers`).
const PROBE_BASE = {
  release_index: true,
  br_probe: true,
  paused: false,
  queue_len: 0,
  queue_max: 200,
  index_only: ['redetorrent-cardigann', 'apachetorrent-cardigann', 'hdrtorrent-cardigann'],
  pt_br: ['redetorrent-cardigann', 'apachetorrent-cardigann', 'hdrtorrent-cardigann', 'bludv'],
  live_exempt: ['apachetorrent-cardigann'],
};
const PROBE_TARGETS = ['redetorrent-cardigann', 'hdrtorrent-cardigann'];

const plan = (payload, cfg = {}, state = null) => ({
  op: 'plan',
  payload,
  state,
  config: { ...PROBE_BASE, ...cfg },
});
const schedule = (work, orphan = false) =>
  out({
    decision: 'schedule',
    episode: work.episode ?? null,
    imdb: work.imdb ?? work.imdbId,
    indexers: PROBE_TARGETS,
    orphan,
    season: work.season ?? null,
    type: work.type,
  });
const skip = (reason) => out({ decision: 'skip', reason });
const MOVIE = { imdbId: 'tt0111161', type: 'movie' };

const probeCases = [
  {
    id: 'afps-001',
    input: plan({}),
    expected: skip('invalid'),
    why: 'payload vazio',
  },
  {
    id: 'afps-002',
    input: plan({ imdbId: '0111161', type: 'movie' }),
    expected: skip('invalid'),
    why: 'IMDb sem o prefixo tt (regex do enqueue TS)',
  },
  {
    id: 'afps-003',
    input: plan({ imdbId: 'TT0111161', type: 'movie' }),
    expected: skip('invalid'),
    why: 'IMDb em maiúscula não é o id canônico',
  },
  {
    id: 'afps-004',
    input: plan({ imdbId: 'tt0111161', type: 'anime' }),
    expected: skip('invalid'),
    why: 'tipo fora de movie|series nunca vira filme por omissão',
  },
  {
    id: 'afps-005',
    input: plan({ imdbId: 'tt0111161' }),
    expected: skip('invalid'),
    why: 'sem `type` não há obra',
  },
  {
    id: 'afps-006',
    input: plan({ imdbId: ' tt0111161 ', type: 'movie' }),
    expected: schedule({ imdb: 'tt0111161', type: 'movie' }),
    why: 'o trim do payload não muda a identidade',
  },
  {
    id: 'afps-007',
    input: plan(MOVIE),
    expected: schedule({ imdb: 'tt0111161', type: 'movie' }),
    why: 'filme no caminho feliz: dois alvos, sem S/E',
  },
  {
    id: 'afps-008',
    input: plan({ imdbId: 'tt0944947', type: 'series', season: 2, episode: 5 }),
    expected: schedule({ imdb: 'tt0944947', type: 'series', season: 2, episode: 5 }),
    why: 'série entra por episódio',
  },
  {
    id: 'afps-009',
    input: plan({ imdbId: 'tt0944947', type: 'series', season: '2', episode: '5' }),
    expected: schedule({ imdb: 'tt0944947', type: 'series' }),
    why: 'temporada em TEXTO é ausência: não vira outra identidade',
  },
  {
    id: 'afps-010',
    input: plan({ imdbId: 'tt0944947', type: 'series', season: 2.5, episode: 5 }),
    expected: schedule({ imdb: 'tt0944947', type: 'series', season: null, episode: 5 }),
    why: 'temporada fracionária é ausência (as_i64)',
  },
  {
    id: 'afps-011',
    input: plan({ imdbId: 'tt0944947', type: 'series', season: 4_000_000_000 }),
    expected: schedule({ imdb: 'tt0944947', type: 'series' }),
    why: 'temporada que não cabe em i32 é ausência',
  },
  {
    id: 'afps-012',
    input: plan(MOVIE, { paused: true }),
    expected: skip('paused'),
    why: 'kill-switch do worker',
  },
  {
    id: 'afps-013',
    input: plan({}, { paused: true }),
    expected: skip('invalid'),
    why: 'payload inválido vem ANTES do kill-switch (custo zero)',
  },
  {
    id: 'afps-014',
    input: plan(MOVIE, { queue_len: 200 }),
    expected: skip('queue-full'),
    why: 'fila no teto: o enqueue recusaria e ainda evictaria a cauda',
  },
  {
    id: 'afps-015',
    input: plan(MOVIE, { queue_len: 9_999, queue_max: 0 }),
    expected: schedule({ imdb: 'tt0111161', type: 'movie' }),
    why: '`queue_max = 0` é "sem teto"',
  },
  {
    id: 'afps-016',
    input: plan(MOVIE, { release_index: false }),
    expected: skip('release-index-off'),
    why: 'sem índice a sonda não tem onde escrever',
  },
  {
    id: 'afps-017',
    input: plan(MOVIE, { br_probe: false }),
    expected: skip('disabled'),
    why: 'toggle AUTOFETCH_BR_PROBE',
  },
  {
    id: 'afps-018',
    input: plan(MOVIE, { index_only: ['1337x'], pt_br: ['bludv'] }),
    expected: skip('no-intersection'),
    why: 'index-only sem nenhum pt-BR',
  },
  {
    id: 'afps-019',
    input: plan(MOVIE, {
      index_only: ['apachetorrent-cardigann'],
      pt_br: ['apachetorrent-cardigann'],
    }),
    expected: skip('no-intersection'),
    why: 'interseção só de isento da busca viva não tem onde sondar',
  },
  {
    id: 'afps-020',
    input: plan(MOVIE, { queue_len: 200, release_index: false }),
    expected: skip('queue-full'),
    why: 'ordem dos motivos: pausa/fila antes dos toggles',
  },
  {
    id: 'afps-021',
    input: plan(MOVIE, {}, { state: 'pending', at: NOW, leaseUntil: NOW + 600_000 }),
    expected: skip('pending'),
    why: 'lease vivo: não re-sonda (e segura o pool de sementes)',
  },
  {
    id: 'afps-022',
    input: plan(MOVIE, {}, { state: 'pending', at: NOW - 700_000, leaseUntil: NOW - 1 }),
    expected: schedule({ imdb: 'tt0111161', type: 'movie' }, true),
    why: 'lease vencido é órfão (crash): reagenda com métrica própria',
  },
  {
    id: 'afps-023',
    input: plan(MOVIE, {}, { state: 'pending', at: NOW - 700_000 }),
    expected: schedule({ imdb: 'tt0111161', type: 'movie' }, true),
    why: 'pending sem `leaseUntil` nunca está vivo',
  },
  {
    id: 'afps-024',
    input: plan(MOVIE, {}, { state: 'found', at: NOW - 1_000 }),
    expected: skip('found'),
    why: 'BR já provado: dedupe de 12h, sementes liberadas',
  },
  {
    id: 'afps-025',
    input: plan(MOVIE, {}, { state: 'empty', at: NOW - 1_000 }),
    expected: skip('empty'),
    why: 'sondou e não achou há pouco: dedupe',
  },
  {
    id: 'afps-026',
    input: plan(MOVIE, {}, { state: 'failed', at: NOW - 100_000 }),
    expected: skip('retry'),
    why: 'retry curto de 5 min ainda não venceu',
  },
  {
    id: 'afps-027',
    input: plan(MOVIE, {}, { state: 'failed', at: NOW - 300_000 }),
    expected: schedule({ imdb: 'tt0111161', type: 'movie' }),
    why: 'janela de retry vencida no limite exato (`<` estrito)',
  },
  {
    id: 'afps-028',
    input: plan(MOVIE, {}, { state: 'capped', at: NOW - 299_999 }),
    expected: skip('retry'),
    why: 'capped tem o mesmo retry curto de failed',
  },
  {
    id: 'afps-029',
    input: {
      op: 'settle',
      work: { imdb: 'tt0111161', type: 'movie' },
      outcome: 'accepted:queued',
      directed: true,
      ttl_seconds: 43_200,
    },
    expected: out({ error: null, pending: true, scheduled: true, skip: null }),
    why: 'aceite + flag dirigida confirmada = pending no KV (lease)',
  },
  {
    id: 'afps-030',
    input: {
      op: 'settle',
      work: { imdb: 'tt0111161', type: 'movie' },
      outcome: 'rejected:capacity',
      directed: true,
      ttl_seconds: 43_200,
    },
    expected: out({ error: null, pending: false, scheduled: false, skip: 'capacity' }),
    why: 'pedido que não entrou na fila NÃO grava pending',
  },
  {
    id: 'afps-031',
    input: {
      op: 'settle',
      work: { imdb: 'tt0111161', type: 'movie' },
      outcome: 'accepted:queued',
      directed: false,
      ttl_seconds: 43_200,
    },
    expected: out({ error: null, pending: false, scheduled: false, skip: 'not-directed' }),
    why: 'aceito sem a flag dirigida faria colheita completa: não é sonda',
  },
  {
    id: 'afps-032',
    input: {
      op: 'settle',
      work: { imdb: 'tt0111161', type: 'movie' },
      outcome: 'rejected:dedupe',
      directed: false,
      ttl_seconds: 43_200,
    },
    expected: out({ error: null, pending: false, scheduled: false, skip: 'dedupe' }),
    why: 'motivo do enqueue sobrevive ao rótulo do painel',
  },
];

// ─── Season Pack Fill (`season_step::plan` + `plan_fill`) ───────────────────
const SEASON_CFG = { enabled: true, paused: false, max_seasons: 200, max_keys: 64, ttl_seconds: 600 };
const SEASON_PAYLOAD = {
  adapter_id: 'alldebrid',
  account: 'conta',
  imdb: 'tt0111161',
  season: 2,
  cache_key: 'busca-1',
};
const register = (payload, cfg = {}) => ({
  op: 'plan',
  payload,
  config: { ...SEASON_CFG, ...cfg },
});
const registered = (adapter = 'alldebrid', account = 'conta') =>
  out({
    cache_key: 'busca-1',
    decision: 'register',
    key: `autofetch:v3:season:${adapter}:${account}:tt0111161:2`,
    season: 2,
  });
const fill = (facts, cfg = {}) => ({ op: 'fill', facts, config: { ...SEASON_CFG, ...cfg } });

const seasonCases = [
  {
    id: 'afss-001',
    input: register({}),
    expected: skip('invalid'),
    why: 'payload vazio',
  },
  {
    id: 'afss-002',
    input: register({ ...SEASON_PAYLOAD, account: 'none' }),
    expected: skip('invalid'),
    why: 'conta `none` é ausência de credencial, não um escopo',
  },
  {
    id: 'afss-003',
    input: register({ ...SEASON_PAYLOAD, imdb: '0111161' }),
    expected: skip('invalid'),
    why: 'IMDb sem `tt`',
  },
  {
    id: 'afss-004',
    input: register({ ...SEASON_PAYLOAD, imdb: 'tt' }),
    expected: skip('invalid'),
    why: '`tt` sozinho não identifica obra (len < 3)',
  },
  {
    id: 'afss-005',
    input: register({ ...SEASON_PAYLOAD, season: 0 }),
    expected: skip('invalid'),
    why: 'temporada 0 não existe',
  },
  {
    id: 'afss-006',
    input: register({ ...SEASON_PAYLOAD, season: undefined }),
    expected: skip('invalid'),
    why: 'sem temporada não há chave de temporada',
  },
  {
    id: 'afss-007',
    input: register({ ...SEASON_PAYLOAD, cache_key: '' }),
    expected: skip('invalid'),
    why: 'sem busca concreta não há o que registrar',
  },
  {
    id: 'afss-008',
    input: register({ ...SEASON_PAYLOAD, cache_key: '   ' }),
    expected: skip('invalid'),
    why: 'espaço em branco é ausência (o `text()` trima)',
  },
  {
    id: 'afss-009',
    input: register(SEASON_PAYLOAD, { paused: true }),
    expected: skip('paused'),
    why: 'pausa desliga registro E preenchimento',
  },
  {
    id: 'afss-010',
    input: register(SEASON_PAYLOAD, { enabled: false }),
    expected: skip('fill-off'),
    why: 'toggle do Season Pack Fill desligado',
  },
  {
    id: 'afss-011',
    input: register(SEASON_PAYLOAD, { max_seasons: 0 }),
    expected: skip('index-off'),
    why: 'teto de temporadas 0 desliga só o índice',
  },
  {
    id: 'afss-012',
    input: register(SEASON_PAYLOAD),
    expected: registered(),
    why: 'caminho feliz: chave = prefixo do KV + chave lógica do TS',
  },
  {
    id: 'afss-013',
    input: register({ ...SEASON_PAYLOAD, adapter_id: ' alldebrid ', account: ' conta ' }),
    expected: registered(),
    why: 'adapter/conta entram trimados na chave',
  },
  {
    id: 'afss-014',
    input: fill({ title: 'Serie S02 Completa 1080p', gap: 2, is_pack: true }, { paused: true }),
    expected: skip('paused'),
    why: 'pausa também desliga o preenchimento',
  },
  {
    id: 'afss-015',
    input: fill({ title: 'Serie S02 Completa 1080p', gap: 2, is_pack: true }, { enabled: false }),
    expected: skip('fill-off'),
    why: 'toggle desligado (a régua pura devolve Disabled)',
  },
  {
    id: 'afss-016',
    input: fill({ title: 'Serie S02E05 1080p', gap: 2, is_pack: false }),
    expected: skip('not-pack'),
    why: 'episódio avulso não preenche buraco de temporada',
  },
  {
    id: 'afss-017',
    input: fill({ title: 'Serie Temporada Completa 1080p', gap: null, is_pack: true }),
    expected: skip('no-declared-season'),
    why: '"Temporada Completa" sem número NUNCA vira S1',
  },
  {
    id: 'afss-018',
    input: fill({ title: '   ', gap: 2, is_pack: true }),
    expected: skip('title-unproven'),
    why: 'sem título não há match de pack',
  },
  {
    id: 'afss-019',
    input: fill({ title: 'Serie S02 Completa 1080p', gap: 2, is_pack: true }),
    expected: out({ decision: 'fill', season: 2 }),
    why: 'pack que prova a temporada declarada preenche',
  },
  {
    id: 'afss-020',
    input: fill({ title: 'Serie S03 Completa 1080p', gap: 2, is_pack: true }),
    expected: skip('undeclared-season'),
    why: 'pack de OUTRA temporada não preenche o buraco',
  },
  {
    id: 'afss-021',
    input: fill({ title: 'Serie Todas as Temporadas 1080p', gap: 2, is_pack: true }),
    expected: out({ decision: 'fill', season: 2 }),
    why: 'série completa cobre qualquer temporada declarada',
  },
  {
    id: 'afss-022',
    input: fill({ title: 'Serie S02E05 1080p', gap: 2, is_pack: true }),
    expected: skip('undeclared-season'),
    why: 'título com episódio não prova a temporada inteira',
  },
];

// ─── Represa (`suppressed_step::drain`) ────────────────────────────────────
const SCOPE_ACCOUNT = 'conta-de-teste';
const press = (hash, extra = {}) => ({
  adapter: 'alldebrid',
  account: SCOPE_ACCOUNT,
  hash,
  id: extra.id === undefined ? `id-${hash.slice(0, 4)}` : extra.id,
  fails: extra.fails ?? 0,
  next_at: extra.next_at ?? 0,
  hold: extra.hold ?? false,
  adprot: extra.adprot ?? false,
  adrm: extra.adrm ?? false,
  raw_at_only: extra.raw_at_only ?? false,
});
const counters = (dropped, kept, operations, depth, retried = 0, failed = 0) =>
  out({ counters: { dropped, failed, kept, retried }, depth, operations });

const suppressedCases = [
  {
    id: 'afsp-001',
    input: { op: 'drain', max: 10, entries: [press(HASH_A)] },
    expected: counters(1, 0, 1, 0),
    why: 'entrada elegível: remove pelo id atual e sai da represa',
  },
  {
    id: 'afsp-002',
    input: { op: 'drain', max: 10, entries: [press(HASH_A, { hold: true })] },
    expected: counters(0, 1, 0, 1),
    why: 'hold vivo (`adhold:v1:`) está no invariante 6: nada sai',
  },
  {
    id: 'afsp-003',
    input: { op: 'drain', max: 10, entries: [press(HASH_A, { adprot: true })] },
    expected: counters(0, 1, 0, 1),
    why: 'proteção durável do pool BR (`adprot:v1:`) também defende',
  },
  {
    id: 'afsp-004',
    input: { op: 'drain', max: 10, entries: [press(HASH_A, { adrm: true })] },
    expected: counters(1, 0, 0, 0),
    why: '`adrm:v1:` prova que já saiu: cai sem chamada de rede',
  },
  {
    id: 'afsp-005',
    input: { op: 'drain', max: 10, entries: [press(HASH_A, { next_at: NOW + 60_000, fails: 2 })] },
    expected: counters(0, 1, 0, 1),
    why: 'backoff agendado: a falha anterior já comprou a espera',
  },
  {
    id: 'afsp-006',
    input: { op: 'drain', max: 10, entries: [press(HASH_A, { raw_at_only: true })] },
    expected: counters(1, 0, 0, 0),
    why: 'registro sem id é órfão, não remoção represada',
  },
  {
    id: 'afsp-007',
    input: { op: 'drain', max: 1, entries: [press(HASH_A), press(HASH_B)] },
    expected: counters(1, 1, 1, 1),
    why: 'teto por passagem conta CHAMADAS: o excedente volta depois',
  },
  {
    id: 'afsp-008',
    input: {
      op: 'drain',
      max: 10,
      entries: [{ ...press(HASH_A), account: 'conta-sem-chave' }],
    },
    expected: counters(0, 1, 0, 1),
    why: 'escopo sem credencial no cofre: o passo é PULADO, nunca falha',
  },
];

// ─── Evicção de fallbacks (`evict_step::plan`) ──────────────────────────────
const EVICT_GATES = { enabled: true, max_per_run: 25, min_age_ms: MIN_AGE_MS, occupancy: null };
const evictItem = (extra = {}) => ({
  hash: HASH_A,
  transfer_id: 'transfer-1',
  name: 'Filme 1080p Dublado',
  pool: 'any',
  overflow: false,
  marker_matches_work: true,
  owned: true,
  held: false,
  protected: false,
  br_retained: false,
  accepted_at: NOW - HOUR_MS,
  ...extra,
});
const evict = (items, facts = {}, gates = {}) => ({
  op: 'plan',
  facts: { current_ready_is_br: true, work_has_prior_br_ready: false, ...facts },
  gates: { ...EVICT_GATES, ...gates },
  items,
});
const removed = (hash = HASH_A) =>
  out([{ action: 'remove', hash, name: 'Filme 1080p Dublado', transfer_id: 'transfer-1' }]);
const evSkip = (reason, hash = HASH_A) => out([{ action: 'skip', hash, reason }]);

const evictCases = [
  {
    id: 'afev-001',
    input: evict([evictItem()]),
    expected: removed(),
    why: 'caminho feliz: todas as provas presentes',
  },
  {
    id: 'afev-002',
    input: evict([evictItem({ held: true })]),
    expected: evSkip('held'),
    why: 'hold vivo nunca apaga',
  },
  {
    id: 'afev-003',
    input: evict([evictItem({ protected: true })]),
    expected: evSkip('protected'),
    why: 'proteção durável do acervo do usuário',
  },
  {
    id: 'afev-004',
    input: evict([evictItem({ br_retained: true })]),
    expected: evSkip('br-retained'),
    why: 'retenção BR (última milha) tem rótulo próprio',
  },
  {
    id: 'afev-005',
    input: evict([evictItem({ br_retained: true, protected: true })]),
    expected: evSkip('br-retained'),
    why: 'ordem dos rótulos: retenção BR antes de proteção genérica',
  },
  {
    id: 'afev-006',
    input: evict([evictItem({ owned: false })]),
    expected: evSkip('no-ownership'),
    why: 'sem posse durável (`adsub:v1`) o worker não é dono do hash',
  },
  {
    id: 'afev-007',
    input: evict([evictItem({ accepted_at: 0 })]),
    expected: evSkip('no-accepted-at'),
    why: 'sem carimbo de aceite não há idade provada',
  },
  {
    id: 'afev-008',
    input: evict([evictItem({ accepted_at: NOW - 60_000 })]),
    expected: evSkip('too-young'),
    why: 'fallback novo pode ainda estar baixando',
  },
  {
    id: 'afev-009',
    input: evict([evictItem({ accepted_at: NOW - MIN_AGE_MS })]),
    expected: removed(),
    why: 'idade exatamente no piso já é elegível (`>=` no crate)',
  },
  {
    id: 'afev-010',
    input: evict([evictItem({ pool: 'br' })]),
    expected: evSkip('pool-br'),
    why: 'o alvo da evicção é o fallback, nunca o dublado',
  },
  {
    id: 'afev-011',
    input: evict([evictItem({ pool: 'seeds' })]),
    expected: removed(),
    why: 'pool seeds é fallback elegível',
  },
  {
    id: 'afev-012',
    input: evict([evictItem({ overflow: true })]),
    expected: evSkip('overflow'),
    why: 'vaga de overflow é reserva deliberada de upgrade',
  },
  {
    id: 'afev-013',
    input: evict([evictItem({ marker_matches_work: false })]),
    expected: evSkip('other-work'),
    why: 'marker de OUTRA obra nunca autoriza delete',
  },
  {
    id: 'afev-014',
    input: evict([evictItem({ transfer_id: null })]),
    expected: evSkip('no-transfer-id'),
    why: 'nenhum serviço apaga por hash: sem id não há âncora',
  },
  {
    id: 'afev-015',
    input: evict([evictItem({ transfer_id: '   ' })]),
    expected: evSkip('no-transfer-id'),
    why: 'id em branco é ausência',
  },
  {
    id: 'afev-016',
    input: evict([evictItem({ name: null })]),
    expected: evSkip('no-name'),
    why: 'sem nome autoritativo não há blindagem BR de última milha',
  },
  {
    id: 'afev-017',
    input: evict([evictItem({ name: '  ' })]),
    expected: evSkip('no-name'),
    why: 'nome em branco é ausência',
  },
  {
    id: 'afev-018',
    input: evict([evictItem()], { current_ready_is_br: false, work_has_prior_br_ready: false }),
    expected: evSkip('no-br-proof'),
    why: 'sem BR ready (atual ou anterior) nada é candidato',
  },
  {
    id: 'afev-019',
    input: evict([evictItem()], { current_ready_is_br: false, work_has_prior_br_ready: true }),
    expected: removed(),
    why: 'BR ready anterior já prova a obra',
  },
  {
    id: 'afev-020',
    input: evict([evictItem()], {}, { enabled: false }),
    expected: out([]),
    why: 'kill-switch OFF: plano vazio, zero leitura e zero delete',
  },
  {
    id: 'afev-021',
    input: evict([evictItem()], {}, { max_per_run: 0 }),
    expected: out([]),
    why: 'teto 0 desliga mesmo com o toggle ligado',
  },
  {
    id: 'afev-022',
    input: evict([evictItem()], {}, { occupancy: { used: 600, floor: 600 } }),
    expected: out([]),
    why: 'conta na ocupação do piso: sem vaga acima do piso',
  },
  {
    id: 'afev-023',
    input: evict([evictItem()], {}, { occupancy: { used: 700, floor: 600 } }),
    expected: removed(),
    why: 'o piso limita a passagem, não proíbe a remoção',
  },
  {
    id: 'afev-024',
    input: evict([evictItem(), evictItem()]),
    expected: out([
      { action: 'remove', hash: HASH_A, name: 'Filme 1080p Dublado', transfer_id: 'transfer-1' },
      { action: 'skip', hash: HASH_A, reason: 'duplicate' },
    ]),
    why: 'duas entradas do mesmo hash nunca viram dois deletes',
  },
  {
    id: 'afev-025',
    input: evict([evictItem(), evictItem({ hash: HASH_B, transfer_id: 'transfer-2' })], {}, { max_per_run: 1 }),
    expected: out([
      { action: 'remove', hash: HASH_A, name: 'Filme 1080p Dublado', transfer_id: 'transfer-1' },
      { action: 'skip', hash: HASH_B, reason: 'over-limit' },
    ]),
    why: 'teto por passagem: o excedente fica rotulado, não some',
  },
  {
    id: 'afev-026',
    input: evict([evictItem({ hash: '' })]),
    expected: evSkip('empty-hash', ''),
    why: 'hash vazio não identifica nada',
  },
  {
    id: 'afev-027',
    input: evict([evictItem({ hash: HASH_A.toUpperCase() })]),
    expected: removed(),
    why: 'hash entra minúsculo no plano (o mesmo do marker)',
  },
  {
    id: 'afev-028',
    input: evict([evictItem({ held: true, pool: 'br' })]),
    expected: evSkip('pool-br'),
    why: 'ordem dos rótulos: pool antes de hold',
  },
  {
    id: 'afev-029',
    input: evict([evictItem({ accepted_at: NOW })], {}, { min_age_ms: 0 }),
    expected: removed(),
    why: 'piso de idade 0 não inventa espera',
  },
];

const SUITES = [
  {
    name: 'autofetch-probe-step',
    registry: 'autofetch-probe-step/plan+settle',
    subject: {
      module: 'rust/crates/adom-server/src/autofetch/probe_step.rs',
      functions: ['plan', 'normalize', 'settle'],
      companion: 'rust/crates/adom-server/src/autofetch/probe_job.rs',
    },
    reason:
      'Sem oráculo TS 1:1: o `br-probe.ts` do worktree `../adom-esm` é procedural ' +
      '(rede + fila) e não expõe a régua de plano do worker nativo.',
    cases: probeCases,
  },
  {
    name: 'autofetch-season-step',
    registry: 'autofetch-season-step/plan+fill',
    subject: {
      module: 'rust/crates/adom-server/src/autofetch/season_step.rs',
      functions: ['plan', 'plan_fill'],
    },
    reason:
      'Sem oráculo TS 1:1: `registerSeasonSearchKey` só indexa o `Map` do processo; ' +
      'a decisão de preencher vive na régua pura do crate.',
    cases: seasonCases,
  },
  {
    name: 'autofetch-suppressed-step',
    registry: 'autofetch-suppressed-step/drain',
    subject: {
      module: 'rust/crates/adom-server/src/autofetch/suppressed_step.rs',
      functions: ['drain', 'read_one', 'defended'],
    },
    reason:
      'Sem oráculo TS 1:1: o `drainSuppressed` do Node chama os adaptadores de debrid ' +
      '(rede) e o passo nativo relê o id antes do delete.',
    cases: suppressedCases,
  },
  {
    name: 'autofetch-evict-step',
    registry: 'autofetch-evict-step/plan',
    subject: {
      module: 'rust/crates/adom-server/src/autofetch/evict_step.rs',
      functions: ['plan'],
    },
    reason:
      'Sem oráculo TS 1:1: `maybeEvictFallbacks` é async e apaga de verdade; a ' +
      'seleção pura do crate já tem seu próprio golden.',
    cases: evictCases,
  },
];

function renderSuite(suite) {
  const ids = new Set();
  const lines = suite.cases.map((c) => {
    if (typeof c.why !== 'string' || !c.why) throw new Error(`caso ${c.id} sem justificativa`);
    if (ids.has(c.id)) throw new Error(`id duplicado: ${c.id}`);
    ids.add(c.id);
    return JSON.stringify({ id: c.id, input: JSON.stringify(c.input), expected: c.expected });
  });
  const body = `${lines.join('\n')}\n`;
  const manifest = {
    format: MANIFEST_FORMAT,
    kind: 'contract',
    sourceHashLineEndings: 'LF',
    registry: [suite.registry],
    subject: suite.subject,
    oracle: null,
    contractNote: suite.reason,
    generator: 'scripts/golden/contract-autofetch-steps.mjs',
    output: {
      path: `rust/golden/${suite.name}.jsonl`,
      sha256: sha256(body),
      lines: suite.cases.length,
    },
  };
  return { body, manifest: `${JSON.stringify(manifest, null, 2)}\n` };
}

function main() {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const suite of SUITES) {
    const { body, manifest } = renderSuite(suite);
    const jsonlPath = path.join(GOLDEN_DIR, `${suite.name}.jsonl`);
    const manifestPath = path.join(GOLDEN_DIR, `${suite.name}.manifest.json`);
    if (check) {
      const committed = fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, 'utf8') : '';
      const committedManifest = fs.existsSync(manifestPath)
        ? fs.readFileSync(manifestPath, 'utf8')
        : '';
      if (committed !== body) {
        console.error(`[contrato] DIVERGE: ${suite.name}.jsonl (rode sem --check)`);
        bad += 1;
      } else if (committedManifest !== manifest) {
        console.error(`[contrato] DIVERGE: ${suite.name}.manifest.json (rode sem --check)`);
        bad += 1;
      } else {
        console.log(`[contrato] OK: ${suite.name} (${suite.cases.length} casos)`);
      }
      continue;
    }
    fs.writeFileSync(jsonlPath, body);
    fs.writeFileSync(manifestPath, manifest);
    console.log(`[contrato] gerado: rust/golden/${suite.name}.jsonl (${suite.cases.length} casos)`);
  }
  if (bad > 0) process.exit(1);
}

main();
