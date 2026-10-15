#!/usr/bin/env node
/**
 * Constrói o corpus do golden `autofetch-picks` — a cascata de picks do
 * autofetch BR (`src/utils/autofetch-picks.ts`): `pickBrDubbedCandidates`,
 * `pickAnyDubbedCandidates`, `pickTopSeededCandidates`, `hasCachedBrDubbed`,
 * `hasCachedAnyDubbed`, `cachedBrDubbedTargetQualities`, `uncachedBrHashes`,
 * `canAutoFetchBr` e `filterKnownCache`.
 *
 * O `expected` NÃO é calculado aqui: quem mede é o oráculo (dist vivo) rodado
 * pelo `dump-autofetch-picks.mjs`. Este script só desenha as ENTRADAS (cada
 * `input` é um JSON com `op` + streams no formato do corpus + parâmetros), para
 * o dumped gravar o golden determinístico. Rode:
 *
 *   node scripts/golden/build-corpus-autofetch-picks.mjs
 *
 * A saída é `scripts/golden/corpus-autofetch-picks.json` (LF, sem timestamp).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts', 'golden', 'corpus-autofetch-picks.json');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

const cases = [];
const add = (id, input, note) => cases.push({ id, input: JSON.stringify(input), ...(note ? { note } : {}) });

/** Stream do corpus: só os campos que os picks leem; `id` estável p/ mapear. */
const st = (id, infoHash, extra = {}) => ({ id, infoHash, ...extra });

// ── pickBrDubbedCandidates ────────────────────────────────────────────
add('pickbr-001', {
  op: 'pickBr', limit: 1,
  streams: [
    st('a', A, { quality: '1080p', seeders: 5, br: true, dubbed: true }),
    st('b', B, { quality: '1080p', seeders: 9, br: true, dubbed: true }),
  ],
}, 'mesma qualidade: mais seeders vence');
add('pickbr-002', {
  op: 'pickBr', limit: 4, cached: [B],
  streams: [
    st('a', A, { quality: '480p', seeders: 3, br: true, dubbed: true }),
    st('dup', A.toUpperCase(), { quality: '1080p', seeders: 1, br: true, dubbed: true }),
    st('b', B, { quality: '720p', seeders: 2, br: true, dubbed: true }),
    st('c', C, { quality: '1080p', seeders: 1, br: true, dubbed: true }),
  ],
}, 'dedupe case-insensitive + pula cacheado (B)');
add('pickbr-003', { op: 'pickBr', limit: 0, streams: [st('a', A, { quality: '1080p', br: true, dubbed: true })] }, 'limit 0 → vazio');
add('pickbr-004', { op: 'pickBr', limit: 1, streams: [st('a', A, { quality: '720p', seeders: 1, br: true, dubClaim: true })] }, 'promessa do post vira candidata');
add('pickbr-005', { op: 'pickBr', limit: 1, streams: [st('a', A, { quality: '1080p', br: true, dubClaim: true, lied: true })] }, 'promessa que mentiu: fora');
add('pickbr-006', { op: 'pickBr', limit: 1, streams: [st('a', A, { title: 'Filme CAM Dublado 1080p', quality: '1080p', br: true, dubbed: true })] }, 'CAM: fora');
add('pickbr-007', { op: 'pickBr', limit: 1, streams: [st('a', A, { quality: '1080p', br: true, dubbed: true, fromFallback: true })] }, 'fallback bloqueado: fora');
add('pickbr-008', {
  op: 'pickBr', limit: 1, season: 1,
  streams: [
    st('ep', A, { title: 'Serie S01E03 1080p Dublado', quality: '1080p', seeders: 50, br: true, dubbed: true }),
    st('pack', B, { title: 'Serie S01 Dublado 720p', quality: '720p', seeders: 2, br: true, dubbed: true }),
  ],
}, 'pack da temporada pedida vence qualidade/seeders');
add('pickbr-009', { op: 'pickBr', limit: 9, streams: [st('a', A, { quality: '1080p', br: true, dubbed: true })] }, 'limit maior que o pool');
add('pickbr-010', { op: 'pickBr', limit: 1, streams: [] }, 'pool vazio');
add('pickbr-011', {
  op: 'pickBr', limit: 2,
  streams: [
    st('leg', C, { quality: '1080p', seeders: 50, br: true, dubbed: false }),
    st('dub', B, { quality: '720p', seeders: 1, br: true, dubbed: true }),
  ],
}, 'marca de dublado vence qualidade maior');

// ── pickAnyDubbedCandidates ───────────────────────────────────────────
add('pickany-001', {
  op: 'pickAny', limit: 4,
  streams: [
    st('leg', C, { quality: '1080p', seeders: 50, dubbed: false }),
    st('cam', 'cam'.padEnd(40, 'x'), { title: 'Filme CAM Dublado 1080p', quality: '1080p', seeders: 99, dubbed: true }),
    st('dual', A, { quality: '1080p', seeders: 2, dubbed: true }),
  ],
}, 'global sem marca de áudio e CAM: fora');
add('pickany-002', {
  op: 'pickAny', limit: 4,
  streams: [
    st('uhd', C, { quality: '2160p', seeders: 999, dubbed: true }),
    st('g720', B, { quality: '720p', seeders: 100, dubbed: true }),
    st('gdup', A.toUpperCase(), { quality: '1080p', seeders: 5, dubbed: true }),
    st('g1080', A, { quality: '1080p', seeders: 5, dubbed: true }),
  ],
}, 'ordem 1080/720 antes do 2160 + dedupe');
add('pickany-003', {
  op: 'pickAny', limit: 4, cached: [A],
  streams: [st('g1080', A, { quality: '1080p', seeders: 5, dubbed: true }), st('g720', B, { quality: '720p', seeders: 1, dubbed: true })],
}, 'pula cacheado');
add('pickany-004', {
  op: 'pickAny', limit: 1,
  streams: [st('g1080', A, { quality: '1080p', seeders: 5, dubbed: true }), st('g720', B, { quality: '720p', seeders: 100, dubbed: true })],
}, 'limit 1 pega o melhor');
add('pickany-005', { op: 'pickAny', limit: 0, streams: [st('a', A, { quality: '1080p', dubbed: true })] }, 'limit 0 → vazio');
add('pickany-006', { op: 'pickAny', limit: 4, streams: [st('a', A, { quality: '1080p', dubClaim: true })] }, 'claim sem prova não entra no any');
add('pickany-007', { op: 'pickAny', limit: 4, streams: [] }, 'pool vazio');

// ── pickTopSeededCandidates ───────────────────────────────────────────
add('picktop-001', {
  op: 'pickTop', limit: 2,
  streams: [st('a', A, { title: 'Movie 1080p', seeders: 1 }), st('b', B, { title: 'Movie2 1080p', seeders: 20 })],
}, 'swarm: mais semeado primeiro');
add('picktop-002', {
  op: 'pickTop', limit: 2, minSeeders: 10,
  streams: [st('a', A, { title: 'Movie 1080p', seeders: 1 }), st('b', B, { title: 'Movie2 1080p', seeders: 20 })],
}, 'minSeeders corta o fraco');
add('picktop-003', {
  op: 'pickTop', limit: 2,
  streams: [st('pt', A, { title: 'Filme Dublado 720p', seeders: 5 }), st('raw', B, { title: 'Movie 1080p', seeders: 50 })],
}, 'ptFirst: sinal de PT antes do mais semeado');
add('picktop-004', {
  op: 'pickTop', limit: 2, ptFirst: false,
  streams: [st('pt', A, { title: 'Filme Dublado 720p', seeders: 5 }), st('raw', B, { title: 'Movie 1080p', seeders: 50 })],
}, 'ptFirst=false: seeders decide');
add('picktop-005', { op: 'pickTop', limit: 2, streams: [st('fr', A, { title: 'Movie FRENCH 1080p', seeders: 9 })] }, 'áudio estrangeiro explícito: fora');
add('picktop-006', { op: 'pickTop', limit: 2, streams: [st('n', A, { name: 'Movie 👤 42' })] }, 'seeders lidos do 👤 no name');
add('picktop-007', { op: 'pickTop', limit: 2, cached: [B], streams: [st('a', A, { title: 'Movie 1080p', seeders: 5 }), st('b', B, { title: 'Movie2 1080p', seeders: 50 })] }, 'pula cacheado');
add('picktop-008', { op: 'pickTop', limit: 2, streams: [] }, 'pool vazio');

// ── hasCachedBrDubbed / hasCachedAnyDubbed ──────────────────────────────
add('hasbr-001', { op: 'hasCachedBr', cached: [A], streams: [st('a', A, { quality: '1080p', br: true, dubbed: true })] }, 'BR dublado cacheado → true');
add('hasbr-002', { op: 'hasCachedBr', cached: [], streams: [st('a', A, { quality: '1080p', br: true, dubbed: true })] }, 'nada cacheado → false');
add('hasbr-003', { op: 'hasCachedBr', cached: [A.toUpperCase()], streams: [st('a', A, { quality: '1080p', br: true, dubbed: true })] }, 'cache MAIÚSCULO casa hash minúsculo');
add('hasbr-004', { op: 'hasCachedBr', cached: [A], streams: [st('a', A, { quality: '1080p', br: true, dubbed: true, lied: true })] }, 'lied fora do pool → false');
add('hasbr-005', { op: 'hasCachedBr', cached: [A], streams: [] }, 'vazio → false');
add('hasany-001', { op: 'hasCachedAny', cached: [A], streams: [st('a', A, { quality: '1080p', dubbed: true })] }, 'global dublado cacheado → true');
add('hasany-002', { op: 'hasCachedAny', cached: [A], streams: [st('a', A, { quality: '1080p', dubClaim: true })] }, 'claim sem prova: any não conta → false');
add('hasany-003', { op: 'hasCachedAny', cached: [], streams: [st('a', A, { quality: '1080p', dubbed: true })] }, 'vazio de cache → false');

// ── cachedBrDubbedTargetQualities ─────────────────────────────────────
add('ct-001', {
  op: 'cachedTargets', cached: [A],
  streams: [st('a', A, { quality: '1080p', br: true, dubbed: true }), st('b', B, { quality: '720p', br: true, dubbed: true })],
}, 'só a faixa cacheada conta (1080p)');
add('ct-002', {
  op: 'cachedTargets', cached: [A, B, C],
  streams: [st('a', A, { quality: '1080p', br: true, dubbed: true }), st('b', B, { quality: '720p', br: true, dubbed: true }), st('c', C, { quality: '2160p', br: true, dubbed: true })],
}, 'três faixas-alvo cobertas');
add('ct-003', {
  op: 'cachedTargets', cached: [A, B],
  streams: [st('a', A, { quality: 'sem resolução', br: true, dubbed: true }), st('b', B, { quality: '480p', br: true, dubbed: true })],
}, 'unknown/SD nunca entram');
add('ct-004', { op: 'cachedTargets', cached: [], streams: [st('a', A, { quality: '1080p', br: true, dubbed: true })] }, 'nada cacheado → vazio');
add('ct-005', { op: 'cachedTargets', cached: [A], streams: [] }, 'pool vazio → vazio');

// ── uncachedBrHashes ──────────────────────────────────────────────────
const ubStreams = [
  st('a', A, { quality: '1080p', br: true, dubbed: true }),
  st('b', B, { quality: '720p', br: true, dubbed: true }),
  st('c', C, { quality: '2160p', br: true, dubbed: true }),
];
add('ub-001', { op: 'uncachedBr', limit: 2, cached: [B], streams: ubStreams }, 'cacheado no meio não trava; corta no limite');
add('ub-002', { op: 'uncachedBr', limit: 1, cached: [], streams: ubStreams }, 'limit 1');
add('ub-003', { op: 'uncachedBr', limit: 5, cached: [A, B, C], streams: ubStreams }, 'tudo cacheado → vazio');
add('ub-004', { op: 'uncachedBr', limit: 0, cached: [], streams: ubStreams }, 'limit 0 → vazio');
add('ub-005', {
  op: 'uncachedBr', limit: 2, cached: [],
  streams: [st('claim', A, { quality: '1080p', br: true, dubClaim: true }), st('proof', B, { quality: '720p', br: true, dubbed: true })],
}, 'prova antes da promessa (sort estável por _dubbed)');
add('ub-006', {
  op: 'uncachedBr', limit: 1, cached: [],
  streams: [st('leg', A, { title: 'Prometheus LEGENDADO', br: true }), st('dub', B, { title: 'Prometheus Dublado', br: true, dubbed: true })],
}, 'LEGENDADO não ocupa vaga P2P');
add('ub-007', { op: 'uncachedBr', limit: 1, cached: [], streams: [st('a', A.toUpperCase(), { quality: '1080p', br: true, dubbed: true })] }, 'saída na casca original do hash');
add('ub-008', {
  op: 'uncachedBr', limit: 1, cached: [],
  streams: [st('g', A, { title: 'Prometheus 1080p', br: false }), st('br1', B, { title: 'Prometheus Dublado', br: true, dubbed: true }), st('br2', C, { title: 'Prometheus Dual', br: true, dubbed: true })],
}, 'global fora; primeira vaga BR');
add('ub-009', {
  op: 'uncachedBr', limit: 2, cached: [B],
  streams: [st('g', A, { title: 'Prometheus 1080p', br: false }), st('br1', B, { title: 'Prometheus Dublado', br: true, dubbed: true }), st('br2', C, { title: 'Prometheus Dual', br: true, dubbed: true })],
}, 'BR cacheado pula; segunda vaga vai ao próximo');

// ── canAutoFetchBr ────────────────────────────────────────────────────
add('caf-001', { op: 'canAutoFetch', autoFetchBr: true, cacheCheck: true, autofetchSource: false }, 'toggle + cacheCheck → true');
add('caf-002', { op: 'canAutoFetch', autoFetchBr: true, cacheCheck: false, autofetchSource: true }, 'toggle + fonte de inventário → true');
add('caf-003', { op: 'canAutoFetch', autoFetchBr: true, cacheCheck: false, autofetchSource: false }, 'toggle sem trava confiável → false');
add('caf-004', { op: 'canAutoFetch', autoFetchBr: false, cacheCheck: true, autofetchSource: true }, 'toggle desligado → false');
add('caf-005', { op: 'canAutoFetch', autoFetchBr: false, cacheCheck: false, autofetchSource: false }, 'tudo desligado → false');

// ── filterKnownCache ──────────────────────────────────────────────────
add('fk-001', {
  op: 'filterKnown', cachedOnly: true, showUncachedBr: true, brReservedSlots: 1,
  streams: [st('leg', A, { name: 'Prometheus LEGENDADO', br: true }), st('dub', B, { name: 'Prometheus Dublado', br: true, dubbed: true })],
}, 'vaga P2P prefere dublado e ignora LEGENDADO');
add('fk-002', {
  op: 'filterKnown', cached: [A], cachedOnly: true, showUncachedBr: true, brReservedSlots: 1,
  streams: [st('gc', A, { br: false }), st('gu', B, { br: false }), st('bru', C, { br: true, dubbed: true })],
}, 'mantém cacheado + cota BR fora do cache');
add('fk-003', {
  op: 'filterKnown', cached: [A], cachedOnly: true, showUncachedBr: false, brReservedSlots: 1,
  streams: [st('gc', A, { br: false }), st('bru', C, { br: true, dubbed: true })],
}, 'showUncachedBr=false: só o cacheado');
add('fk-004', {
  op: 'filterKnown', cached: [A], cachedOnly: true, showUncachedBr: true, brReservedSlots: 1,
  streams: [st('brc', A, { br: true, dubbed: true }), st('bru', B, { br: true, dubbed: true })],
}, 'BR já cacheado desconta a vaga P2P');
add('fk-005', {
  op: 'filterKnown', cached: [A], cachedOnly: true, known: true,
  streams: [st('c', A, { br: false }), st('u', B, { br: false }), st('m', C, { br: false })],
}, 'known=true remove não-cacheados');
add('fk-006', {
  op: 'filterKnown', cached: [A], cachedOnly: true, known: false, missHashes: [C],
  streams: [st('c', A, { br: false }), st('u', B, { br: false }), st('m', C, { br: false })],
}, 'known=false + miss: só o miss confirmado cai');
add('fk-007', {
  op: 'filterKnown', cached: [A], cachedOnly: true, known: false,
  streams: [st('c', A, { br: false }), st('u', B, { br: false }), st('m', C, { br: false })],
}, 'known=false sem miss: nada cai');
add('fk-008', {
  op: 'filterKnown', cached: [A], cachedOnly: false, known: false, missHashes: [C],
  streams: [st('c', A, { br: false }), st('u', B, { br: false }), st('m', C, { br: false })],
}, 'cachedOnly=false: nada cai');
add('fk-009', {
  op: 'filterKnown', cachedOnly: true, showUncachedBr: true, brReservedSlots: 1, known: false, missHashes: [C],
  streams: [st('brm', C, { br: true, dubbed: true })],
}, 'vaga BR visível sobrevive mesmo constando em missHashes');

const corpus = {
  version: 'corpus-autofetch-picks/1',
  note: 'Cascata de picks do autofetch BR (src/utils/autofetch-picks.ts), medida no dist vivo pelo oráculo isolado. Ops: pickBr/pickAny/pickTop → {"ids":[...],"stable":true}; hasCachedBr/hasCachedAny/canAutoFetch → {"value":bool,"stable":true}; cachedTargets → {"qualities":[...],"stable":true}; uncachedBr → {"ids":[...],"stable":true} (ordem de seleção, casca original); filterKnown → {"ids":[...],"visibleBr":[...],"stable":true}. pickBrDubbedByTargetQualities já é coberto pelo golden br-pool-selection; brListableDubPool/pickFromPool não são exportados pelo TS e entram via uncachedBr/filterKnown/pickers.',
  cases,
};

fs.writeFileSync(OUT, Buffer.from(`${JSON.stringify(corpus, null, 2)}\n`, 'utf8'));
console.log(`[corpus] autofetch-picks: ${cases.length} casos → scripts/golden/corpus-autofetch-picks.json`);
