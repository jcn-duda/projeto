#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-release-title-rules.json`: casos das funções
 * puras de `src/utils/release-title-rules.ts` (matchesTitleStructure,
 * shortNameIdentity, matchesShortNameIdentity). Gerador descartável do corpus;
 * o arquivo commitado é a fonte. Não lê dist nem config.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-release-title-rules.json');

const cases = [];
const add = (note, obj) => cases.push({ note, input: JSON.stringify(obj) });

// shortNameIdentity: skip (3+ tokens da base ou base vazia), no-token, prefix.
add('shortName: base de 1 token vira prefixo', { op: 'shortName', name: 'Fallout' });
add('shortName: base de 2 tokens com artigo pula o artigo', { op: 'shortName', name: 'The Boys' });
add('shortName: artigo e palavra curta saem do run', { op: 'shortName', name: 'Attack on Titan' });
add('shortName: 3 tokens longos é skip', { op: 'shortName', name: 'Resident Evil Vendetta' });
add('shortName: base de 3 tokens é skip mesmo com artigo', { op: 'shortName', name: 'Blade Runner 2049' });
add('shortName: palavra de 2 letras sem token nomeante é no-token', { op: 'shortName', name: 'It' });
add('shortName: palavra de 2 letras sozinha é no-token', { op: 'shortName', name: 'Up' });
add('shortName: nome vazio é skip', { op: 'shortName', name: '' });
add('shortName: nome só em outro script é skip ou no-token', { op: 'shortName', name: '光環' });
add('shortName: nome latino com acento vira prefixo', { op: 'shortName', name: 'Poção' });
add('shortName: Monster Hunter é prefixo com run de 2', { op: 'shortName', name: 'Monster Hunter' });
add('shortName: Scary Movie é prefixo com run de 2', { op: 'shortName', name: 'Scary Movie' });

// matchesShortNameIdentity: 1 ou 0 quando há prefixo; 1 quando o portão se cala.
add('identity: título começa pelo nome, sem etiqueta', { op: 'identity', title: 'Fallout S01E01 1080p', name: 'Fallout', own: null, dn: '' });
add('identity: primeiro token diferente sem prova = 0', { op: 'identity', title: 'Random Post 1080p', name: 'Halo', own: null, dn: '' });
add('identity: mesmo caso com dn que nomeia = 1', { op: 'identity', title: 'Post qualquer 1080p', name: 'Halo', own: null, dn: 'Halo S01E01 1080p' });
add('identity: dn que não nomeia também não salva = 0', { op: 'identity', title: 'Post qualquer 1080p', name: 'Halo', own: null, dn: 'Outro Titulo 1080p' });
add('identity: etiqueta de uploader no prefixo é removida', { op: 'identity', title: '[ReQ]True Detective s01e01 hdtv x264', name: 'True Detective', own: null, dn: '' });
add('identity: etiqueta www.site - é removida', { op: 'identity', title: 'www.UIndex.org - The Boys S05E01', name: 'The Boys', own: null, dn: '' });
add('identity: The Hardy Boys não nomeia The Boys = 0', { op: 'identity', title: 'The Hardy Boys S01 1080p', name: 'The Boys', own: null, dn: '' });
add('identity: nome depois de separador com run de 2 = 1', { op: 'identity', title: 'Shingeki no Kyojin - Attack on Titan S04', name: 'Attack on Titan', own: null, dn: '' });
add('identity: Fear the Walking Dead sem separador nomeando = 0', { op: 'identity', title: 'Fear the Walking Dead S04E01', name: 'The Walking Dead', own: null, dn: '' });
add('identity: nome só depois de separador com 1 token não basta = 0', { op: 'identity', title: 'Detective Conan - The Boys S01', name: 'The Boys', own: null, dn: '' });
add('identity: posse explícita com apóstrofo = 1', { op: 'identity', title: "Marvel's Daredevil S01E01", name: 'Daredevil', own: null, dn: '' });
add('identity: posse com apóstrofo curvo = 1', { op: 'identity', title: 'Noah Hawley’s Fargo S01', name: 'Fargo', own: null, dn: '' });
add('identity: nome com ponto (cena) não é posse = 0', { op: 'identity', title: 'Marvels.Daredevil S01E01', name: 'Daredevil', own: null, dn: '' });
add('identity: Walter Boys não é posse = 0', { op: 'identity', title: 'Walter Boys 1080p', name: 'Boys', own: null, dn: '' });
add('identity: posse seguida de letra não casa (lookahead) = 0', { op: 'identity', title: "Hawley's Fargos", name: 'Fargo', own: null, dn: '' });
add('identity: nome sem token nomeante (no-token) = 1', { op: 'identity', title: 'Qualquer Coisa 1080p', name: 'It', own: null, dn: '' });
add('identity: base de 3 tokens (skip) = 1 mesmo sem prefixo', { op: 'identity', title: 'Outra Obra 1080p', name: 'Resident Evil Vendetta', own: null, dn: '' });
add('identity: rótulo do título com script não latino = 1', { op: 'identity', title: '光環 Halo S01E01', name: 'Halo', own: null, dn: '' });
add('identity: own pré-tokenizado é usado no lugar do título', { op: 'identity', title: 'Random 1080p', name: 'Halo', own: ['halo', 's01e01'], dn: '' });
add('identity: own vazio (lista vazia) cai no título sem tokens e nega = 0', { op: 'identity', title: 'Random 1080p', name: 'Halo', own: [], dn: '' });
add('identity: etiqueta com colchetes sozinha sem obra = 0', { op: 'identity', title: '[ReQ] Random 1080p', name: 'Halo', own: null, dn: '' });
add('identity: separador de dois pontos com run de 2 = 1', { op: 'identity', title: 'Game of Thrones: Attack on Titan', name: 'Attack on Titan', own: null, dn: '' });
add('identity: nome no meio do título depois de token latino = 0', { op: 'identity', title: 'Trailer Park Boys 2026', name: 'The Boys', own: null, dn: '' });
add('identity: apenas dn com etiqueta de uploader = 1', { op: 'identity', title: 'Random 1080p', name: 'Halo', own: null, dn: '[TGx] Halo S01E01' });

// matchesTitleStructure: prefixo, sequência, ano, subtítulo de franquia.
add('structure: título do filme com ano do catálogo = 1', { op: 'structure', title: 'Scary Movie 2000 1080p', name: 'Scary Movie', year: '2000', isSeries: false, own: null });
add('structure: sequência não pedida (Scary Movie 2) = 0', { op: 'structure', title: 'Scary Movie 2 (2001) 1080p', name: 'Scary Movie', year: '2000', isSeries: false, own: null });
add('structure: sequência pedida com ano igual ao catálogo = 1', { op: 'structure', title: 'A Morte Te Dá Parabéns (2017) 1080p', name: 'A Morte Te Dá Parabéns 2', year: '2017', isSeries: false, own: null });
add('structure: sequência pedida com ano diferente do catálogo = 0', { op: 'structure', title: 'A Morte Te Dá Parabéns (2017) 1080p', name: 'A Morte Te Dá Parabéns 2', year: '2019', isSeries: false, own: null });
add('structure: sequência pedida sem ano no título = 0', { op: 'structure', title: 'Morte 1080p', name: 'Morte 2', year: '2017', isSeries: false, own: null });
add('structure: sequência pedida sem ano no catálogo = 0', { op: 'structure', title: 'Morte (2017) 1080p', name: 'Morte 2', year: null, isSeries: false, own: null });
add('structure: pack de coleção dispensa a guarda reversa = 1', { op: 'structure', title: 'Trilogia Matrix 1080p', name: 'Matrix 2', year: '2003', isSeries: false, own: null });
add('structure: primeiro token significativo diferente = 0', { op: 'structure', title: 'Monster Hunter 2021', name: 'Hunter', year: '2021', isSeries: false, own: null });
add('structure: nome vazio = 0', { op: 'structure', title: 'Scary Movie', name: '', year: '2000', isSeries: false, own: null });
add('structure: nome só com pontuação = 0', { op: 'structure', title: 'Scary Movie', name: '!!', year: '2000', isSeries: false, own: null });
add('structure: own vazio (lista) nega o primeiro token = 0', { op: 'structure', title: 'Scary Movie', name: 'Scary Movie', year: '2000', isSeries: false, own: [] });
add('structure: own pré-tokenizado é usado = 1', { op: 'structure', title: 'x', name: 'Scary Movie', year: '2000', isSeries: false, own: ['scary', 'movie', '2000'] });
add('structure: ano null sem contradição = 1', { op: 'structure', title: 'Monster Hunter', name: 'Monster Hunter', year: null, isSeries: false, own: null });
add('structure: ano atual do filme dentro de ±2 = 1', { op: 'structure', title: 'Monster Hunter 2021 1080p', name: 'Monster Hunter', year: '2020', isSeries: false, own: null });
add('structure: subtítulo ausente com ano diferente do catálogo = 0', { op: 'structure', title: 'Resident Evil (2002) 1080p BrRip', name: 'Resident Evil: Apocalypse', year: '2004', isSeries: false, own: null });
add('structure: subtítulo presente = 1', { op: 'structure', title: 'Resident Evil Apocalypse (2002)', name: 'Resident Evil: Apocalypse', year: '2004', isSeries: false, own: null });
add('structure: série com ano do título dentro da tolerância = 1', { op: 'structure', title: 'Fallout S01E01 1080p', name: 'Fallout', year: '2024', isSeries: true, own: null });
add('structure: série com ano bem anterior ao catálogo = 0', { op: 'structure', title: 'Fallout (2010) S01E01', name: 'Fallout', year: '2024', isSeries: true, own: null });
add('structure: série não aplica a guarda de sequência = 1', { op: 'structure', title: 'Scary Movie 2 S01E01', name: 'Scary Movie', year: '2000', isSeries: true, own: null });
add('structure: série com sequência não pedida ainda passa a guarda = 1', { op: 'structure', title: 'Fallout 2 S01E01', name: 'Fallout', year: '2024', isSeries: true, own: null });
add('structure: filme mais novo da franquia contra catálogo antigo = 1', { op: 'structure', title: 'Demon Slayer Infinity Castle 2025', name: 'Demon Slayer', year: '2019', isSeries: false, own: null });
add('structure: título sem prefixo do nome = 0', { op: 'structure', title: 'Outro Filme 2020', name: 'Scary Movie', year: '2020', isSeries: false, own: null });
add('structure: sigla pontuada com nome em caixa diferente = 1', { op: 'structure', title: 's.w.a.t. 2017', name: 'S.W.A.T.', year: '2017', isSeries: false, own: null });

add('identity: Attack on Titan com sufixo de temporada = 1', { op: 'identity', title: 'Attack on Titan Final Season 1080p', name: 'Attack on Titan', own: null, dn: '' });
add('structure: terceira sequência não pedida contra o catálogo = 0', { op: 'structure', title: 'Scary Movie 3 (2003) 1080p', name: 'Scary Movie', year: '2000', isSeries: false, own: null });
add('structure: Monster Hunter com ano em faixa de ±2 = 1', { op: 'structure', title: 'Monster Hunter (2020) 1080p', name: 'Monster Hunter', year: '2021', isSeries: false, own: null });
add('identity: nome curto com acento e caixa diferente = 1', { op: 'identity', title: 'POÇÃO do avô 1080p', name: 'Poção', own: null, dn: '' });

const body = cases
  .map((c, i) => ({ id: `rt-${String(i + 1).padStart(3, '0')}`, input: c.input, note: c.note }))
  .map((c) => '    ' + JSON.stringify(c))
  .join(',\n');

writeFileSync(
  OUT,
  `{
  "version": "corpus-release-title-rules/1",
  "note": "release-title-rules.ts: matchesTitleStructure, shortNameIdentity e matchesShortNameIdentity. Entrada JSON com op (shortName, identity, structure). Saída: skip|no-token|prefix|want|run, ou 1/0. IDs estáveis.",
  "cases": [
${body}
  ]
}
`,
);
console.log(`[corpus] ${cases.length} casos`);
