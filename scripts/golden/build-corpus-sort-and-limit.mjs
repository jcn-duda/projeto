#!/usr/bin/env node
/**
 * Corpus do golden `stream-ranking-sort` â€” `sortAndLimit` de
 * `src/utils/stream-ranking.ts`. Gera `corpus-sort-and-limit.json` com casos
 * determinÃ­sticos cobrindo: filtro de nulos, dedupe+trace, mentiroso, piso de
 * seeders com waiver BR dublado (debrid), whitelist de qualidade com
 * Ãºltimo-recurso (qualityRelaxed), CAM, tamanho, ordenaÃ§Ã£o completa (episÃ³dio
 * exato, qualidade, preferDubbed, prioridade de indexer, instant), pool
 * ampliado (cotas/reserva BR), DUAL, multiWork/pack e maxResults curto.
 *
 * Uso: `node scripts/golden/build-corpus-sort-and-limit.mjs` (grava no repo).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts', 'golden', 'corpus-sort-and-limit.json');

let seq = 0;
const hash = (tag) => tag.toLowerCase().padEnd(40, '0').slice(0, 40);

/** Stream de teste com o formato pÃ³s-`toStremioStream` (campos `_*` setados). */
function stream(tag, name, extra = {}) {
  seq += 1;
  return {
    infoHash: hash(`s${seq}${tag}`),
    name,
    title: extra.title ?? name.replace(/\n.*$/, ''),
    _seeders: 30,
    _quality: '1080p',
    _size: 2 * 1024 ** 3,
    _bytes: 2 * 1024 ** 3,
    _br: false,
    _dubClaim: false,
    _dubbed: false,
    _lied: false,
    ...extra,
  };
}

const DEFAULT_OPTS = { maxResults: 40 };
const cases = [];
const add = (id, streams, options = {}, instantHashes = []) => {
  cases.push({ id, input: JSON.stringify({ streams, options: { ...DEFAULT_OPTS, ...options }, instantHashes }) });
};

// â”€â”€ vazio e nulos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-01', []);
add('s-02', [null, stream('a', 'Ãšnico'), null]);

// â”€â”€ dedupe dentro + trace â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const h = hash('dupesame');
  add('s-03', [stream('d1', 'Fraco\nðŸ‘¤ 5', { infoHash: h, _seeders: 5 }), stream('d2', 'Forte\nðŸ‘¤ 50', { infoHash: h, _seeders: 50 })]);
  add('s-04', [
    stream('e1', 'Lied DUAL', { _lied: true, _dubbed: true, _dubClaim: true, _seeders: 80 }),
    stream('e2', 'Clean EN', { _seeders: 20 }),
  ], {}, []);
}

// â”€â”€ mentiroso â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-05', [
  stream('lie', 'Mentiroso', { _lied: true, _seeders: 500 }),
  stream('ok', 'Honesto', { _seeders: 10 }),
]);

// â”€â”€ piso de seeders + waiver BR (debrid: cache toca sem swarm) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-06', [
  stream('wbr', 'Filme.2024.DUBLADO.PT.BR', { _br: true, _dubClaim: true, _seeders: 0 }),
  stream('wen', 'Movie.2024.1080p', { _seeders: 0 }),
  stream('ok', 'Seeded', { _seeders: 25 }),
], { minSeeders: 5 });
add('s-07', [
  stream('dualamb', 'Filme DUAL', { _br: true, _seeders: 0 }),
  stream('provdub', 'Filme DUBLADO', { _br: true, _dubbed: true, _seeders: 0 }),
], { minSeeders: 5 });
add('s-08', [
  stream('lienobr', 'DUBLADO mentira', { _dubClaim: true, _lied: true, _seeders: 0 }),
  stream('foreign', 'Movie DUAL FRENCH', { _br: true, _dubClaim: true, _seeders: 0, title: 'Movie.2024.DUAL.FRENCH.1080p' }),
], { minSeeders: 5 });
add('s-09', [
  stream('waived', 'DUBLADO waived', { _br: true, _dubClaim: true, _seeders: 0 }),
], { minSeeders: 5, maxResults: 40 });
// waiver cortado depois pelo pool (a marca sÃ³ vai em quem sobrevive)
add('s-10', [
  stream('w2', 'DUBLADO fracasso', { _br: true, _dubClaim: true, _seeders: 0 }),
  stream('s2', 'Seeded A', { _seeders: 90 }),
  stream('s3', 'Seeded B', { _seeders: 80 }),
], { minSeeders: 5, maxResults: 2 });

// â”€â”€ whitelist de qualidade e Ãºltimo recurso â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-11', [
  stream('hd', 'Movie 1080p', { _quality: '1080p' }),
  stream('fhd', 'Movie 2160p', { _quality: '2160p' }),
], { qualityFilter: ['1080p'] });
add('s-12', [
  stream('sd1', 'Movie DVDRip', { _quality: 'SD', _seeders: 10 }),
  stream('sd2', 'Movie WEBRip', { _quality: 'SD', _seeders: 20 }),
], { qualityFilter: ['1080p', '720p'] });
add('s-13', [
  stream('sd', 'Movie SD', { _quality: 'SD' }),
], { qualityFilter: ['1080p'] });
add('s-14', [
  stream('unknown', 'Movie WEB-DL', { _quality: 'sem resoluÃ§Ã£o' }),
], { qualityFilter: ['1080p'] });
add('s-15', [
  stream('bruk', 'Filme nacional', { _quality: 'sem resoluÃ§Ã£o', _br: true, _dubbed: true }),
], { qualityFilter: ['1080p'], qualityLimits: { 'sem resoluÃ§Ã£o': 0 } });
add('s-16', [
  stream('bruk2', 'Filme nacional', { _quality: 'sem resoluÃ§Ã£o', _br: true, _dubbed: true }),
], { qualityFilter: ['1080p'], qualityLimits: { 'sem resoluÃ§Ã£o': 3 } });
add('s-17', [
  stream('alias', 'Movie 4K', { _quality: '2160p' }),
], { qualityFilter: ['4K'] });
add('s-18', [
  stream('sdcam', 'Movie CAM', { _quality: 'SD', title: 'Movie.2024.CAM' }),
  stream('sdok', 'Movie SD ok', { _quality: 'SD' }),
], { qualityFilter: ['1080p'], excludeCam: true });
add('s-19', [
  stream('big', 'Movie grande', { _quality: 'SD', _size: 60 * 1024 ** 3 }),
], { qualityFilter: ['1080p'], maxSizeGb: 50 });

// â”€â”€ CAM e tamanho fora do Ãºltimo recurso â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-20', [
  stream('cam', 'Movie CAM dn', { title: 'Movie.2024.1080p', _magnetDn: 'Movie.2024.CAM' }),
], { excludeCam: true });
add('s-21', [
  stream('camdn', 'Movie CAM sÃ³ no dn', { title: 'Movie limpo', _magnetDn: 'cam.copy.2024' }),
  stream('tit', 'Movie CAM no tÃ­tulo', { title: 'Movie.2024.CAMRip' }),
], { excludeCam: true });
add('s-22', [
  stream('nosize', 'Sem tamanho', { _size: 0, _bytes: 0 }),
], { maxSizeGb: 1 });
add('s-23', [
  stream('fits', 'Cabe', { _size: 1024 ** 3 }),
  stream('nofit', 'NÃ£o cabe', { _size: 3 * 1024 ** 3 }),
], { maxSizeGb: 2 });

// â”€â”€ ordenaÃ§Ã£o completa â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-24', [
  stream('e5', 'S01E05 pack', { title: 'Serie.S01E05.1080p', _quality: '1080p' }),
  stream('pack', 'Season pack', { title: 'Serie.S01.1080p.COMPLETE', _quality: '1080p' }),
  stream('e5b', 'S01E05 outro', { title: 'Serie.S01E05.720p', _quality: '720p' }),
], { season: 1, episode: 5 });
add('s-25', [
  stream('q1', '480p', { _quality: '480p', _seeders: 900 }),
  stream('q2', 'SD', { _quality: 'SD', _seeders: 900 }),
  stream('q3', '720p', { _quality: '720p', _seeders: 1 }),
  stream('q4', '1080p', { _quality: '1080p', _seeders: 1 }),
  stream('q5', '2160p', { _quality: '2160p', _seeders: 1 }),
  stream('q6', 'sem resoluÃ§Ã£o', { _quality: 'sem resoluÃ§Ã£o', _seeders: 900 }),
]);
add('s-26', [
  stream('unk', 'WEB-DL BR', { _quality: 'sem resoluÃ§Ã£o', _seeders: 1 }),
  stream('sd', 'SD', { _quality: 'SD', _seeders: 1 }),
  stream('hd', '720p', { _quality: '720p', _seeders: 1 }),
]);
add('s-27', [
  stream('dub10', 'Dublado 10', { _dubbed: true, _seeders: 10 }),
  stream('en500', 'EN 500', { _seeders: 500 }),
], { preferDubbed: true });
add('s-28', [
  stream('dub10', 'Dublado 10', { _dubbed: true, _seeders: 10 }),
  stream('en500', 'EN 500', { _seeders: 500 }),
]);
add('s-29', [
  stream('idx1', 'YTS mais seeds', { _seeders: 100, _indexer: 'yts' }),
  stream('idx2', 'BLUDV', { _seeders: 10, _indexer: 'bludv' }),
], { indexerPriority: ['bludv', 'yts'] });
add('s-30', [
  stream('idx1', 'YTS mais seeds', { _seeders: 100, _indexer: 'yts' }),
  stream('idx2', 'BLUDV', { _seeders: 10, _indexer: 'bludv' }),
]);
add('s-31', [
  stream('a', 'Sem prioridade A', { _seeders: 10, _indexer: 'zik' }),
  stream('b', 'Sem prioridade B', { _seeders: 20, _indexer: 'yts' }),
], { indexerPriority: ['bludv'] });
add('s-32', [
  stream('lied', 'Mentiroso mesma q', { _lied: true, _quality: '1080p', _seeders: 100 }),
  stream('clean', 'Limpo mesma q', { _quality: '1080p', _seeders: 1 }),
]);

// â”€â”€ instant (hash comprovado no banco de magnets) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const hi = hash('instanhash');
  add('s-33', [
    stream('seeds', 'Muitos seeds', { _seeders: 300 }),
    stream('inst', 'Instant', { infoHash: hi, _seeders: 3 }),
  ], {}, [hi]);
  // instant nÃ£o vence qualidade nem prioridade
  add('s-34', [
    stream('inst', 'Instant 720p', { infoHash: hi, _quality: '720p' }),
    stream('q', '1080p comum', { _quality: '1080p' }),
  ], {}, [hi]);
  add('s-35', [
    stream('inst', 'Instant bludv', { infoHash: hi, _seeders: 50, _indexer: 'bludv' }),
    stream('prio', 'Outro bludv', { _seeders: 50, _indexer: 'bludv' }),
  ], { indexerPriority: ['bludv'] }, [hi]);
}

// â”€â”€ pool ampliado (cotas por qualidade + reserva BR) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-36', [
  stream('u1', '4K a', { _quality: '2160p', _seeders: 10 }),
  stream('u2', '4K b', { _quality: '2160p', _seeders: 9 }),
  stream('u3', '4K c', { _quality: '2160p', _seeders: 8 }),
  stream('f1', '1080p a', { _quality: '1080p', _seeders: 7 }),
  stream('f2', '1080p b', { _quality: '1080p', _seeders: 6 }),
  stream('f3', '1080p c', { _quality: '1080p', _seeders: 5 }),
], { maxResults: 4, qualityLimits: { '2160p': 1, '1080p': 1 } });
add('s-37', [
  stream('br1', 'BR dublado a', { _br: true, _dubbed: true, _quality: '1080p', _seeders: 2 }),
  stream('br2', 'BR dublado b', { _br: true, _dubClaim: true, _quality: '720p', _seeders: 2 }),
  stream('en1', 'EN forte', { _seeders: 100 }),
  stream('en2', 'EN forte 2', { _seeders: 90 }),
  stream('en3', 'EN forte 3', { _seeders: 80 }),
], { maxResults: 3, brReservedSlots: 2 });
add('s-38', [
  stream('br1', 'BR 1080', { _br: true, _dubbed: true, _quality: '1080p', _seeders: 2 }),
  stream('br2', 'BR 1080 b', { _br: true, _dubbed: true, _quality: '1080p', _seeders: 2 }),
  stream('br3', 'BR 720', { _br: true, _dubbed: true, _quality: '720p', _seeders: 2 }),
  stream('en1', 'EN a', { _seeders: 100 }),
  stream('en2', 'EN b', { _seeders: 99 }),
  stream('en3', 'EN c', { _seeders: 98 }),
  stream('en4', 'EN d', { _seeders: 97 }),
], { maxResults: 4, brReservedPerQuality: 1, brReservedSlots: 3 });
add('s-39', [
  stream('liedbr', 'BR mentiroso', { _br: true, _dubbed: true, _lied: true, _seeders: 50 }),
  stream('br1', 'BR limpo', { _br: true, _dubbed: true, _seeders: 2 }),
  stream('en1', 'EN a', { _seeders: 40 }),
  stream('en2', 'EN b', { _seeders: 30 }),
], { maxResults: 2, brReservedSlots: 1 });
add('s-40', [
  stream('u1', '4K a', { _quality: '2160p', _seeders: 10 }),
  stream('u2', '4K b', { _quality: '2160p', _seeders: 9 }),
  stream('u3', '4K c', { _quality: '2160p', _seeders: 8 }),
  stream('u4', '4K d', { _quality: '2160p', _seeders: 7 }),
  stream('f1', '1080p a', { _quality: '1080p', _seeders: 6 }),
  stream('f2', '1080p b', { _quality: '1080p', _seeders: 5 }),
], { maxResults: 3, qualityLimits: { '2160p': 2 }, candidateFactor: 2 });
add('s-41', [
  stream('br1', 'BR a', { _br: true, _dubbed: true, _seeders: 5 }),
  stream('en1', 'EN a', { _seeders: 50 }),
  stream('en2', 'EN b', { _seeders: 40 }),
], { maxResults: 2, brReservedSlots: 2, brFirst: false });
add('s-42', [
  stream('lienobr2', 'Mentiroso', { _lied: true, _seeders: 100 }),
  stream('br1', 'BR a', { _br: true, _dubbed: true, _seeders: 5 }),
], { maxResults: 1, brReservedSlots: 1 });

// â”€â”€ DUAL / heranÃ§a do dedupe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const h = hash('mirrorbr');
  add('s-43', [
    stream('mirror', 'A.Rocha.1996.BluRay.1080p.x264.DUAL.2.0-STARCKFILMES', {
      infoHash: h, _seeders: 60, title: 'A.Rocha.1996.BluRay.1080p.x264.DUAL.2.0-STARCKFILMES',
    }),
    stream('post', 'A Rocha [1080p DUAL 2.80 GB]', {
      infoHash: h, _br: true, _dubClaim: true, _seeders: 10, name: 'A Rocha (1996) DUBLADO\nðŸ‘¤ 10',
    }),
  ], { brReservedSlots: 1, maxResults: 2 });
  add('s-44', [
    stream('mirror', 'Coyote.Vs.Acme.2026.1080p.WEBRip.Dub', {
      infoHash: hash('genericdub'), _seeders: 160,
    }),
    stream('post', 'Coyote vs Acme [1080p DUBLADO 4.26 GB]', {
      infoHash: hash('genericdub'), _br: true, _dubClaim: true, _seeders: 5,
    }),
  ], { brReservedSlots: 1, maxResults: 2 });
  add('s-45', [
    stream('mirror', 'Movie.2024.DUAL.Latino', { infoHash: hash('latinodub'), _seeders: 100 }),
    stream('post', 'Movie [1080p DUBLADO]', { infoHash: hash('latinodub'), _br: true, _dubClaim: true, _seeders: 5 }),
  ], { brReservedSlots: 1, maxResults: 2 });
}

// â”€â”€ multiWork / pack â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-46', [
  stream('pack', 'Colecao COMPLETA', { _multiWork: true, _multiWorkAdmitted: true, _seeders: 5 }),
  stream('ep', 'Episodio certo', { title: 'Serie.S01E03.1080p', _seeders: 4 }),
], { season: 1, episode: 3 });
add('s-47', [
  stream('pack1', 'Pack A', { _multiWork: true }),
  stream('pack2', 'Pack B', { _multiWork: true, infoHash: hash('packtwo'), _seeders: 31 }),
]);
{
  // marca _multiWork sobrevive ao merge do dedupe (QUALQUER lado marcado)
  const h = hash('packmerge');
  add('s-48', [
    stream('p1', 'Pack EN', { infoHash: h, _seeders: 50 }),
    stream('p2', 'Colecao BR', { infoHash: h, _multiWork: true, _br: true, _dubClaim: true, _seeders: 5 }),
  ]);
}

// â”€â”€ maxResults curto e travas vÃ¡rias â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-49', [
  stream('a', 'A', { _seeders: 5 }),
  stream('b', 'B', { _seeders: 4 }),
  stream('c', 'C', { _seeders: 3 }),
], { maxResults: 2 });
add('s-50', [
  stream('a', 'A', { _seeders: 0 }),
  stream('b', 'B', { _seeders: 0 }),
], { minSeeders: 1 });

// â”€â”€ cachedOnly simulado via instant? nÃ£o â€” cenÃ¡rio de debrid: tudo em cache
// (instant) e piso dispensado para BR; interaÃ§Ã£o instant Ã— waiver â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const h1 = hash('cachedbra');
  add('s-51', [
    stream('cbr', 'BR dublado em cache', { infoHash: h1, _br: true, _dubClaim: true, _seeders: 0 }),
    stream('cen', 'EN cache com seeds', { _seeders: 40 }),
    stream('p2p', 'EN p2p fraco', { _seeders: 0 }),
  ], { minSeeders: 5, preferDubbed: true }, [h1]);
  add('s-52', [
    stream('i1', 'cache 1080p', { infoHash: hash('cachio'), _quality: '1080p', _seeders: 0 }),
    stream('i2', 'cache 720p', { infoHash: hash('cach720'), _quality: '720p', _seeders: 0 }),
  ], { minSeeders: 5 }, [hash('cachio'), hash('cach720')]);
}

// â”€â”€ ordem de empate preservada (sort estÃ¡vel) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-53', [
  stream('t1', 'Empate A', { _seeders: 10 }),
  stream('t2', 'Empate B', { _seeders: 10 }),
  stream('t3', 'Empate C', { _seeders: 10 }),
]);

// â”€â”€ campos extras do Stream preservados (spread do TS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add('s-54', [
  stream('x', 'Com url e behaviorHints', { url: 'https://tracker/dl/x', behaviorHints: { openVideo: true }, source: 'bludv' }),
]);

// â”€â”€ combinado: filtro + waiver + cotas + instant num caso sÃ³ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const hc = hash('comboinst');
  add('s-55', [
    stream('c1', 'BR dublado cache', { infoHash: hc, _br: true, _dubbed: true, _quality: '1080p', _seeders: 0 }),
    stream('c2', 'BR 720 disco', { _br: true, _dubClaim: true, _quality: '720p', _seeders: 2 }),
    stream('c3', 'EN 1080 forte', { _quality: '1080p', _seeders: 200 }),
    stream('c4', 'EN 4K', { _quality: '2160p', _seeders: 150 }),
    stream('c5', 'Mentiroso', { _lied: true, _dubbed: true, _br: true, _seeders: 500 }),
    stream('c6', 'CAM lixo', { title: 'Movie.2024.CAM', _seeders: 100 }),
  ], {
    minSeeders: 3, preferDubbed: true, excludeCam: true, maxResults: 4,
    brReservedSlots: 2, indexerPriority: ['bludv'],
  }, [hc]);
}

// â”€â”€ bloco extra: interaÃ§Ãµes finas (meta: ~80 casos) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ãºltimo recurso escapa das cotas de qualityLimits (preÃ§o de nÃ£o voltar vazio)
add('s-69', [
  stream('sd', 'SD resgatado', { _quality: 'SD', _seeders: 5 }),
], { qualityFilter: ['2160p'], qualityLimits: { '2160p': 2 } });
// seedFloor waiver com title ausente (usa name) no guarda de Ã¡udio
add('s-70', [
  stream('wn', 'Filme.DUBLADO.1080p', { title: '', _br: true, _dubbed: true, _seeders: 0 }),
], { minSeeders: 5 });
// lie no pÃ³s-dedupe: merge espalha a mentira para o clone limpo
{
  const h = hash('lieprop');
  add('s-71', [
    stream('l', 'Mentiroso 200', { infoHash: h, _lied: true, _dubbed: true, _seeders: 200 }),
    stream('c', 'Limpo 30', { infoHash: h, _seeders: 30 }),
  ], { minSeeders: 50 });
}
// cam no dn NÃO corta sem excludeCam
add('s-72', [
  stream('dn', 'CAM sÃ³ no dn', { title: 'Movie limpo', _magnetDn: 'cam.rip.2024' }),
]);
// maxSizeGb com _size ausente segue visÃ­vel
add('s-73', [
  stream('nos', 'Sem tamanho', { _size: 0, _bytes: 0 }),
  stream('big', 'Grande demais', { _size: 9 * 1024 ** 3 }),
], { maxSizeGb: 5 });
// episodio exato empata e cai para qualidade, depois seeders
add('s-74', [
  stream('e720', 'E12 720 forte', { title: 'Serie.S01E12.720p', _quality: '720p', _seeders: 300 }),
  stream('e1080', 'E12 1080 fraco', { title: 'Serie.S01E12.1080p', _quality: '1080p', _seeders: 1 }),
  stream('pack', 'Pack S01', { title: 'Serie.S01.COMPLETE', _quality: '1080p', _seeders: 900 }),
], { season: 1, episode: 12 });
// preferDubbed com dubClaim (promessa) tambÃ©m sobe
add('s-75', [
  stream('claim', 'Promessa dub', { _dubClaim: true, _seeders: 10 }),
  stream('en', 'EN 400', { _seeders: 400 }),
], { preferDubbed: true });
// indexerPriority com nomes repetidos/empty (priorityMap ignora)
add('s-76', [
  stream('a', 'A zik', { _indexer: 'zik', _seeders: 10 }),
  stream('b', 'B bludv', { _indexer: 'bludv', _seeders: 10 }),
  stream('c', 'C yts', { _indexer: 'yts', _seeders: 10 }),
], { indexerPriority: ['bludv', '', 'bludv', 'zik'] });
// instant em todos: empate cai para seeders
{
  const hs = [hash('iall'), hash('ibll2')];
  add('s-77', [
    stream('a', 'Instant 5', { infoHash: hs[0], _seeders: 5 }),
    stream('b', 'Instant 50', { infoHash: hs[1], _seeders: 50 }),
  ], {}, hs);
}
// pool ampliado: BR nÃ£o conta cota custom de qualidade duplicada
add('s-78', [
  stream('br1', 'BR 1080 forte', { _br: true, _dubbed: true, _quality: '1080p', _seeders: 90 }),
  stream('br2', 'BR 1080 fraco', { _br: true, _dubbed: true, _quality: '1080p', _seeders: 3 }),
  stream('e1', 'EN 1080 a', { _quality: '1080p', _seeders: 80 }),
  stream('e2', 'EN 1080 b', { _quality: '1080p', _seeders: 70 }),
  stream('e3', 'EN 1080 c', { _quality: '1080p', _seeders: 60 }),
], { maxResults: 3, qualityLimits: { '1080p': 2 }, brReservedSlots: 2 });
// brFirst default vs false com vaga cheia
add('s-79', [
  stream('br', 'BR Ãºnico', { _br: true, _dubbed: true, _seeders: 1 }),
  stream('e1', 'EN a', { _seeders: 100 }),
  stream('e2', 'EN b', { _seeders: 99 }),
], { maxResults: 2, brReservedSlots: 1 });
// minSeeders negativo (nada corta) e NaN-safe
add('s-80', [
  stream('a', 'A 0 seeds', { _seeders: 0 }),
  stream('b', 'B 1 seed', { _seeders: 1 }),
], { minSeeders: -1 });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const letter = (n) => `s-${String(n + 56).padStart(2, '0')}`;
// â”€â”€ episÃ³dio Ã— pack varindo season/episode nulos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add(letter(0), [
  stream('e1', 'S02E10 exato', { title: 'Serie.S02E10.1080p' }),
  stream('e2', 'S02E09 vizinho', { title: 'Serie.S02E09.1080p' }),
], { season: 2, episode: 10 });
add(letter(1), [
  stream('e1', 'S01E01 exato', { title: 'Serie.S01E01' }),
], { season: null, episode: null, preferDubbed: false });
add(letter(2), [
  stream('e1', 'Episodio 12', { title: 'Serie.S01E12' }),
  stream('e2', 'Episodio 12 duplo', { title: 'Serie.S01E11-E12' }),
], { season: 1, episode: 12 });
// â”€â”€ dubbedOnly presente mas ignorado (void no TS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add(letter(3), [
  stream('en', 'EN com seeds', { _seeders: 30 }),
  stream('dub', 'Dublado', { _dubbed: true, _seeders: 3 }),
], { dubbedOnly: true });
// â”€â”€ qualityLimits nÃ£o corta quem nÃ£o estÃ¡ no conjunto custom â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add(letter(4), [
  stream('u', '4K', { _quality: '2160p', _seeders: 10 }),
  stream('s', 'SD', { _quality: 'SD', _seeders: 9 }),
], { maxResults: 1, qualityLimits: { '2160p': 1 } });
// â”€â”€ reserva BR ignora sem resoluÃ§Ã£o do global â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add(letter(5), [
  stream('bruk', 'BR sem resoluÃ§Ã£o', { _br: true, _dubbed: true, _quality: 'sem resoluÃ§Ã£o', _seeders: 5 }),
  stream('en', 'EN hd', { _quality: '1080p', _seeders: 50 }),
], { maxResults: 2, brReservedSlots: 1 });
// â”€â”€ P2P BR de seeders baixÃ­ssimos no pool ampliado â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add(letter(6), [
  stream('br1', 'BR seed 1', { _br: true, _dubbed: true, _seeders: 1 }),
  stream('br2', 'BR seed 2', { _br: true, _dubClaim: true, _seeders: 2 }),
  stream('en', 'EN seed 1000', { _seeders: 1000 }),
], { minSeeders: 0, maxResults: 3, brReservedSlots: 2, brReservedPerQuality: 1 });
// â”€â”€ dedupe herda seeders mÃ¡ximos e o vencedor limpo entra â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const h = hash('seedmerge');
  add(letter(7), [
    stream('a', 'Limpo 20', { infoHash: h, _seeders: 20 }),
    stream('b', 'Mentiroso 90', { infoHash: h, _lied: true, _dubbed: true, _seeders: 90 }),
  ]);
}
// â”€â”€ quality filter case-insensitive com aliases mistos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add(letter(8), [
  stream('a', 'UHD release', { _quality: '2160p' }),
  stream('b', 'Full HD', { _quality: '1080p' }),
], { qualityFilter: ['UHD'] });
// â”€â”€ nome com quebra de linha: label do trace usa a 1Âª linha â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add(letter(9), [
  stream('m', 'Mentiroso rotulado\nðŸ‘¤ 500', { _lied: true, _seeders: 500 }),
  stream('v', 'VÃ­tima do piso\nðŸ‘¤ 0', { _seeders: 0 }),
], { minSeeders: 1 });
// â”€â”€ todos fora (tudo cortado) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
add(letter(10), [
  stream('c', 'CAM', { title: 'Movie.CAM' }),
], { excludeCam: true, maxSizeGb: 1 });
add(letter(11), [
  stream('s', 'SD fora', { _quality: 'SD' }),
], { qualityFilter: ['2160p'] });

fs.writeFileSync(OUT, `${JSON.stringify({ cases }, null, 2)}\n`);
console.log(`[corpus] ${cases.length} casos â†’ ${path.relative(REPO, OUT)}`);
