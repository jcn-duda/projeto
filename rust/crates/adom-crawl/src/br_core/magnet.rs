//! `createMagnetExtractor` de `resolvers/magnet-extract.ts`. Duas variantes
//! vivas (R-6, não unificar): BÁSICA (nerd, tdf: o passo codificado exige
//! `xt%3D` e para no `&`) e RICA (bludv, comando, vaca: mais variáveis JS,
//! valor codificado dentro das aspas, `data-download`); o vaca ainda lê o
//! `data-link` em base64 do gate-2. O href entre aspas vai até a aspa: o `dn=`
//! do NerdFilmes tem espaço cru e o corte no espaço perdia nome e trackers.

use std::sync::LazyLock;

use crate::profile_parsers::b64_decode;
use crate::shared::decode_uri_component;
use fancy_regex::Regex as FancyRegex;
use regex::Regex;

use super::text::decode_entities;

/// Variante do extrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MagnetExtractor {
    pub encoded_variants: bool,
    pub b64_data_link: bool,
}

/// nerd/tdf.
pub const BASIC: MagnetExtractor = MagnetExtractor {
    encoded_variants: false,
    b64_data_link: false,
};
/// bludv/comando.
pub const RICH: MagnetExtractor = MagnetExtractor {
    encoded_variants: true,
    b64_data_link: false,
};
/// vacatorrent.
pub const VACA: MagnetExtractor = MagnetExtractor {
    encoded_variants: true,
    b64_data_link: true,
};

fn rx(p: &str) -> Regex {
    Regex::new(p).expect("regex do extrator de magnet")
}

static MAGNET_RAW: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i)magnet:\?[^"'<>\s]+"#));
// Backreference para a aspa de fechamento: só o fancy-regex tem.
static HREF_MAGNET: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(r#"(?i)href\s*=\s*(["'])(magnet:\?[^"'<>]+)\1"#).expect("href magnet")
});
static ENCODED_PREFIX: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^magnet%3A%3F"));
static B64_LINK: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)data-link=["']([A-Za-z0-9+/=]{32,})["']"#));
static B64_MAGNET: LazyLock<Regex> =
    LazyLock::new(|| rx(r"(?i)^magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}"));
static B64_MANGLED: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(r"(?i)^magnet:\?xt=urn:?btih:?([a-f0-9]{40})(?![a-f0-9])").expect("mangled")
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| rx(r"\s+"));

static BASIC_JS_VAR: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+)["']"#,
    )
});
static BASIC_JS_NAV: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+)["']"#,
    )
});
static BASIC_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    rx(r#"(?i)(?:data-magnet|data-url|data-link|data-href)\s*=\s*["'](magnet:\?[^"']+)["']"#)
});
static BASIC_ENCODED: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i)magnet%3A%3Fxt%3D[^"'<>\s&]+"#));

static RICH_JS_VAR: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|REDIRECT_URL|NEXT_URL|LINK_FINAL|TARGET_URL|DESTINO|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']"#,
    )
});
static RICH_JS_NAV: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:(?:window\.|document\.)?location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']"#,
    )
});
static RICH_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:data-magnet|data-url|data-link|data-href|data-download)\s*=\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']"#,
    )
});
static RICH_ENCODED: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i)magnet%3A%3F[^"'<>\s]+"#));

/// `decodeEncodedValue`: valor `magnet%3A%3F…` é decodificado (malformado
/// fica como está); só `magnet:?` sai.
fn decode_encoded_value(value: &str) -> Option<String> {
    let mut v = value.to_string();
    if ENCODED_PREFIX.is_match(&v) {
        if let Some(decoded) = decode_uri_component(&v) {
            v = decoded;
        }
    }
    v.starts_with("magnet:?").then(|| decode_entities(&v))
}

impl MagnetExtractor {
    /// `extractMagnet(html)`.
    pub fn extract(&self, html: &str) -> Option<String> {
        if html.is_empty() {
            return None;
        }
        let (js_var, js_nav, attr, encoded) = if self.encoded_variants {
            (&*RICH_JS_VAR, &*RICH_JS_NAV, &*RICH_ATTR, &*RICH_ENCODED)
        } else {
            (
                &*BASIC_JS_VAR,
                &*BASIC_JS_NAV,
                &*BASIC_ATTR,
                &*BASIC_ENCODED,
            )
        };
        // 1–3. Variável JS, navegação JS e atributo data-*.
        for re in [js_var, js_nav, attr] {
            if let Some(c) = re.captures(html) {
                if !self.encoded_variants {
                    return Some(decode_entities(&c[1]));
                }
                if let Some(m) = decode_encoded_value(&c[1]) {
                    return Some(m);
                }
            }
        }
        // 3.5. data-link em base64 (gate-2 do vacadb).
        if self.b64_data_link {
            if let Some(c) = B64_LINK.captures(html) {
                let raw = SPACES.replace_all(&c[1], "");
                let decoded = String::from_utf8_lossy(&b64_decode(&raw))
                    .trim()
                    .to_string();
                if B64_MAGNET.is_match(&decoded) {
                    return Some(decoded);
                }
                if let Ok(Some(m)) = B64_MANGLED.captures(decoded.as_str()) {
                    return Some(format!("magnet:?xt=urn:btih:{}", m[1].to_lowercase()));
                }
            }
        }
        // 4. href entre aspas: a URI inteira, espaço cru vira %20.
        if let Ok(Some(c)) = HREF_MAGNET.captures(html) {
            let v = decode_entities(&c[2]);
            return Some(SPACES.replace_all(v.trim(), "%20").into_owned());
        }
        // 5. URI crua.
        if let Some(m) = MAGNET_RAW.find(html) {
            return Some(decode_entities(m.as_str()));
        }
        // 6. URI codificada.
        let m = encoded.find(html)?;
        let decoded = decode_uri_component(m.as_str())?;
        decoded
            .starts_with("magnet:?")
            .then(|| decode_entities(&decoded))
    }
}
