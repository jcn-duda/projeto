function bytesToSize(bytes: unknown) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * btih em base32 (32 chars) para os 40 hex que o Stremio exige.
 * Magnet de indexer BR às vezes vem nesse formato; repassado cru, o item
 * aparece na lista mas o cliente não monta o magnet e o play morre.
 */
function base32ToHex(input: string) {
  const s = String(input).toUpperCase();
  let bits = '';
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= 160; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function extractInfoHash(magnetOrHash: unknown) {
  if (!magnetOrHash) return null;
  const raw = String(magnetOrHash).trim();

  if (/^[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  if (/^[a-zA-Z2-7]{32}$/.test(raw)) return base32ToHex(raw);

  const m = raw.match(/btih:([a-zA-Z0-9]{32,40})/i);
  if (!m) return null;
  const hash = m[1];
  if (/^[a-fA-F0-9]{40}$/.test(hash)) return hash.toLowerCase();
  if (hash.length === 32) return base32ToHex(hash);
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  // Ordinais: as que mais mudam DECISÃO aqui. Todo pack BR se anuncia como
  // "4ª Temporada", e o Pirate Bay publica isso como "4&ordf; Temporada" —
  // sem decodificar, o parser não lê temporada nenhuma e o pack da 4ª entra
  // na lista do S01E01 como se cobrisse qualquer episódio.
  ordf: 'ª', ordm: 'º', deg: '°',
  // Acentuadas: aparecem no mesmo corpus ("Dual &Aacute;udio").
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  acirc: 'â', ecirc: 'ê', ocirc: 'ô', atilde: 'ã', otilde: 'õ',
  ccedil: 'ç', agrave: 'à', uuml: 'ü', ntilde: 'ñ',
};

/**
 * Indexers que raspam WordPress devolvem o título com entidade crua — o BLUDV
 * e o Comando mandam "Episódio II &#8211; Ataque dos Clones". Sem decodificar,
 * a entidade aparece literal na lista do cliente.
 */
function decodeEntities(text = '') {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole: string, name: string) => {
      const letra = NAMED_ENTITIES[name.toLowerCase()];
      if (letra === undefined) return whole;
      // A tabela é consultada em minúsculas, então "&Aacute;" caía em "á" e
      // "Dual Áudio" virava "Dual áudio" na tela. Só letra única herda a
      // caixa do nome da entidade; "&Amp;" continua "&".
      return letra.length === 1 && /^[A-Z]/.test(name) ? letra.toUpperCase() : letra;
    });
}

function normalizeTitle(s = '') {
  // \p{M} é obrigatório, não opcional: o .normalize('NFD') da linha anterior
  // separa dakuten/vogais-marca (japonês, hindi, tailandês) como combining
  // marks fora de ̀-ͯ; sem \p{M} elas viram espaço e "すずめの戸締まり" sairia
  // "すす めの戸締まり". CJK/cirílico sem espaço vira UM token — casa só com
  // release que escreve o título igual (restritivo, nunca permissivo); todo
  // caso latino sai byte-idêntico ao filtro antigo.
  //
  // Além das combining marks, o segundo replace remove os compat chars do
  // Latin-1 que o filtro antigo ([^a-z0-9]) também descartava: ordinais
  // (ª º — "2ª Temporada" tem que virar "2"), superscritos numéricos
  // (¹²³⁰⁴⁵⁶⁷⁸⁹), micro (µ) e fracções (¼½¾). Sem isso o ordinal viraria
  // token e o parse de temporada perderia o número.
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u00aa\u00ba\u00b2\u00b3\u00b9\u00b5\u00bc\u00bd\u00be\u2070\u2074-\u2079]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

/**
 * Tira só o diacrítico, preservando caixa, pontuação e espaços.
 * Diferente de normalizeTitle, que também faz lowercase e troca todo
 * não-alfanumérico por espaço — usar aquela numa QUERY a destruiria.
 * Medido ao vivo: o buscador WordPress dos sites BR devolve 0 para
 * QUALQUER query acentuada ("Extermínio" → 0, "Exterminio" → 8–16 nos
 * 5 indexers BR); os globais lidam bem com acento e não passam por aqui.
 */
function stripDiacritics(s = '') {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export { bytesToSize, extractInfoHash, decodeEntities, normalizeTitle, stripDiacritics };
