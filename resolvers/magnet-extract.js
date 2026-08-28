'use strict';

// Núcleo comum de extração de magnet e descoberta do próximo salto de protetor
// (passo 3 do item 9 — PLANO_MELHORIAS §5.8). O código era copiado nos cinco
// perfis em três variantes; a factory parametriza o que difere e o comportamento
// de CADA perfil permanece exatamente o mesmo (R-6):
//
//   - variante BÁSICA (torrentdosfilmes, nerdfilmes): o passo encoded EXIGE
//     `xt%3D` como primeiro parâmetro e para no `&` — fixture do
//     br-parsers.test.ts fixa esse desenho; não "melhore" para a rica.
//   - variante RICA (comandotorrents, bludv, vacatorrent): lista de variáveis
//     JS ampliada, variante URL-encoded dentro das aspas, `data-download` nos
//     atributos e encoded sem exigir xt nem cortar no `&`.
//   - vacatorrent acrescenta o passo do `data-link` em base64 (gate-2 vacadb).
//
// Sem estado de módulo mutável (R-2): regex são constantes e a factory fecha
// sobre elas — nada de recompilar regex por chamada (R-7; os harnesses
// adversariais têm budget de tempo).

// Passos idênticos nas duas variantes.
const MAGNET_RAW_RE = /magnet:\?[^"'<>\s]+/i;

// Variante BÁSICA.
const BASICA_JS_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+)["']/i;
const BASICA_JS_NAV_RE = /(?:location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+)["']/i;
const BASICA_ATTR_RE = /(?:data-magnet|data-url|data-link|data-href)\s*=\s*["'](magnet:\?[^"']+)["']/i;
const BASICA_ENCODED_RE = /magnet%3A%3Fxt%3D[^"'<>\s&]+/i;

// Variante RICA.
const RICA_JS_VAR_RE = /(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|REDIRECT_URL|NEXT_URL|LINK_FINAL|TARGET_URL|DESTINO|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i;
const RICA_JS_NAV_RE = /(?:(?:window\.|document\.)?location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i;
const RICA_ATTR_RE = /(?:data-magnet|data-url|data-link|data-href|data-download)\s*=\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']/i;
const RICA_ENCODED_RE = /magnet%3A%3F[^"'<>\s]+/i;

const ENCODED_PREFIX_RE = /^magnet%3A%3F/i;
// data-link base64 (gate-2 do protetor vacadb): o magnet viaja em Base64 no
// body da pasta final; decodificar e validar antes de devolver.
const B64_LINK_RE = /data-link=["']([A-Za-z0-9+/=]{32,})["']/i;
const B64_MAGNET_RE = /^magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}/i;

// Valor capturado por um passo da variante rica: protetores publicam o magnet
// nos dois formatos (e misturados: %3A na estrutura e & literal entre
// parâmetros). Sem magnet válido, o passo seguinte continua a tentativa.
function decodeEncodedValue(val, decodeEntities) {
  if (ENCODED_PREFIX_RE.test(val)) {
    try {
      val = decodeURIComponent(val);
    } catch {}
  }
  if (val.startsWith('magnet:?')) return decodeEntities(val);
  return null;
}

/**
 * Factory do extractMagnet. `encodedVariants` liga a variante rica (R-6: NÃO
 * unifique — tdf/nerd exigem `xt%3D` no passo encoded); `b64DataLink` liga o
 * passo do data-link em base64 (só vacatorrent), posicionado ANTES do regex
 * cru — o base64 não casa nele, e a ordem documenta a prioridade do conteúdo
 * decodificado.
 */
function createMagnetExtractor({ decodeEntities, encodedVariants = false, b64DataLink = null }) {
  if (typeof decodeEntities !== 'function') throw new Error('magnet-extract: decodeEntities é obrigatório');
  const jsVarRe = encodedVariants ? RICA_JS_VAR_RE : BASICA_JS_VAR_RE;
  const jsNavRe = encodedVariants ? RICA_JS_NAV_RE : BASICA_JS_NAV_RE;
  const attrRe = encodedVariants ? RICA_ATTR_RE : BASICA_ATTR_RE;
  const encodedRe = encodedVariants ? RICA_ENCODED_RE : BASICA_ENCODED_RE;

  return function extractMagnet(html) {
    if (!html) return null;
    const str = String(html);

    // 1. Variáveis JavaScript explícitas (DEST_URL, DOWNLOAD_URL, url, link, target, dest, etc.)
    const jsVar = str.match(jsVarRe);
    if (jsVar) {
      if (encodedVariants) {
        const magnet = decodeEncodedValue(jsVar[1], decodeEntities);
        if (magnet) return magnet;
      } else {
        return decodeEntities(jsVar[1]);
      }
    }

    // 2. Redirecionamentos / atribuições de navegação JavaScript
    const jsNav = str.match(jsNavRe);
    if (jsNav) {
      if (encodedVariants) {
        const magnet = decodeEncodedValue(jsNav[1], decodeEntities);
        if (magnet) return magnet;
      } else {
        return decodeEntities(jsNav[1]);
      }
    }

    // 3. Atributos HTML customizados (data-magnet, data-url, data-link, data-href)
    const attrMatch = str.match(attrRe);
    if (attrMatch) {
      if (encodedVariants) {
        const magnet = decodeEncodedValue(attrMatch[1], decodeEntities);
        if (magnet) return magnet;
      } else {
        return decodeEntities(attrMatch[1]);
      }
    }

    // 3.5 (só vacatorrent) data-link base64 do gate-2 vacadb.
    if (b64DataLink) {
      const b64Link = str.match(B64_LINK_RE);
      if (b64Link) {
        try {
          const value = b64Link[1].replace(/\s+/g, '');
          const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
          if (B64_MAGNET_RE.test(decoded)) return decoded;
        } catch {}
      }
    }

    // 4. Regex direto de URI magnet no documento
    const rawMatch = str.match(MAGNET_RAW_RE);
    if (rawMatch) return decodeEntities(rawMatch[0]);

    // 5. Magnet URL-encoded (ex.: magnet%3A%3Fxt%3Durn)
    const encodedMatch = str.match(encodedRe);
    if (encodedMatch) {
      try {
        const decoded = decodeURIComponent(encodedMatch[0]);
        if (decoded.startsWith('magnet:?')) return decodeEntities(decoded);
      } catch {}
    }

    return null;
  };
}

/**
 * Bloco genérico de DESCUBRA do nextProtectedUrl (passos comuns aos cinco
 * perfis): variável JavaScript apontando para URL HTTP(S) de protetor permitido
 * + busca genérica no corpo HTML por domínios de protetor. Cada perfil mantém
 * sua função nextProtectedUrl com os casos específicos (meta-refresh, `const
 * next`, URL_ETAPA2) e delega o resto aqui.
 *
 * `jsVarPattern` é a regex de variável JS PRÓPRIA do perfil — as listas de
 * variáveis diferem entre perfis e unificá-las mudaria comportamento (R-6);
 * passe a regex pré-compilada do módulo do perfil (R-7).
 *
 * A regex de sufixos é montada por chamada a partir de `protectorSuffixes`
 * (mesma construção de hoje nos perfis): o array vem da factory do perfil e
 * reflete EXTRA_ALLOWED_PROTECTORS carregado no require — o harness de stress
 * recarrega o módulo com env própria, então não há o que memoizar sem virar
 * estado de módulo (R-2).
 */
function discoverNextUrl(str, baseUrl, { isProtectorHost, decodeEntities, protectorSuffixes, jsVarPattern = null }) {
  // 1. Variável JavaScript apontando para URL HTTP(S) de protetor permitido
  if (jsVarPattern) {
    const jsMatch = str.match(jsVarPattern);
    if (jsMatch) {
      try {
        const u = new URL(decodeEntities(jsMatch[1]), baseUrl);
        if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
      } catch {}
    }
  }

  // 2. Busca genérica de URLs no corpo HTML apontando para domínios de protetor
  const escapedProtectors = protectorSuffixes
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  if (escapedProtectors) {
    const re = new RegExp(`https?:\\/\\/[^"'<>\\s]*?(?:${escapedProtectors})[^"'<>\\s]*`, 'i');
    const match = str.match(re);
    if (match) {
      try {
        const u = new URL(decodeEntities(match[0]), baseUrl);
        if (isProtectorHost(u.hostname) && u.href !== baseUrl) return u.href;
      } catch {}
    }
  }

  return null;
}

module.exports = { createMagnetExtractor, discoverNextUrl };
