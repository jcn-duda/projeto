// Fase 5 — alcance do dublado BR, com os títulos REAIS medidos em produção
// (The Dead Zone / "A Hora da Zona Morta", tt0085407). Cada caso ancora um
// commit da fase: b867c13 (dublado com `_`, contracção pt-BR e CAM lido no dn
// do magnet) e 7f5d5ef (proteção `isBr || dubbed` no corte do índice, revisada
// depois com o teto de proteção 2/3). O caso da via instantânea do banco
// (efd6f2c) saiu no R4: índice e banco são NATIVOS no Rust, e o TS não tem
// mais `collectInstantItems`.
// Teste puro: sem rede, sem servidor, sem src/addon.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { audioFromTitle } from '../src/utils/audio-quality.js';
import { applyPtTitleDual } from '../src/providers/pt-title-dual.js';
import { record, lookup, clearIdxStore } from '../src/utils/release-index.js';
import { toStremioStream } from './helpers/pipeline-oracle/format.js';
import type { RawItem } from '../types/domain.js';

const IMDB = 'tt0085407';
const TITLE_DUAL = 'A Hora Da Zona Morta 1983 720p BluRay x264 DUAL_Misso';
const TITLES = { pt: 'Na Hora da Zona Morta', en: 'The Dead Zone', original: 'The Dead Zone' };

const hex = (c: string) => c.repeat(40);

function raw(title: string, extra: Partial<RawItem> = {}): RawItem {
  return { title, infoHash: hex('a'), seeders: 5, ...extra };
}

// ─── 1. audioFromTitle: o `_` do kickass não mata o marcador ────────────────

test('audioFromTitle: DUAL colado no `_` vira Dual; LEGENDADO_Misso vira Legendado', () => {
  // O `_` é separador na prática (kickass): o classificador precisa ver "DUAL"
  // onde o post escreveu "DUAL_Misso".
  assert.equal(audioFromTitle(TITLE_DUAL), 'Dual');
  assert.equal(
    audioFromTitle('A Hora Da Zona Morta 1983 720p BluRay x264 LEGENDADO_Misso'),
    'Legendado',
  );
});

// ─── 2. applyPtTitleDual: contracção pt-BR e guardas ────────────────────────

test('applyPtTitleDual: contracção "Na" do TMDB marca o post "A Hora Da …" DUAL', () => {
  // pt "Na Hora da Zona Morta" × post "A Hora Da Zona Morta": o strip de
  // artigo/contracção dos DOIS lados casa o título — é o caso medido.
  const [out] = applyPtTitleDual([raw(TITLE_DUAL)], { titles: TITLES });
  assert.equal(out.ptTitleDual, true);
});

test('applyPtTitleDual: pt largo, LEGENDADO DUAL e MULTI ficam de fora', () => {
  // Guarda de 2+ tokens: "A Rocha" (2 tokens) não herda "A Rocha Queimada".
  const [broad] = applyPtTitleDual([raw('A Rocha Queimada Dual')], { titles: { pt: 'A Rocha' } });
  assert.equal(broad.ptTitleDual, undefined, 'título curto do TMDB não marca post mais largo');
  // Botão legendado não ganha vaga BR, mesmo com DUAL colado.
  const [sub] = applyPtTitleDual(
    [raw('A Hora Da Zona Morta 1983 1080p LEGENDADO DUAL')],
    { titles: TITLES },
  );
  assert.equal(sub.ptTitleDual, undefined, 'LEGENDADO derruba a marca');
  // MULTI sozinho é faixa multiidioma, não dublagem BR.
  const [multi] = applyPtTitleDual([raw('A Hora Da Zona Morta 1983 1080p MULTI')], { titles: TITLES });
  assert.equal(multi.ptTitleDual, undefined, 'MULTI sozinho não marca');
});

// ─── 3. release-index: proteção BR/dublado no corte do teto (7f5d5ef; cap 2/3) ───

test('record: BR/dublado antigo sobrevive ao corte; globais antigos saem', () => {
  // Desvio mecânico necessário, registrado: `record` carimba `seenAt = now`
  // para TODOS os itens da chamada (release-index.ts:140 — um `now` por
  // chamada), então "N globais com seenAt distintos numa única chamada" é
  // impossível. Os N globais entram em chamadas passo a passo com o relógio
  // mockado; a CHAMADA ÚNICA final insere os 2 BR/dublados com relógio BEM
  // antigo (10 dias) e é ela que dispara o corte N+2 → N. O que se prova — a
  // ordenação que protege `isBr || dubbed` antes de olhar `seenAt`
  // (release-index.ts:148-151) — é exatamente o comportamento da Fase 2.
  const realNow = Date.now;
  const savedEnabled = config.releaseIndex.enabled;
  const base = realNow();
  const max = Math.trunc(Number(config.releaseIndex.maxReleases) || 60);
  const globalHash = (i: number) => i.toString(16).padStart(2, '0').repeat(20);
  const brHash = hex('e');
  const dubbedHash = hex('f');
  try {
    config.releaseIndex.enabled = true;
    let nowMs = base - 2 * 3600_000;
    for (let i = 0; i < max; i += 1) {
      Date.now = () => nowMs;
      record(IMDB, {}, [
        { title: `Relevo Global ${i} 1080p`, infoHash: globalHash(i), seeders: 10, indexer: 'globaltracker' },
      ]);
      nowMs += 60_000;
    }
    // Relógio BEM antigo: sem a proteção, os 2 seriam os primeiros cortados.
    Date.now = () => base - 10 * 86_400_000;
    record(IMDB, {}, [
      { title: 'A Hora da Zona Morta 1983 720p BluRay x264 DUAL_Misso', infoHash: brHash, seeders: 5, indexer: 'apachetorrent-cardigann', isBr: true },
      { title: 'A Hora da Zona Morta 1983 1080p DUBLADO', infoHash: dubbedHash, seeders: 4, indexer: 'comandotorrents' },
    ]);
    Date.now = () => base;
    const out = lookup(IMDB);
    const hashes = new Set(out.map((r) => r.hash));
    assert.equal(out.length, max, 'a obra fica limitada ao teto');
    assert.equal(out.find((r) => r.hash === brHash)?.isBr, true, 'BR antigo preserva a flag');
    assert.equal(out.find((r) => r.hash === dubbedHash)?.dubbed, true, 'dublado antigo preserva a flag');
    assert.ok(hashes.has(brHash), 'BR antigo não cai no corte do teto');
    assert.ok(hashes.has(dubbedHash), 'dublado antigo não cai no corte do teto');
    assert.ok(!hashes.has(globalHash(0)), 'o global mais antigo foi cortado');
    assert.ok(!hashes.has(globalHash(1)), 'o 2º global mais antigo foi cortado');
    assert.ok(hashes.has(globalHash(max - 1)), 'o global mais novo sobreviveu');
  } finally {
    Date.now = realNow;
    config.releaseIndex.enabled = savedEnabled;
  }
});

test('record: teto de proteção — excedente BR não estrela o global novo da obra', () => {
  // Revisão do 7f5d5ef: proteger BR/dublado SEM limite fazia uma obra com mais
  // BR do que vagas (série longa) expulsar TODO global recém-visto — o global
  // era o (max+1)º da ordem (BR primeiro) e o corte o descartava. O cap 2/3
  // reserva as vagas finais para o fluxo global; o excedente protegido só
  // preenche o que sobrar (obra que só tem BR não encolhe).
  const realNow = Date.now;
  const savedEnabled = config.releaseIndex.enabled;
  const base = realNow();
  const max = Math.trunc(Number(config.releaseIndex.maxReleases) || 60);
  const protectedCap = Math.max(1, Math.floor(max * 2 / 3));
  const brHash = (i: number) => (i + 1).toString(16).padStart(2, '0').repeat(20);
  const novoGlobal = hex('9');
  try {
    config.releaseIndex.enabled = true;
    // O teste anterior compartilha o IMDB e deixa a chave cheia; limpar garante
    // o cenário exato (max+5 BR + 1 global) em vez de herdar estado alheio.
    clearIdxStore();

    // max+5 BR numa ÚNICA chamada: mesmo seenAt (um `now` por chamada), seeders
    // distintos desempatam. Sem o cap, as 60 vagas iam todas para BR.
    let nowMs = base;
    Date.now = () => nowMs;
    record(IMDB, {}, Array.from({ length: max + 5 }, (_, i) => ({
      title: `Serie Longa ${i + 1} 1080p DUBLADO`,
      infoHash: brHash(i),
      seeders: i + 1,
      indexer: 'apachetorrent-cardigann',
      isBr: true,
    })));

    // Relógio +1min: o global novo. Sem o teto de proteção ele seria o (max+1)º
    // da ordem e o corte o expulsaria — é a prova de regressão.
    nowMs += 60_000;
    Date.now = () => nowMs;
    record(IMDB, {}, [
      { title: 'Global Novo 1080p', infoHash: novoGlobal, seeders: 7, indexer: 'globaltracker' },
    ]);

    const out = lookup(IMDB);
    const hashes = new Set(out.map((r) => r.hash));
    assert.ok(hashes.has(novoGlobal), 'o global novo sobrevive ao corte (sem o teto sairia)');
    assert.equal(out.length, max, 'o índice segue cheio');
    const protegidas = out.filter((r) => r.isBr || r.dubbed).length;
    assert.ok(protegidas >= protectedCap, `protegidas preservadas (>= ${protectedCap}); veio ${protegidas}`);
    assert.ok(protegidas <= max, 'protegidas não passam do teto total');
  } finally {
    Date.now = realNow;
    config.releaseIndex.enabled = savedEnabled;
    // Devolve o balde vazio: o teste acima usa hashes determinísticos entre
    // runs e o BR fresco deste cenário (protegido, visto agora) expulsaria os
    // 2 BR antigos dele na execução seguinte. Balde limpo = teste acima estável.
    clearIdxStore();
  }
});

// ─── 4. CAM lido no dn= do magnet (b867c13) ─────────────────────────

test('toStremioStream: dn com CAMRip rotula CAM; dn sem CAM não rotula', () => {
  // O título do post esconde a gravação; o dn= preserva o nome real do
  // release (search-names.ts:122-126).
  const h = hex('a');
  const camItem: RawItem = {
    title: 'Resident Evil (2026) [1080p 2.60 GB]',
    infoHash: h,
    magnet: `magnet:?xt=urn:btih:${h}&dn=Resident.Evil.2026.CAMRip.1080p.XviD-AC3`,
    seeders: 5,
    indexer: 'comandotorrents',
  };
  const camStream = toStremioStream(camItem);
  assert.ok(camStream, 'item com hash tem ação');
  assert.match(String(camStream?.name || ''), /\bCAM\b/, 'CAM do dn aparece no name');
  const cleanStream = toStremioStream({
    ...camItem,
    magnet: `magnet:?xt=urn:btih:${h}&dn=Resident.Evil.2026.1080p.WEB-DL.x264-GRP`,
  });
  assert.ok(cleanStream, 'a contraprova também tem ação');
  assert.ok(!String(cleanStream?.name || '').includes('CAM'), 'dn sem CAM não rotula');
});
