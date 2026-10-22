//! Montagem da URL de play `/resolve` — porte de `debrid-pipeline-core.ts`
//! (`viaDebrid`, linhas 249-283) sobre o HMAC do núcleo
//! (`adom_core::resolve_sign`).
//!
//! O que este módulo fixa, na ordem do TS:
//!
//! - **prefixo** = `/<config>` (`runtime.prefix()`): o play carrega a MESMA
//!   config, senão o debrid do usuário some na hora de tocar;
//! - **ep** = `?s=<S>&e=<E>` só com temporada E episódio; o `?` faz parte do
//!   payload do HMAC, não é separador de URL;
//! - **dica `w`** = JSON com `n`/`y` (dica de obra do build: nomes + ano),
//!   `p:1` (pack multiobra — `_multiWork` genérico OU admitido), `d:1`
//!   (dublado/claim) e `i` (IMDb id) — nesta ORDEM, porque o HMAC é sobre a
//!   string, não sobre JSON canônico;
//! - **`sig`** = HMAC-SHA256 do núcleo sobre `infoHash + ep + &w=<hint>`.
//!
//! A URL nasce RELATIVA (sem host): o `applyNoticeOrigin` monta o host só na
//! resposta, com o origin de quem pergunta. Gravar absoluto no cache
//! envenenava o play entre LAN/localhost/domínio (armadilha documentada no
//! AGENTS.md).
//!
//! Divergências conscientes desta fatia (reportadas no commit):
//! - a dica `d` não tem `_bankDub` (o banco vivo ainda não é fonte desta
//!   fatia) — só prova/claim do próprio build;
//! - o rótulo `[AD⚡]` do `name` (`markDebridName`) não é aplicado aqui: quem
//!   chama a trait `DebridCheck` decide o nome, e o build não o reescreve.

use crate::list_builder::WorkHint;

/// Contexto da requisição que entra na URL (nunca vem do `.env`).
#[derive(Debug, Clone, Default)]
pub struct ResolveSigner {
    /// `/<config>` ou `""` (instalação sem config na URL).
    pub prefix: String,
    /// Segredo efetivo: `resolveSecret || debridApiKey || ''`.
    pub secret: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// `tt…` da obra (dica `i` — o play grava evidência no índice).
    pub imdb_id: Option<String>,
    /// Dica de obra do build (`n`/`y`), só em filme com nomes.
    pub work_hint: Option<WorkHint>,
}

impl ResolveSigner {
    /// URL relativa do `/resolve` para um stream. Sem segredo o HMAC sai
    /// vazio (rota não assinável) — o chamador decide se materializa.
    ///
    /// O hash no path e no payload HMAC vai em **minúsculas** (a rota Node
    /// faz `toLowerCase` antes do verify — assinar em maiúsculas quebraria).
    pub fn url(&self, hash: &str, dubbed: bool, multi_work: bool) -> String {
        let hash = hash.to_ascii_lowercase();
        let ep = match (self.season, self.episode) {
            (Some(season), Some(episode)) => format!("?s={season}&e={episode}"),
            _ => String::new(),
        };
        let hint = self.hint_json(dubbed, multi_work);
        let sig = adom_core::sign_resolve(&hash, &ep, &hint, &self.secret);
        let mut url = String::new();
        url.push_str(&self.prefix);
        url.push_str("/resolve/");
        url.push_str(&hash);
        url.push_str(&ep);
        // `ep ? '&' : '?'`: o primeiro parâmetro depois do ep (ou do hash).
        url.push(if ep.is_empty() { '?' } else { '&' });
        if !hint.is_empty() {
            url.push_str("w=");
            url.push_str(&encode_uri_component(&hint));
            url.push('&');
        }
        url.push_str("sig=");
        url.push_str(&sig);
        url
    }

    /// Dica assinada. Vazia = sem dica (`''` no TS): obra desconhecida, sem
    /// dublado e sem pack — o payload do HMAC fica só `hash + ep`.
    fn hint_json(&self, dubbed: bool, multi_work: bool) -> String {
        let has_work = self.work_hint.is_some();
        let has_imdb = self.imdb_id.as_deref().is_some_and(|s| !s.is_empty());
        if !has_work && !dubbed && !has_imdb {
            return String::new();
        }
        let mut out = String::from("{");
        let mut first = true;
        if let Some(hint) = &self.work_hint {
            // `n` primeiro, `y` depois — ordem do objeto do TS.
            push_key(&mut out, &mut first, "n");
            out.push('[');
            for (i, name) in hint.names.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_json_string(&mut out, name);
            }
            out.push(']');
            push_key(&mut out, &mut first, "y");
            match hint.year {
                Some(year) => out.push_str(&year.to_string()),
                None => out.push_str("null"),
            }
            if multi_work {
                push_key(&mut out, &mut first, "p");
                out.push('1');
            }
        }
        if dubbed {
            push_key(&mut out, &mut first, "d");
            out.push('1');
        }
        if let Some(imdb) = self.imdb_id.as_deref().filter(|s| !s.is_empty()) {
            push_key(&mut out, &mut first, "i");
            push_json_string(&mut out, imdb);
        }
        out.push('}');
        out
    }
}

fn push_key(out: &mut String, first: &mut bool, key: &str) {
    if !*first {
        out.push(',');
    }
    *first = false;
    push_json_string(out, key);
    out.push(':');
}

/// `JSON.stringify` de uma string: mesmas fugas do `js_stringify` do núcleo
/// (`\b \f \n \r \t`, `\u00xx` para os demais de controle). Astral sai cru —
/// a dica é nome de obra, não passa por unidade UTF-16 órfã.
fn push_json_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `encodeURIComponent`: tudo fora de `A-Za-z0-9-_.!~*'()` vira `%XX` (hex
/// MAIÚSCULO) sobre os bytes UTF-8. A dica tem `{`/`"`/`:`/`,` — os quatro
/// viram `%7B`/`%22`/`%3A`/`%2C` como na URL capturada do corpus.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ── Verificação do play (espelho de `sign.ts` + `resolve_native.rs`) ────────

/// Play já separado do path + query. Sem host: o HMAC nunca o inclui.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvePlay {
    /// 40 hex em minúsculas (Node: `toLowerCase` antes de verificar).
    pub info_hash: String,
    /// Segmento de config na URL, se houver.
    pub encoded: Option<String>,
    /// `""` ou `"?s=<S>&e=<E>"` — o `?` faz parte do payload.
    pub ep: String,
    /// Dica `w` já percent-decoded (JSON cru); vazia = sem dica.
    pub hint: String,
    /// Query `sig`; `None` se ausente.
    pub sig: Option<String>,
}

/// Veredito da guarda HMAC. O handler HTTP traduz em status; este crate não
/// abre socket nem chama debrid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveVerify {
    /// Fora de `[a-f0-9]{40}` (após lowercasing).
    InvalidHash,
    /// Sem segredo efetivo — Node também pula o verify quando não há debrid.
    Unsigned,
    /// `sig` ausente/errada (tempo constante no núcleo).
    Forbidden,
    /// HMAC confere.
    Ok,
}

/// Path puro (sem query): `/resolve/<hash>` ou `/<config>/resolve/<hash>`.
///
/// Devolve `(encoded, info_hash_cru)`. Hash inválido ainda casa o path — a
/// validação hex fica em [`verify_resolve_play`] (400 no Node).
pub fn parse_resolve_path(path: &str) -> Option<(Option<String>, String)> {
    if path.contains('?') || path.contains('#') || !path.starts_with('/') {
        return None;
    }
    let mut raw: Vec<&str> = Vec::new();
    for segment in path[1..].split('/') {
        if segment.is_empty() {
            return None;
        }
        raw.push(segment);
    }
    match raw.as_slice() {
        ["resolve", hash] if !hash.is_empty() => Some((None, (*hash).to_string())),
        [config, "resolve", hash] if !hash.is_empty() && is_resolve_config_segment(config) => {
            Some((Some((*config).to_string()), (*hash).to_string()))
        }
        _ => None,
    }
}

fn is_resolve_config_segment(segment: &str) -> bool {
    // Mesmo teto/charset do `parse_stream_path` / `runtime.decode`.
    const MAX: usize = 8192;
    !segment.is_empty()
        && segment.len() <= MAX
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Monta [`ResolvePlay`] a partir do path + query da requisição.
pub fn resolve_play_from(path: &str, query: Option<&str>) -> Option<ResolvePlay> {
    let (encoded, hash_raw) = parse_resolve_path(path)?;
    let (s, e, hint, sig) = parse_resolve_query(query);
    let ep = match (&s, &e) {
        (Some(season), Some(episode)) => format!("?s={season}&e={episode}"),
        _ => String::new(),
    };
    Some(ResolvePlay {
        info_hash: hash_raw.to_ascii_lowercase(),
        encoded,
        ep,
        hint,
        sig,
    })
}

/// Query `s`/`e`/`w`/`sig`. Valores percent-decoded (como `req.query` no Express).
fn parse_resolve_query(
    query: Option<&str>,
) -> (Option<String>, Option<String>, String, Option<String>) {
    let mut s = None;
    let mut e = None;
    let mut hint = String::new();
    let mut sig = None;
    let Some(raw) = query.filter(|q| !q.is_empty()) else {
        return (s, e, hint, sig);
    };
    for pair in raw.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        let key = decode_uri_component(key);
        let value = decode_uri_component(value);
        match key.as_str() {
            "s" => s = Some(value),
            "e" => e = Some(value),
            "w" => hint = value,
            "sig" => sig = Some(value),
            _ => {}
        }
    }
    (s, e, hint, sig)
}

/// Inverso de [`encode_uri_component`]: `%XX` (qualquer caixa) → byte; `+` não
/// vira espaço (query de play não usa form-urlencoded).
pub fn decode_uri_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `resolveSecret || debridApiKey || ''` — mesma precedência de `sign.ts`.
pub fn effective_resolve_secret(resolve_secret: &str, debrid_api_key: &str) -> String {
    if !resolve_secret.is_empty() {
        resolve_secret.to_string()
    } else {
        debrid_api_key.to_string()
    }
}

/// Chave de debrid do segmento de config (abre `dk` selado com o secret).
pub fn debrid_api_key_from_encoded(encoded: &str, resolve_secret: &str) -> String {
    let defaults = serde_json::Value::Object(serde_json::Map::new());
    let Some(opts) = adom_core::decode_config(encoded, &defaults, resolve_secret) else {
        return String::new();
    };
    opts.get("debridApiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Segredo efetivo para esta requisição: env `RESOLVE_SECRET` ou `dk` da URL.
pub fn resolve_secret_for(resolve_secret: &str, encoded: Option<&str>) -> String {
    if !resolve_secret.is_empty() {
        return resolve_secret.to_string();
    }
    match encoded {
        Some(enc) => debrid_api_key_from_encoded(enc, ""),
        None => String::new(),
    }
}

/// Verifica o HMAC do play. Não toca rede/debrid.
pub fn verify_resolve_play(play: &ResolvePlay, secret: &str) -> ResolveVerify {
    if play.info_hash.len() != 40 || !play.info_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return ResolveVerify::InvalidHash;
    }
    if secret.is_empty() {
        return ResolveVerify::Unsigned;
    }
    if adom_core::verify_resolve(
        &play.info_hash,
        &play.ep,
        play.sig.as_deref(),
        &play.hint,
        secret,
    ) {
        ResolveVerify::Ok
    } else {
        ResolveVerify::Forbidden
    }
}

#[cfg(test)]
#[path = "resolve_url_tests.rs"]
mod tests;
