'use strict';

const { createHash } = require('node:crypto');

function normalizeFilterText(s = '') {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// O ano final da query de filme é contexto; tirar no máximo um preserva anos
// que fazem parte do título, como "Blade Runner 2049" e "1917".
function stripTrailingYears(tokens) {
  const out = tokens.slice();
  if (out.length >= 2 && /^\d{4}$/.test(out[out.length - 1])) out.pop();
  return out;
}

function computeWantedTokens(query) {
  const all = stripTrailingYears(normalizeFilterText(query).split(' ').filter(Boolean));
  const long = all.filter((word) => word.length > 2);
  return long.length >= 2 ? long : all;
}

// Pré-filtro conservador: evita pagar protetores pelos "parecidos" devolvidos
// pelo WordPress, sem tentar decidir spin-off, ano ou episódio como o addon.
function matchesResolverQuery(post, query) {
  const wanted = computeWantedTokens(query);
  if (wanted.length === 0) return true;
  const got = new Set(normalizeFilterText(post.title).split(' ').filter(Boolean));
  return wanted.filter((word) => got.has(word)).length / wanted.length >= 0.6;
}

// A temporada pode chegar como match RegExp, string ou número; fora disso não
// há filtro para não rejeitar todos os posts por uma configuração malformada.
function normalizeSeasonValue(value) {
  const number = Number(Array.isArray(value) ? value[1] : value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function matchesSeasonSeason(post, requestedSeason) {
  const wantedSeason = normalizeSeasonValue(requestedSeason);
  if (wantedSeason == null) return true;
  const season = post.title.match(/(?:\bS(\d{1,2})\b|(\d{1,2})\s*[ªº]\s*Temporada)/i);
  return !season || Number(season[1] || season[2]) === wantedSeason;
}

// Post de índice/lista expande dezenas de opções de 1 KB e inunda o Manual
// Search. A regra só corta lista genérica, não títulos como "A Lista de Schindler".
function isGenericListPost(title = '') {
  if (!title) return false;
  const clean = String(title)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[–\-—/|:&+,–.()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/^(lista|listao|indice)/.test(clean)) return false;
  const categories = [
    'filme', 'filmes', 'serie', 'series', 'anime', 'animes', 'desenho', 'desenhos',
    'documentario', 'documentarios', 'temporada', 'temporadas', 'dorama', 'doramas',
    'jogo', 'jogos', 'musica', 'musicas', 'categoria', 'categorias', 'todo', 'todos',
    'toda', 'todas', 'tudo', 'geral', 'completa', 'completo',
  ].join('|');
  const match = clean.match(new RegExp(`^(lista|listao|indice)\\s+de\\s+(${categories})\\b(.*)$`));
  if (!match) return false;
  return !/^(?:do|da|dos|das|de)\b/.test(match[3].trim());
}

// O índice posicional continua na URL por compatibilidade; o hash curto do href
// é a identidade estável quando o post mudou entre a busca e o resolve.
function buttonId(link) {
  return createHash('sha1').update(String(link?.url || '')).digest('hex').slice(0, 10);
}

function pickButton(links, index, hash, count) {
  if (hash) {
    const found = links.find((link) => buttonId(link) === hash);
    if (found) return found;
    if (count != null && links.length !== Number(count)) return null;
  }
  return links[index] ?? null;
}

module.exports = {
  normalizeFilterText,
  stripTrailingYears,
  computeWantedTokens,
  matchesResolverQuery,
  normalizeSeasonValue,
  matchesSeasonSeason,
  isGenericListPost,
  buttonId,
  pickButton,
};
