// Saídas estreitas do portão de identidade de nome curto (revisão de
// 2026-09-28): prefixo legítimo antes do nome — título original separado ou
// marca/autor em posse — não é homônimo; o spin-off com o nome inteiro dentro
// continua fora. Irmão de `format-short-name-identity.test.ts`, separado pelo
// teto de 400 linhas.
import { test } from 'node:test';
import assert from 'node:assert';
import { filterRelevantRaw as relevantRaw } from '../src/utils/format.js';

const withDn = (title: string, dn: string) => ({
  title,
  magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=${dn}`,
});

test('título original separado e posse explícita antes do nome entram', () => {
  const entram: Array<[string[], string, number]> = [
    [['Attack on Titan', 'Ataque dos Titãs'], 'Shingeki no Kyojin - Attack on Titan S04 1080p', 4],
    [['Attack on Titan'], 'Shingeki no Kyojin: Attack on Titan S04 1080p', 4],
    [['Attack on Titan'], 'Shingeki no Kyojin (Attack on Titan) S04 1080p', 4],
    [['Daredevil', 'Demolidor'], "Marvel's Daredevil S01 1080p NF WEB-DL", 1],
    [['Fargo'], "Noah Hawley's Fargo S05 1080p", 5],
    [['Fargo'], 'Noah Hawley’s Fargo S05 1080p', 5],
  ];
  for (const [names, title, season] of entram) {
    assert.equal(relevantRaw([{ title }], { names, isSeries: true, season }).length, 1, `${names[0]} × ${title}`);
  }
  // Sem separador nem apóstrofo não há prova: o nome de cena fica com o `dn=`.
  for (const [names, title, dn, season] of [
    [['Fargo'], 'Noah.Hawleys.Fargo.S05.1080p', 'Fargo.S05.1080p.WEB-DL', 5],
    [['My Hero Academia'], 'Boku no Hero Academia S06 1080p WEB', 'My.Hero.Academia.S06.1080p.WEB', 6],
  ] as Array<[string[], string, string, number]>) {
    assert.equal(relevantRaw([{ title }], { names, isSeries: true, season }).length, 0, title);
    assert.equal(relevantRaw([withDn(title, dn)], { names, isSeries: true, season }).length, 1, `dn: ${title}`);
  }
});

test('as saídas não reabrem homônimo nem spin-off', () => {
  // "Fear the Walking Dead S04E01" entrou em The Walking Dead S04E01 no teste
  // real do Docker (2026-09-28) enquanto bastava a sequência contínua do nome.
  for (const [names, title, season, episode] of [
    [['The Walking Dead'], 'Fear the Walking Dead S04E01 Whats Your Story 1080p BluRay x264 OFT', 4, 1],
    [['The Walking Dead'], 'Fear.the.Walking.Dead.S04.1080p.AMZN.WEB-DL', 4, null],
    [['The Boys'], 'The.Hardy.Boys.S01.1080p.WEB-DL', 1, null],
    [['The Boys'], 'Detective Conan - The Detective Boys S01 1080p', 1, null],
    [['The Boys'], 'My Life With the Walter Boys S01E02 2023 2160p NF WEB-DL', 1, 2],
    [['The Boss'], 'Shes The Boss S01E01 1080p', 1, 1],
    [['The Fallout'], 'Thirst Trap The Fallout S01E01 1080p', 1, 1],
  ] as Array<[string[], string, number, number | null]>) {
    assert.equal(relevantRaw([{ title }], { names, isSeries: true, season, episode }).length, 0, `${names[0]} × ${title}`);
  }
  // Controle: a série-mãe continua entrando.
  assert.equal(
    relevantRaw([{ title: 'The Walking Dead S04E01 720p WEB x265 MiNX TGx' }], { names: ['The Walking Dead'], isSeries: true, season: 4, episode: 1 }).length,
    1,
  );
});
