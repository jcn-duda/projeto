import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { titlePrecision } from '../src/utils/matching-tokens.js';
import { titleTokens } from '../src/utils/matching-vocabulary.js';
import { matchesBrTitle, TITLE_PRECISION_MIN, SERIES_TITLE_PRECISION_MIN } from '../src/utils/release-title-rules.js';

interface CorpusItem {
  title: string;
  name: string;
  year: number | null;
  allNames: string[];
  expected: boolean;
  nota: string;
}

interface CorpusData {
  _meta: Record<string, string>;
  itens: CorpusItem[];
}

const CORPUS: CorpusData = JSON.parse(
  readFileSync(new URL('./fixtures/title-precision-corpus.json', import.meta.url), 'utf8'),
);

test('titlePrecision: assinaturas sobem para ~1.00 com corte de cauda', () => {
  const fightClubTokens = titleTokens('Fight Club (1999) 720p BrRip x264 -YIFY');
  const fightClubUniverse = ['fight', 'club', 'clube', 'luta'];
  // Sem corte de cauda, -YIFY conta como ruído estranho fora da busca
  const oldScore = titlePrecision(fightClubTokens, fightClubUniverse, { cutTail: false });
  assert.ok(Math.abs(oldScore - 2 / 3) < 0.01, `esperado ~0.67 sem corte, obteve ${oldScore}`);

  // Com corte de cauda, para no ano 1999 (ou 720p), medindo apenas 'fight club' -> 1.00
  const newScore = titlePrecision(fightClubTokens, fightClubUniverse, { cutTail: true });
  assert.equal(newScore, 1);

  // Outros uploaders conhecidos medidos no acervo:
  assert.equal(
    titlePrecision(
      titleTokens('O Grande Lebowski (1998) 1080p BluRay Dublado - Alan_680'),
      ['grande', 'lebowski'],
      { cutTail: true },
    ),
    1,
  );

  assert.equal(
    titlePrecision(
      titleTokens('Um Tira da Pesada 2 (1987) BDrip 720p Dual Audio dat2014'),
      ['tira', 'pesada', '2'],
      { cutTail: true },
    ),
    1,
  );

  assert.equal(
    titlePrecision(
      titleTokens('A Rocha (1996) BDRip BluRay 720p dublado - Gilkerb'),
      ['rocha'],
      { cutTail: true },
    ),
    1,
  );
});

test('titlePrecision: conteúdo estranho na cabeça NÃO sobe e fica cortado no limiar 0.70', () => {
  const hollywoodUniverse = titleTokens('Once Upon a Time in Hollywood Era Uma Vez em Hollywood');

  // "Era Uma Vez em Londres [1080p WEB-DL DUAL]" -> tokens na cabeça: era uma vez em londres
  // 'londres' não está no universo -> 2/3 (0.666...) nos significativos
  const londresTokens = titleTokens('Era Uma Vez em Londres [1080p WEB-DL DUAL]');
  const londresScore = titlePrecision(londresTokens, hollywoodUniverse, { cutTail: true });
  assert.ok(Math.abs(londresScore - 2 / 3) < 0.01, `esperado ~0.67, obteve ${londresScore}`);
  assert.ok(londresScore < 0.70, 'Londres deve ser cortado pelo limiar 0.70');

  // "Era Uma Vez Uma Estrela [1080p WEB-DL DUAL]"
  const estrelaTokens = titleTokens('Era Uma Vez Uma Estrela [1080p WEB-DL DUAL]');
  const estrelaScore = titlePrecision(estrelaTokens, hollywoodUniverse, { cutTail: true });
  assert.ok(Math.abs(estrelaScore - 2 / 3) < 0.01, `esperado ~0.67, obteve ${estrelaScore}`);
  assert.ok(estrelaScore < 0.70, 'Estrela deve ser cortado pelo limiar 0.70');

  // "A Million Little Things" na busca de "The Little Things"
  const littleThingsUniverse = titleTokens('The Little Things Os Pequenos Vestígios');
  const millionTokens = titleTokens('A Million Little Things [1080p WEB-DL DUAL]');
  const millionScore = titlePrecision(millionTokens, littleThingsUniverse, { cutTail: true });
  assert.ok(millionScore < 0.70, `A Million Little Things deve ficar abaixo de 0.70, obteve ${millionScore}`);
});

test('titlePrecision: monotonicidade - o caso Mr. Bean prova a necessidade do Math.max', () => {
  // Mr.Bean.S01E01.FRENCH.720p.WEB.x264-BEAN
  // Tokens: mr bean s01e01 french 720p web x264 bean
  // Sem Math.max, a cabeça para em 720p/french, descartando '-BEAN' no final que coincidia com a busca.
  // Significativos inteiros: mr (pula curto se <3? mr tem 2 letras, mas vamos ver), bean, french, bean.
  // Graças ao Math.max, a pontuação com cutTail=true nunca é menor que com cutTail=false.
  const beanTokens = titleTokens('Mr.Bean.S01E01.FRENCH.720p.WEB.x264-BEAN');
  const beanUniverse = titleTokens('Mr Bean');

  const fullScore = titlePrecision(beanTokens, beanUniverse, { cutTail: false });
  const cutScore = titlePrecision(beanTokens, beanUniverse, { cutTail: true });

  assert.ok(cutScore >= fullScore, `cutScore (${cutScore}) não pode ser menor que fullScore (${fullScore})`);
});

test('titlePrecision: guarda de cabeça vazia (título começando com ruído técnico/ano não vira 1.00)', () => {
  // Título que começa direto com token técnico ou ano:
  // "1080p Random Strange Movie WEB-DL"
  const tokens = titleTokens('1080p Random Strange Movie WEB-DL');
  const score = titlePrecision(tokens, ['other'], { cutTail: true });
  assert.equal(score, 0, 'cabeça vazia não pode devolver 1.00 de graça');

  const yearStartTokens = titleTokens('2024 Random Strange Movie BluRay');
  const scoreYear = titlePrecision(yearStartTokens, ['other'], { cutTail: true });
  assert.equal(scoreYear, 0, 'começo com ano não pode devolver 1.00 de graça');
});

test('limiares convergidos: TITLE_PRECISION_MIN e SERIES_TITLE_PRECISION_MIN são 0.70 em produção', () => {
  assert.equal(TITLE_PRECISION_MIN, 0.70, 'TITLE_PRECISION_MIN deve convergir para 0.70');
  assert.equal(SERIES_TITLE_PRECISION_MIN, 0.70, 'SERIES_TITLE_PRECISION_MIN deve permanecer 0.70');
});

test('kill-switch: TITLE_PRECISION_TAIL_CUT=false reproduz pontuação de título inteiro e limiar 0.65', async () => {
  const fightClubTokens = titleTokens('Fight Club (1999) 720p BrRip x264 -YIFY');
  const fightClubUniverse = ['fight', 'club', 'clube', 'luta'];

  // Com cutTail: false explícito em titlePrecision, reproduz o cálculo antigo (~0.67)
  const fullScore = titlePrecision(fightClubTokens, fightClubUniverse, { cutTail: false });
  assert.ok(Math.abs(fullScore - 2 / 3) < 0.01, `esperado ~0.67 em título inteiro, obteve ${fullScore}`);

  // Teste de isolamento de processo com a env desativada:
  // process.execPath rodando subprocesso que importa config e release-title-rules
  const { execSync } = await import('node:child_process');
  const code = `
    import config from './dist/src/config.js';
    import { TITLE_PRECISION_MIN, matchesBrTitle } from './dist/src/utils/release-title-rules.js';
    import assert from 'node:assert/strict';

    assert.equal(config.search?.titlePrecisionTailCut, false);
    assert.equal(TITLE_PRECISION_MIN, 0.65);

    // Com o corte desligado e piso 0.65, o antigo falso positivo Londres passa (0.67 >= 0.65):
    const londresPassa = matchesBrTitle(
      'Era Uma Vez em Londres [1080p WEB-DL DUAL]',
      'Era Uma Vez em Hollywood',
      2019,
      { isSeries: false, allNames: ['Once Upon a Time in Hollywood', 'Era Uma Vez em Hollywood'] }
    );
    assert.equal(londresPassa, true, 'no modo legado (piso 0.65 e sem tail cut), Londres passava');
  `;
  execSync(`node --input-type=module -e "${code.replace(/\n/g, ' ')}"`, {
    env: { ...process.env, TITLE_PRECISION_TAIL_CUT: 'false' },
    stdio: 'pipe',
  });
});

test('corpus de precisão de título: divergências reportadas de uma vez', () => {
  const divergencias: string[] = [];
  for (const item of CORPUS.itens) {
    const actual = matchesBrTitle(item.title, item.name, item.year, {
      isSeries: false,
      allNames: item.allNames,
    });
    if (actual !== item.expected) {
      divergencias.push(
        `esperado=${item.expected} real=${actual}\n` +
        `  título: ${item.title}\n  obra: ${item.name} (${item.year})\n  nota: ${item.nota}`,
      );
    }
  }

  assert.equal(
    divergencias.length,
    0,
    `Corpus de precisão divergiu em ${divergencias.length} caso(s):\n` + divergencias.join('\n---\n'),
  );
});

