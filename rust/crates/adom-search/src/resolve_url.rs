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
//!   `p:1` (pack multiobra admitido), `d:1` (dublado/claim) e `i` (IMDb id) —
//!   nesta ORDEM, porque o HMAC é sobre a string, não sobre JSON canônico;
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
    pub fn url(&self, hash: &str, dubbed: bool, multi_work_admitted: bool) -> String {
        let ep = match (self.season, self.episode) {
            (Some(season), Some(episode)) => format!("?s={season}&e={episode}"),
            _ => String::new(),
        };
        let hint = self.hint_json(dubbed, multi_work_admitted);
        let sig = adom_core::sign_resolve(hash, &ep, &hint, &self.secret);
        let mut url = String::new();
        url.push_str(&self.prefix);
        url.push_str("/resolve/");
        url.push_str(hash);
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
    fn hint_json(&self, dubbed: bool, multi_work_admitted: bool) -> String {
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
            if multi_work_admitted {
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

#[cfg(test)]
mod tests {
    use super::*;
    use adom_core::verify_resolve;

    fn signer() -> ResolveSigner {
        ResolveSigner {
            prefix: "/e30".into(),
            secret: "segredo-de-teste".into(),
            season: None,
            episode: None,
            imdb_id: Some("tt0133093".into()),
            work_hint: Some(WorkHint {
                names: vec!["The Matrix".into(), "Matrix".into()],
                year: Some(1999),
            }),
        }
    }

    #[test]
    fn url_do_corpus_bate_a_forma_do_node() {
        let url = signer().url("8cc4fdc2c777d1464d9043397309f45859b9297b", true, false);
        // Forma capturada em `rust/golden/stream-e2e/cases/movie-matrix`.
        assert!(url.starts_with(
            "/e30/resolve/8cc4fdc2c777d1464d9043397309f45859b9297b?w=%7B%22n%22%3A%5B%22The%20Matrix%22%2C%22Matrix%22%5D%2C%22y%22%3A1999%2C%22d%22%3A1%2C%22i%22%3A%22tt0133093%22%7D&sig="
        ), "{url}");
    }

    #[test]
    fn hmac_cobre_hash_episodio_e_dica() {
        let signer = ResolveSigner {
            season: Some(1),
            episode: Some(2),
            ..signer()
        };
        let url = signer.url("0123456789abcdef0123456789abcdef01234567", true, true);
        assert!(url.contains("/resolve/0123456789abcdef0123456789abcdef01234567?s=1&e=2&w="));
        let sig = url.rsplit("sig=").next().unwrap();
        let hint =
            "{\"n\":[\"The Matrix\",\"Matrix\"],\"y\":1999,\"p\":1,\"d\":1,\"i\":\"tt0133093\"}";
        assert!(verify_resolve(
            "0123456789abcdef0123456789abcdef01234567",
            "?s=1&e=2",
            Some(sig),
            hint,
            "segredo-de-teste"
        ));
        // Signature do host não entra no payload: trocar o prefixo não muda o sig.
        let outro = ResolveSigner {
            prefix: String::new(),
            ..signer.clone()
        };
        let url2 = outro.url("0123456789abcdef0123456789abcdef01234567", true, true);
        assert_eq!(url2.rsplit("sig=").next(), Some(sig));
    }

    #[test]
    fn sem_dica_o_payload_e_so_hash_e_ep() {
        let signer = ResolveSigner {
            secret: "k".into(),
            ..ResolveSigner::default()
        };
        let url = signer.url("aa", false, false);
        assert_eq!(
            url,
            format!(
                "/resolve/aa?sig={}",
                adom_core::sign_resolve("aa", "", "", "k")
            )
        );
    }

    #[test]
    fn segredo_vazio_nao_assinavel() {
        let signer = ResolveSigner::default();
        assert!(signer.url("aa", false, false).ends_with("sig="));
    }

    #[test]
    fn encode_uri_component_igual_ao_js() {
        assert_eq!(encode_uri_component("a-b_c.d!~*'()"), "a-b_c.d!~*'()");
        assert_eq!(
            encode_uri_component("{\"n\":[\"A B\"]}"),
            "%7B%22n%22%3A%5B%22A%20B%22%5D%7D"
        );
        assert_eq!(encode_uri_component("ção"), "%C3%A7%C3%A3o");
    }
}
