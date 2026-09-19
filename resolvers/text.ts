const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
};

/** Variante de decodificação recebida por parâmetro nos perfis. */
export type DecodeEntities = (value?: string | null) => string;

// Variante usada por BluDV e ComandoTorrents: os dois sites publicam entidades
// nomeadas e numéricas além das quatro formas históricas.
function decodeEntities(value: string | null | undefined = ''): string {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

// NerdFilmes e TorrentDosFilmes mantêm esta semântica histórica de propósito:
// usar a variante rica mudaria o texto que chega ao matching desses perfis.
function decodeEntitiesBasic(value: string | null | undefined = ''): string {
  return String(value)
    .replace(/&#0?38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;|&#039;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function stripTags(value: string | null | undefined = '', decode: DecodeEntities = decodeEntities): string {
  return decode(String(value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseSize(text: string | null | undefined): number | null {
  const match = String(text || '').match(/([\d.,]+)\s*(TB|GB|MB|KB)/i);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2].toUpperCase() as 'KB' | 'MB' | 'GB' | 'TB'];
  return Number.isFinite(value) ? Math.round(value * multiplier) : null;
}

function escapeXml(value: string | null | undefined = ''): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const escapeHtml = escapeXml;

// Lê o destino de um <meta http-equiv="refresh">. A varredura é por tag (e não
// um regex único sobre o HTML inteiro) porque os protetores publicam o content
// com aspas aninhadas e ponto-e-vírgula: um regex ganancioso engolia o resto da
// página. `decode` entra por parâmetro porque BluDV/ComandoTorrents usam a
// variante rica de entidades e NerdFilmes/TorrentDosFilmes a histórica.
function extractMetaRefresh(html: string | null | undefined, decode: DecodeEntities = decodeEntities): string | null {
  if (!html) return null;
  const metaTags = String(html).match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const isRefresh = /\bhttp-equiv\s*=\s*["']?refresh["']?/i.test(tag);
    if (!isRefresh) continue;
    const contentMatch = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!contentMatch) continue;
    const rawContent = contentMatch[1] ?? contentMatch[2] ?? contentMatch[3] ?? '';
    const content = decode(rawContent);
    const urlMatch = content.match(/\burl\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i);
    if (urlMatch) {
      let target = (urlMatch[1] || urlMatch[2] || urlMatch[3] || '').trim();
      target = target.replace(/^['"]|['"]$/g, '');
      if (target) return decode(target);
    }
  }
  return null;
}

interface AttributeOptions {
  decode?: (value: string) => string;
  allowWhitespace?: boolean;
}

function attribute(
  tag: string | null | undefined,
  name: string,
  { decode = (value: string) => value, allowWhitespace = false }: AttributeOptions = {},
): string | null {
  const equals = allowWhitespace ? '\\s*=\\s*' : '=';
  const raw = String(tag).match(new RegExp(`\\b${name}${equals}["']([^"']*)["']`, 'i'))?.[1] || null;
  return raw == null ? null : decode(raw);
}

export {
  decodeEntities,
  decodeEntitiesBasic,
  stripTags,
  parseSize,
  escapeXml,
  escapeHtml,
  extractMetaRefresh,
  attribute,
};
