//! Gate URL validation and link parsing - port of resolvers/profiles/bludv-gate-links.ts.
//!
//! Hosts EXATOS do gate; nao altera protetores globais nem allowlists compartilhadas.

use std::sync::LazyLock;

use fancy_regex::Captures;
use url::Url;

use crate::common::collector::{parse_download_links, CollectorHooks, Resolved, Step};
use crate::common::text::decode_entities;
use adom_crawl::profile_parsers::ResolverLink;

use super::Hooks;

/// Hosts do BLUDV que publicam o portao. Lista LOCAL ao gate.
static GATE_HOSTS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    vec![
        "bludvfilmes.xyz",
        "bludvfilmes1.xyz",
        "bludvfilmes2.xyz",
        "bludv.net",
        "bludv.xyz",
        "bludv.to",
    ]
});

pub fn in_gate_hosts(host: &str) -> bool {
    GATE_HOSTS.contains(&host)
}

/// Valida e parseia uma URL como gate (HTTPS, sem credenciais, porta, hash, espaco).
pub fn safe_gate_url(value: &str, base: Option<&str>) -> Option<Url> {
    if value.is_empty() || value.len() > 4096 || value.contains(' ') || value.contains('\\') {
        return None;
    }
    let url = match base {
        Some(b) => match Url::parse(value) {
            Ok(u) => u,
            Err(_) => Url::parse(b).ok()?.join(value).ok()?,
        },
        None => Url::parse(value).ok()?,
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url)
}

/// O URL e um botao valido do portao?
pub fn is_gate_url(value: &str, post_url: Option<&str>) -> bool {
    let post = match post_url {
        Some(p) => {
            let parsed = safe_gate_url(p, None);
            match parsed {
                Some(ref u) if in_gate_hosts(u.host_str().unwrap_or("")) => parsed,
                _ => return false,
            }
        }
        None => None,
    };
    let base = post.as_ref().map(|u| u.as_str());
    let url = match safe_gate_url(value, base) {
        Some(u) => u,
        None => return false,
    };
    let host = url.host_str().unwrap_or("");
    if !in_gate_hosts(host) {
        return false;
    }
    if let Some(ref p) = post {
        if p.host_str().unwrap_or("") != host {
            return false;
        }
    }
    let path = url.path();
    if !is_gate_path(path) {
        return false;
    }
    let params: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    if params.len() != 1 || params[0].0 != "p" {
        return false;
    }
    !params[0].1.is_empty() && params[0].1.bytes().all(|b| b.is_ascii_digit())
}

fn is_gate_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/gate/go/") else {
        return false;
    };
    rest.len() == 16 && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Hooks do coletor que reconhecem gate + legado.
struct GateHooks;

impl CollectorHooks for GateHooks {
    fn anchor_re(&self) -> &fancy_regex::Regex {
        Hooks.anchor_re()
    }
    fn resolve_href(
        &self,
        caps: &Captures<'_, str>,
        html: &str,
        base_url: Option<&str>,
    ) -> Resolved {
        let raw = caps.get(2).map_or("", |m| m.as_str()).trim();
        let href = decode_entities(raw);
        if let Some(post) = base_url {
            if is_gate_url(&href, Some(post)) {
                if let Some(url) = safe_gate_url(&href, Some(post)) {
                    return Resolved::Url(url.to_string());
                }
            }
        }
        Hooks.resolve_href(caps, html, base_url)
    }
    fn anchor_text_of(&self, caps: &Captures<'_, str>) -> String {
        Hooks.anchor_text_of(caps)
    }
    fn strip_tags(&self, value: &str) -> String {
        Hooks.strip_tags(value)
    }
    fn initial_audio(&self) -> Option<String> {
        Hooks.initial_audio()
    }
    fn audio_from_segment(&self, segment: &str) -> Option<String> {
        Hooks.audio_from_segment(segment)
    }
    fn audio_from_anchor(&self, anchor_text: &str) -> Option<String> {
        Hooks.audio_from_anchor(anchor_text)
    }
    fn episode_step(
        &self,
        segment: &str,
        anchor: &str,
        state: Option<u32>,
    ) -> Result<Step, String> {
        Hooks.episode_step(segment, anchor, state)
    }
    fn quality(&self, context: &str) -> Option<u32> {
        Hooks.quality(context)
    }
    fn source(&self, context: &str) -> Option<String> {
        Hooks.source(context)
    }
}

/// Raspa gate + legado na ordem do HTML (uma so maquina de metadados).
pub fn parse_gate_and_legacy_links(
    html: &str,
    post_url: &str,
) -> Result<Vec<ResolverLink>, String> {
    parse_download_links(&GateHooks, html, Some(post_url))
}

/// So os links do portao (para o resolve/dl decidir a cadeia).
pub fn parse_gate_links(html: &str, post_url: &str) -> Vec<ResolverLink> {
    parse_gate_and_legacy_links(html, post_url)
        .unwrap_or_default()
        .into_iter()
        .filter(|l| is_gate_url(&l.url, Some(post_url)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_url_valido() {
        let gate = "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609";
        assert!(is_gate_url(gate, Some("https://bludvfilmes1.xyz/post/")));
        // Domínio para onde o site redireciona desde 2026-10-24.
        let novo = "https://bludvfilmes2.xyz/gate/go/0646028353024d92?p=60609";
        assert!(is_gate_url(novo, Some("https://bludvfilmes2.xyz/post/")));
    }

    #[test]
    fn rejeita_nao_https() {
        assert!(!is_gate_url(
            "http://bludvfilmes1.xyz/gate/go/0646028353024d92?p=1",
            Some("https://bludvfilmes1.xyz/post/")
        ));
    }

    #[test]
    fn rejeita_porta() {
        assert!(!is_gate_url(
            "https://bludvfilmes1.xyz:8443/gate/go/0646028353024d92?p=1",
            Some("https://bludvfilmes1.xyz/post/")
        ));
    }

    #[test]
    fn rejeita_credenciais() {
        assert!(!is_gate_url(
            "https://user:pass@bludvfilmes1.xyz/gate/go/0646028353024d92?p=1",
            Some("https://bludvfilmes1.xyz/post/")
        ));
    }

    #[test]
    fn rejeita_hash() {
        assert!(!is_gate_url(
            "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=1#frag",
            Some("https://bludvfilmes1.xyz/post/")
        ));
    }

    #[test]
    fn rejeita_host_fora() {
        assert!(!is_gate_url(
            "https://malware.example/gate/go/0646028353024d92?p=1",
            Some("https://bludvfilmes1.xyz/post/")
        ));
    }

    #[test]
    fn rejeita_multiplos_params() {
        assert!(!is_gate_url(
            "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=1&x=2",
            Some("https://bludvfilmes1.xyz/post/")
        ));
    }

    #[test]
    fn rejeita_p_nao_numerico() {
        assert!(!is_gate_url(
            "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=abc",
            Some("https://bludvfilmes1.xyz/post/")
        ));
    }

    #[test]
    fn rejeita_hex_invalido_no_path() {
        assert!(!is_gate_url(
            "https://bludvfilmes1.xyz/gate/go/ZZZZZZZZZZZZZZZZ?p=1",
            Some("https://bludvfilmes1.xyz/post/")
        ));
    }

    #[test]
    fn gate_e_legado_coexistem() {
        let html = r#"<a href="https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609" class="customButton">Magnet-Link</a>
<a href="https://systemads1.com/go/aaa111">Download 1080p (2 GB)</a>"#;
        let links = parse_gate_and_legacy_links(html, "https://bludvfilmes1.xyz/post/").unwrap();
        assert_eq!(links.len(), 2);
        assert!(is_gate_url(
            &links[0].url,
            Some("https://bludvfilmes1.xyz/post/")
        ));
        assert!(!is_gate_url(
            &links[1].url,
            Some("https://bludvfilmes1.xyz/post/")
        ));
    }

    #[test]
    fn safe_rejeita_espaco_e_backslash() {
        assert!(safe_gate_url("https://bludv.to/a b", None).is_none());
        assert!(safe_gate_url("https://bludv.to/a\\b", None).is_none());
    }
}
