#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-multiwork-pack.json`: casos de
 * `src/utils/multiwork-pack.ts` (collectionRoot, collectionRootTokens,
 * coversYear, packYearSource, admitsMultiWorkPack). Gerador descartável do
 * corpus; o arquivo commitado é a fonte. Títulos herdados de
 * corpus-title-normalization.json alimentam a raiz da coleção.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-multiwork-pack.json');

const cases = [];
const add = (note, obj) => cases.push({ note, input: JSON.stringify(obj) });

const IJ_TITLE = 'Indiana Jones - A Coleção Completa 1981-2008';
const IJ_MW = { name: 'Indiana Jones', root: 'indiana jones', years: [1981, 1984, 1989, 2008] };
const IJ_NAMES = ['Indiana Jones e os Caçadores da Arca Perdida'];

// collectionRoot / collectionRootTokens: raiz normalizada da coleção.
add('root: coleção com faixa de anos', { op: 'root', name: IJ_TITLE });
add('root: coleção entre parênteses', { op: 'root', name: 'Indiana Jones (Coleção)' });
add('root: trilogia como prefixo de empacotamento', { op: 'root', name: 'Trilogia Indiana Jones' });
add('root: artigo inicial sai', { op: 'root', name: 'O Senhor dos Anéis' });
add('root: subtítulo cortado por dois-pontos', { op: 'root', name: 'Jornada nas Estrelas: O Filme' });
add('root: subtítulo cortado por travessão', { op: 'root', name: 'Jornada nas Estrelas — O Filme' });
add('root: subtítulo cortado por en dash', { op: 'root', name: 'Jornada nas Estrelas – O Filme' });
add('root: marcador romano no fim sai', { op: 'root', name: 'Star Wars Episódio VIII' });
add('root: marcador com Parte sai', { op: 'root', name: 'Rocky Parte II' });
add('root: VIIII (5 letras) não é marcador', { op: 'root', name: 'Rocky VIIII' });
add('root: número de três dígitos não é marcador', { op: 'root', name: 'Matrix 100' });
add('root: número de dois dígitos sai', { op: 'root', name: 'Matrix 10' });
add('root: palavra só de empacotamento deixa menos de 2 tokens', { op: 'root', name: 'Saga' });
add('root: vazio', { op: 'root', name: '' });
add('root: dois-pontos no início não corta', { op: 'root', name: ':Subtítulo Longo' });
add('root: candidato com uma palavra não corta', { op: 'root', name: 'A: Coleção Trilogia' });
add('root: quebra de linha depois do separador impede corte', { op: 'root', name: 'Mad Max: Fury\nRoad' });
add('root: espaços múltiplos entre palavras', { op: 'root', name: 'Batman  Coleção  Completa' });
add('root: nbsp e tab como espaço', { op: 'root', name: 'Filme Coleção\tCompleta' });
add('root: sem marcador e com dois tokens', { op: 'root', name: 'Distrito 9' });
add('root: só coleção e completa sobra vazio', { op: 'root', name: 'Coleção Completa' });
add('root: nome com artigo duplo', { op: 'root', name: 'Os Os Miseráveis' });
add('rootTokens: lista vazia vira string vazia', { op: 'rootTokens', name: 'Coleção' });
add('rootTokens: nome com marcador e subtítulo', { op: 'rootTokens', name: 'Dragon Ball Z: Parte 2' });

// coversYear: faixa cobre, ano avulso com tolerância de ±2.
add('covers: faixa inclui o ano (borda inferior)', { op: 'covers', text: '1981-2008', year: '1981' });
add('covers: faixa inclui o ano (borda superior)', { op: 'covers', text: '1981-2008', year: 2008 });
add('covers: faixa não inclui o ano', { op: 'covers', text: '1981-2008', year: 2009 });
add('covers: faixa com a palavra de ligação a', { op: 'covers', text: '1981 a 2008', year: 2000 });
add('covers: faixa com até e espaços (boundary falha depois do é)', { op: 'covers', text: '1981 até 2008', year: 2000 });
add('covers: até grudado no ano passa pelo boundary', { op: 'covers', text: '1981 até2008', year: 2000 });
add('covers: faixa com de', { op: 'covers', text: '1981 de 2008', year: 1990 });
add('covers: faixa com to', { op: 'covers', text: '1981 to 2008', year: 1990 });
add('covers: faixa com ate em maiúscula', { op: 'covers', text: '1981 ATE 2008', year: 1990 });
add('covers: faixa com til', { op: 'covers', text: '1981~2008', year: 2008 });
add('covers: faixa com travessão em dash', { op: 'covers', text: '1981—2008', year: 1990 });
add('covers: resolução não conta como ano', { op: 'covers', text: '1920x1080', year: 1920 });
add('covers: resolução no meio da faixa', { op: 'covers', text: '1981-2008 1920x1080', year: 1984 });
add('covers: ano avulso dentro da tolerância', { op: 'covers', text: 'Filme 2009', year: 2010 });
add('covers: ano avulso fora da tolerância', { op: 'covers', text: 'Filme 2007', year: 2010 });
add('covers: ano avulso na borda da tolerância', { op: 'covers', text: 'Filme 2012', year: 2010 });
add('covers: faixa consumida não gera ano avulso', { op: 'covers', text: '2000-2008', year: 2010 });
add('covers: ano grudado em dígito não é ano (lookbehind)', { op: 'covers', text: '12019', year: 2019 });
add('covers: ano seguido de dígito não é ano (lookahead)', { op: 'covers', text: '20191', year: 2019 });
add('covers: hífen depois do ano casa como faixa encadeada', { op: 'covers', text: '1981-2008-2010', year: 2010 });
add('covers: ano catálogo null', { op: 'covers', text: '1981-2008', year: null });
add('covers: ano sem dígitos', { op: 'covers', text: '1981-2008', year: 'sem ano' });
add('covers: texto vazio', { op: 'covers', text: '', year: 2000 });
add('covers: dois anos avulsos e o catálogo entre eles', { op: 'covers', text: 'Blade Runner 2049 2017', year: 2017 });
add('covers: ano de nome (2049) não é o do catálogo', { op: 'covers', text: 'Blade Runner 2049', year: 2017 });

// packYearSource: título + dn= decodificado quando há magnet real.
add('evidence: sem magnet devolve só o título', { op: 'evidence', item: { title: 'Filme A' } });
add('evidence: magnet real acrescenta dn decodificado', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?xt=urn:btih:x&dn=Foo+Bar' } });
add('evidence: dn depois de outros parâmetros', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?xt=urn:btih:x&dn=A&tr=udp' } });
add('evidence: prefixo magnet em maiúscula', { op: 'evidence', item: { title: 'T', magnet: 'MAGNET:?dn=Maiuscula' } });
add('evidence: espaço antes do magnet é aparado para o prefixo', { op: 'evidence', item: { title: 'T', magnet: '  magnet:?dn=Aparado' } });
add('evidence: DN em maiúscula', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?xt=x&DN=Caixa' } });
add('evidence: xdn não é dn', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?xdn=No&dn=Yes' } });
add('evidence: primeiro dn vence', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?dn=First&dn=Second' } });
add('evidence: dn vazio não casa', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?dn=&xt=1' } });
add('evidence: mais é espaço', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?dn=A+B+C' } });
add('evidence: %2B decodifica para mais literal', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?dn=A%2BB' } });
add('evidence: percent UTF-8 válido', { op: 'evidence', item: { title: 'X', magnet: 'magnet:?dn=Ca%C3%A7a' } });
add('evidence: percent malformado mantém o texto', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?dn=100%' } });
add('evidence: percent UTF-8 inválido mantém o texto', { op: 'evidence', item: { title: 'T', magnet: 'magnet:?dn=%E9' } });
add('evidence: URL de protetor não é magnet', { op: 'evidence', item: { title: 'T', magnet: 'https://protetor.example/?dn=Nao' } });
add('evidence: título vazio deixa espaço inicial', { op: 'evidence', item: { title: '', magnet: 'magnet:?dn=A' } });
add('evidence: item nulo', { op: 'evidence', item: null });
add('evidence: campos Title e MagnetUri são usados sem title/magnet', { op: 'evidence', item: { Title: 'Caixa Alta', MagnetUri: 'magnet:?dn=Dn+Alta' } });
add('evidence: title vazio cai no Title', { op: 'evidence', item: { title: '', Title: 'Cai No Title', magnet: 'magnet:?dn=Ok' } });
add('evidence: nbsp antes do magnet é aparado', { op: 'evidence', item: { title: 'T', magnet: ' magnet:?dn=Nbsp' } });

// admitsMultiWorkPack: a admissão completa (sem rede).
add('admits: pack de coleção com faixa cobrindo o ano', { op: 'admits', item: { title: IJ_TITLE }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: borda superior da faixa', { op: 'admits', item: { title: IJ_TITLE }, multiWork: IJ_MW, year: 2008, names: IJ_NAMES });
add('admits: ano fora da faixa', { op: 'admits', item: { title: IJ_TITLE }, multiWork: IJ_MW, year: 2009, names: IJ_NAMES });
add('admits: sem multiWork', { op: 'admits', item: { title: IJ_TITLE }, multiWork: null, year: 1981, names: IJ_NAMES });
add('admits: raiz vazia', { op: 'admits', item: { title: IJ_TITLE }, multiWork: { name: 'x', root: '', years: [] }, year: 1981, names: IJ_NAMES });
add('admits: série fica fora', { op: 'admits', item: { title: IJ_TITLE }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES, isSeries: true });
add('admits: sem nomes não há dica de obra', { op: 'admits', item: { title: IJ_TITLE }, multiWork: IJ_MW, year: 1981, names: [] });
add('admits: ano null', { op: 'admits', item: { title: IJ_TITLE }, multiWork: IJ_MW, year: null, names: IJ_NAMES });
add('admits: ano em string', { op: 'admits', item: { title: IJ_TITLE }, multiWork: IJ_MW, year: '1984', names: IJ_NAMES });
add('admits: título de filme isolado sem coleção', { op: 'admits', item: { title: 'Indiana Jones e os Caçadores da Arca Perdida 1981' }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: raiz não contígua no título', { op: 'admits', item: { title: 'Jones Indiana - Coleção 1981-2008' }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: pack com palavra fraca e faixa', { op: 'admits', item: { title: 'Indiana Jones Todos os Filmes 1981-2008' }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: palavra fraca sem faixa não é pack', { op: 'admits', item: { title: 'Indiana Jones Todos os Filmes 1981' }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: coleção só no dn do magnet', { op: 'admits', item: { title: 'Indiana Jones Filme 1981', magnet: 'magnet:?xt=urn:btih:abc&dn=Indiana+Jones+Colecao+Completa+1981-2008' }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: coleção só no dn com percent-encoding', { op: 'admits', item: { title: 'Indiana Jones 1981', magnet: 'magnet:?dn=Indiana%20Jones%20Colecao%201981-2008' }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: URL de protetor não tem dn', { op: 'admits', item: { title: 'Indiana Jones 1981', magnet: 'https://x.example/?dn=Indiana+Jones+Colecao+1981-2008' }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: dn malformado não derruba a admissão', { op: 'admits', item: { title: 'Indiana Jones Colecao 1981-2008', magnet: 'magnet:?dn=Indiana%ZZ+Jones+Colecao+1981-2008' }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: item nulo', { op: 'admits', item: null, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: Title fallback', { op: 'admits', item: { Title: IJ_TITLE }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: faixa de anos com dois anos do catálogo distantes', { op: 'admits', item: { title: 'Indiana Jones Colecao 1981-1989' }, multiWork: IJ_MW, year: 1984, names: IJ_NAMES });
add('admits: ano avulso dentro de dois do catálogo', { op: 'admits', item: { title: 'Indiana Jones Colecao 1983' }, multiWork: IJ_MW, year: 1981, names: IJ_NAMES });
add('admits: multiWork com root contendo token que não aparece', { op: 'admits', item: { title: IJ_TITLE }, multiWork: { name: 'x', root: 'senhor dos aneis', years: [] }, year: 1981, names: IJ_NAMES });

// Raiz da coleção para cada título herdado do corpus de normalização.
const herded = JSON.parse(readFileSync(path.join(REPO, 'scripts/golden/corpus-title-normalization.json'), 'utf8').replace(/^﻿/, '')).cases;
for (const c of herded) {
  add('root: título herdado do corpus de normalização', { op: 'root', name: c.input });
}

const doc = {
  version: 'corpus-multiwork-pack/1',
  note: 'multiwork-pack.ts: collectionRoot, collectionRootTokens, coversYear, packYearSource e admitsMultiWorkPack. Entrada JSON com op. Saída: string ou 1/0. IDs estáveis: nunca renomear; caso novo recebe id no fim.',
  cases: cases.map((c, i) => ({ id: `mp-${String(i + 1).padStart(3, '0')}`, input: c.input, note: c.note })),
};
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`[corpus] ${path.relative(REPO, OUT)}: ${doc.cases.length} casos`);
