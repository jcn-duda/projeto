// Saídas estreitas do portão de identidade de nome curto (revisão de
// 2026-09-28): prefixo legítimo antes do nome — título original em outra
// língua ou marca/autor em posse — não é homônimo. Irmão de
// `format-short-name-identity.test.ts`, separado pelo teto de 400 linhas.
import { test } from 'node:test';
import assert from 'node:assert';
import { filterRelevantRaw as relevantRaw } from '../src/utils/format.js';

const withDn = (title: string, dn: string) => ({
  title,
  magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=${dn}`,
});

test('título original/marca na frente: a sequência inteira do nome prova a obra', () => {
  // Medido na revisão de 2026-09-28: o portão cortava pack de anime com o
  // romaji na frente e a marca/autor em posse — a cobertura aprovava e nada
  // mais os distinguia do homônimo. Duas saídas estreitas: sequência contínua
  // de 2+ tokens que nomeiam, ou posse EXPLÍCITA (apóstrofo) antes do nome.
  const entram: Array<[string[], string, number]> = [
    [['Attack on Titan', 'Ataque dos Titãs'], 'Shingeki no Kyojin - Attack on Titan S04 1080p', 4],
    [['My Hero Academia'], 'Boku no Hero Academia S06 1080p WEB', 6],
    [['Daredevil', 'Demolidor'], "Marvel's Daredevil S01 1080p NF WEB-DL", 1],
    [['Fargo'], "Noah Hawley's Fargo S05 1080p", 5],
    [['Fargo'], 'Noah Hawley’s Fargo S05 1080p', 5],
  ];
  for (const [names, title, season] of entram) {
    assert.equal(relevantRaw([{ title }], { names, isSeries: true, season }).length, 1, `${names[0]} × ${title}`);
  }
  // Sem apóstrofo não há prova de posse: o nome de cena fica com o `dn=`.
  assert.equal(relevantRaw([{ title: 'Noah.Hawleys.Fargo.S05.1080p' }], { names: ['Fargo'], isSeries: true, season: 5 }).length, 0);
  assert.equal(
    relevantRaw([withDn('Noah.Hawleys.Fargo.S05.1080p', 'Fargo.S05.1080p.WEB-DL')], { names: ['Fargo'], isSeries: true, season: 5 }).length,
    1,
  );
  // As exceções não reabrem o homônimo: nome de UM token que nomeia não tem
  // sequência que prove, e "Hardy"/"Walter" não são posse.
  for (const [names, title] of [
    [['The Boys'], 'The.Hardy.Boys.S01.1080p.WEB-DL'],
    [['The Boys'], 'My Life With the Walter Boys S01E02 2023 2160p NF WEB-DL'],
    [['The Boss'], 'Shes The Boss S01E01 1080p'],
    [['The Fallout'], 'Thirst Trap The Fallout S01E01 1080p'],
  ] as Array<[string[], string]>) {
    assert.equal(relevantRaw([{ title }], { names, isSeries: true, season: 1 }).length, 0, `${names[0]} × ${title}`);
  }
});
