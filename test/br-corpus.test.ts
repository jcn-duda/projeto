// P1 — Corpus de regressão dos classificadores BR/áudio com títulos REAIS.
//
// A classificação BR é o eixo de que tudo depende: sem `_br` a release não
// recebe vaga reservada, não ganha prioridade do brFirst e disputa cota contra
// gringo de centenas de seeds; no caminho oposto, condenar título BR apaga
// acervo que custou horas de download. Os testes inline (audio-cleanup-
// classifiers.test.ts, account-br-origin.test.ts) fixam os CASOS conhecidos;
// este corpus fixa a POPULAÇÃO — cada entrada é um título real medido na conta
// do operador ou em produção, com o veredicto correto e a NOTA que explica o
// porquê (a nota é parte do contrato: mexeu no classificador, atualizou a nota
// com a medição que justifica).
//
// O teste percorre o corpus inteiro e reporta TODAS as divergências de uma
// vez — abortar na primeira esconderia o blast radius da mudança.
//
// Propriedade de regressão: reverter mentalmente o 00c5dfb (Dual + sinal PT)
// TEM que deixar o corpus vermelho na entrada da Trilogia; apertar/afrouxar
// marca sem medição também deixa. Corpus = a rede que faltava.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { looksPtBr, audioFromTitle, hasExplicitForeignAudio } from '../src/utils/audio-quality.js';
import { brOriginMark } from '../src/utils/br-origin.js';

interface Entrada {
  t: string;
  looksPtBr: boolean;
  brOrigin: boolean;
  audio: string;
  foreign: boolean;
  nota: string;
}

const CORPUS: { _meta: Record<string, string>; itens: Entrada[] } = JSON.parse(
  readFileSync(new URL('./fixtures/br-corpus.json', import.meta.url), 'utf8'),
);

test('corpus tem cobertura mínima das famílias de classificação', () => {
  const itens = CORPUS.itens;
  assert.ok(itens.length >= 20, `corpus encolheu: ${itens.length} itens`);
  const familia = (ok: (e: Entrada) => boolean) => itens.filter(ok).length;
  assert.ok(familia((e) => e.looksPtBr) >= 5, 'faltam casos looksPtBr=true');
  assert.ok(familia((e) => !e.looksPtBr) >= 10, 'faltam casos looksPtBr=false');
  assert.ok(familia((e) => e.brOrigin && !e.looksPtBr) >= 5, 'faltam casos de origem-só (reserva sem _dubbed)');
  assert.ok(familia((e) => e.audio === 'Dual' && !e.looksPtBr) >= 4, 'faltam duals ambíguos (classe dos 249)');
  assert.ok(familia((e) => e.foreign) >= 2, 'faltam evidências de idioma estrangeiro');
  assert.ok(familia((e) => e.audio === 'Legendado') >= 1, 'falta LEGENDADA de site BR (matriz do account)');
});

test('classificadores aplicados ao corpus: divergências reportadas de uma vez', () => {
  const divergencias: string[] = [];
  for (const e of CORPUS.itens) {
    const real = {
      looksPtBr: looksPtBr(e.t),
      brOrigin: brOriginMark(e.t),
      audio: audioFromTitle(e.t),
      foreign: hasExplicitForeignAudio(e.t),
    };
    const esperado = {
      looksPtBr: e.looksPtBr,
      brOrigin: e.brOrigin,
      audio: e.audio,
      foreign: e.foreign,
    };
    for (const campo of Object.keys(esperado) as (keyof typeof esperado)[]) {
      if (real[campo] !== esperado[campo]) {
        divergencias.push(
          `[${campo}] esperado=${JSON.stringify(esperado[campo])} real=${JSON.stringify(real[campo])}\n` +
          `  título: ${e.t}\n  nota: ${e.nota}`,
        );
      }
    }
  }
  assert.equal(
    divergencias.length, 0,
    `corpus divergiu do classificador em ${divergencias.length} ponto(s).\n` +
    'OU o classificador regrediu, OU o corpus precisa de atualização com medição.\n' +
    divergencias.join('\n---\n'),
  );
});

test('P6: bthd com fronteira — HDBTHD fora, BTHD delimitado dentro', () => {
  // O falso positivo medido: tracker chinês via marca mal delimitada.
  const chinês = CORPUS.itens.find((e) => e.t.includes('HDBTHD'));
  assert.ok(chinês, 'corpus perdeu o caso HDBTHD');
  assert.equal(brOriginMark(chinês.t), false, 'HDBTHD não é marca BR');
  assert.equal(looksPtBr(chinês.t), false, 'HDBTHD não é sinal PT');
  assert.equal(audioFromTitle(chinês.t), '', 'HDBTHD não declara áudio PT');
  // A marca legítima delimitada continua valendo.
  const legítimo = CORPUS.itens.find((e) => /\.BTHD$/.test(e.t));
  assert.ok(legítimo, 'corpus perdeu o contra-caso BTHD delimitado');
  assert.equal(brOriginMark(legítimo.t), true, 'BTHD delimitado continua marca BR');
  // Sufixo colado não reabre o buraco (a fronteira vale dos DOIS lados).
  assert.equal(brOriginMark('Movie.2024.1080p.XBTHD-GROUP'), false, 'bthd colado à esquerda não casa');
  assert.equal(brOriginMark('Movie.2024.1080p.BTHDX'), false, 'bthd colado à direita não casa');
  // E a marca legítima nas formas reais de post BR: host e sufixo de grupo.
  for (const t of ['Filme.2024.1080p.BTHD', 'www.bthd.com - Filme 2024', 'Filme_2024_BTHD']) {
    assert.equal(brOriginMark(t), true, `BTHD legítimo deve casar: ${t}`);
  }
});

test('consistência derivada: o corpus não contradiz o audioBucket nem a matriz da conta', () => {
  // Derivações que o restante do pipeline consome, computadas sobre os
  // PRIMITIVOS já fixados acima — se um dia mudarem as derivas, o teste
  // explícito delas (audio-cleanup-classifiers, account-br-origin) avisa;
  // aqui basta a coerência interna do corpus.
  for (const e of CORPUS.itens) {
    // Reserva da conta (origemBrSemProvaDeAudio): ptAudio || (origem && !foreign && !Legendado).
    const ptAudio = looksPtBr(e.t);
    const reserva = ptAudio || (brOriginMark(e.t) && !e.foreign && e.audio !== 'Legendado');
    // Nenhum item do corpus pode prometer dublado por ORIGEM sozinha.
    if (reserva && !ptAudio) {
      assert.notEqual(e.audio, 'Legendado', `origem-só não pode ser Legendado: ${e.t}`);
    }
    // Ambíguo real da conta (nota dos 249): dual sem reserva é o estado esperado.
    if (e.audio === 'Dual' && !ptAudio) {
      assert.equal(
        reserva, e.brOrigin,
        `dual sem sinal PT: a reserva só pode vir da origem nomeada — ${e.t}`,
      );
    }
  }
});
