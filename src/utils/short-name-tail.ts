// Filme de nome de UM token: palavra que NOMEIA entre o nome e o ano é
// outra obra. Monster (2018), 2026-10-04: com o ano 2021 do TMDB, "Monster
// Hunter 2021", "Monster Hospital 2021" e "Monster Pets A Hotel Transylvania
// Short (2021)" passavam — o prefixo (`matchesShortNameIdentity`) só olha o
// primeiro token, e a cobertura de um token não discrimina.
//
// Só entre o nome e o ANO: edição e rótulo de cena vêm depois do ano
// ("Alien.1979.Directors.Cut"), e sem ano no título nada é julgado. Rótulo,
// número, outro script e token de outro nome da obra ("Coringa - Joker 2019")
// não contam. Só filme e só fora do caminho BR (`matchesBrTitle` tem régua
// própria).
import { isNonNamingToken, isNonLatinToken } from './matching-tokens.js';
import type { ShortNameIdentity } from './release-title-rules.js';

const YEAR_TOKEN_RE = /^(?:19|20)\d{2}$/;

function shortNameTailContradicts(tokens: string[], check: ShortNameIdentity, universe: ReadonlySet<string>): boolean {
  // Nome de UM token que nomeia: com dois ("Resident Evil") a continuação
  // nomeada já tem régua própria (`namedSequelContradicts`, ano exato).
  if (check.kind !== 'prefix' || check.run.length !== 1) return false;
  const start = tokens.indexOf(check.run[0]);
  if (start < 0) return false;
  // Avança pelos tokens do nome na ordem em que o nome os traz.
  let at = start;
  for (const word of check.run) {
    while (at < tokens.length && tokens[at] !== word && isNonNamingToken(tokens[at])) at += 1;
    if (tokens[at] !== word) break;
    at += 1;
  }
  const yearAt = tokens.findIndex((token, i) => i >= at && YEAR_TOKEN_RE.test(token));
  if (yearAt < 0) return false;
  return tokens.slice(at, yearAt).some((token) =>
    !isNonNamingToken(token) && !isNonLatinToken(token) && !/^\d+$/.test(token) && !universe.has(token));
}

export { shortNameTailContradicts };
