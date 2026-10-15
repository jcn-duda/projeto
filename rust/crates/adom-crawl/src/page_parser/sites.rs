//! Resolve-href por site, fiel ao parser TS de cada profile.
//!
//! O ramo genérico de `parse_crawl_page` (BLUDV, ComandoTorrents, NerdFilmes e
//! TorrentDosFilmes) NÃO compartilha uma régua única de link: cada profile tem a
//! sua. Os gates aqui são os MESMOS do TS (`bludv-parsers.ts`,
//! `nerdfilmes-parsers.ts`, `torrentdosfilmes-parsers.ts`):
//!
//! - **NerdFilmes** aceita magnet direto ESTRITO, protetor externo ABSOLUTO e o
//!   gate de MESMO ORIGIN `/link.php` (o protetor do site). Sem a terceira
//!   regra, todo post do nerd com botão `/link.php` cai em `no-torrent` — e é
//!   justamente o que o parser da vaca (usado antes no ramo genérico) fazia.
//! - **BLUDV** aceita magnet direto ESTRITO ou protetor ABSOLUTO (`new URL`
//!   SEM base: relativo nunca é protetor aqui).
//! - **TorrentDosFilmes** aceita qualquer href com prefixo `magnet:?`
//!   (case-SENSITIVE de propósito, comportamento histórico do profile) ou
//!   protetor ABSOLUTO.
//! - **ComandoTorrents** usa o resolvedor de protetor compartilhado
//!   (`createProtectorHrefResolver` == `profile_parsers::parse_download_links`,
//!   a mesma régua da vaca): por isso ele NÃO tem função própria aqui.
//!
//! Metadado de release (qualidade/áudio/episódio/tamanho) não é reproduzido:
//! nem o parity nem o shadow comparam esses campos — ambos chaveiam por `btih` e
//! por status/título/ano/IMDb de página. Reproduzi-los exigiria a máquina de
//! estados completa do `createLinkCollector`, sem ganho de paridade.

use adom_core::decode_entities;
use regex::Regex;
use std::sync::OnceLock;
use url::Url;

use crate::profile_parsers::{is_default_protector_host, is_valid_magnet_uri, ResolverLink};

/// Link cru aceito (só a URL decide a paridade); metadado fica no default.
fn link(url: &str) -> ResolverLink {
    ResolverLink {
        url: url.to_string(),
        ..ResolverLink::default()
    }
}

/// Valor do atributo `href` de uma tag de abertura (`<a …>`), tolerando espaços.
fn href_of(tag: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"(?i)\bhref\s*=\s*["']([^"']*)["']"#).unwrap());
    re.captures(tag).map(|c| c[1].to_string())
}

/// Tags de abertura `<a …>` do documento, na ordem (só a tag; o href sai dela).
fn anchor_tags(html: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)<a\b([^>]*)>").unwrap());
    re.captures_iter(html).map(|c| c[1].to_string()).collect()
}

/// `/link.php` de MESMO ORIGIN (o protetor embutido do NerdFilmes). Compara
/// scheme+host+porta (o `origin` do JS) e o caminho em minúsculas.
fn same_origin_link_php(u: &Url, base: &Url) -> bool {
    u.scheme() == base.scheme()
        && u.host_str() == base.host_str()
        && u.port_or_known_default() == base.port_or_known_default()
        && u.path().to_lowercase() == "/link.php"
}

/// Href aceito pelo NerdFilmes (magnet estrito | protetor absoluto | /link.php).
fn nerd_resolve(href: &str, base_url: Option<&str>) -> Option<ResolverLink> {
    if is_valid_magnet_uri(href) {
        return Some(link(href));
    }
    // Protetor externo: só URL ABSOLUTA (contrato histórico — relativo nunca era
    // protetor). Host fora da allowlist cai no gate same-origin abaixo.
    if let Ok(abs) = Url::parse(href) {
        if is_default_protector_host(abs.host_str().unwrap_or("")) {
            return Some(link(href));
        }
    }
    let base = Url::parse(base_url?).ok()?;
    let u = base.join(href).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    if !same_origin_link_php(&u, &base) {
        return None;
    }
    Some(link(u.as_str()))
}

/// Botões do NerdFilmes (`nerdfilmes-parsers.ts::createNerdDownloadLinks`).
pub fn parse_nerdfilmes_links(html: &str, base_url: Option<&str>) -> Vec<ResolverLink> {
    let mut out = Vec::new();
    for tag in anchor_tags(html) {
        let Some(raw) = href_of(&tag) else { continue };
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        if let Some(parsed) = nerd_resolve(&decode_entities(raw), base_url) {
            out.push(parsed);
        }
    }
    out
}

/// Botões do BLUDV (`bludv-parsers.ts::createParseDownloadLinks`): magnet
/// estrito (`isValidMagnetUri`) ou protetor ABSOLUTO. Ignora `base_url` — o
/// profile resolve com `new URL(href)` sem base.
pub fn parse_bludv_links(html: &str) -> Vec<ResolverLink> {
    let mut out = Vec::new();
    for tag in anchor_tags(html) {
        let Some(raw) = href_of(&tag) else { continue };
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let href = decode_entities(raw);
        if is_valid_magnet_uri(&href) {
            out.push(link(&href));
        } else if let Ok(u) = Url::parse(&href) {
            if is_default_protector_host(u.host_str().unwrap_or("")) {
                out.push(link(&href));
            }
        }
    }
    out
}

/// Botões do TorrentDosFilmes (`torrentdosfilmes-parsers.ts`): `magnet:?` por
/// prefixo (case-SENSITIVE) ou protetor ABSOLUTO. Ignora `base_url`.
pub fn parse_tdf_links(html: &str) -> Vec<ResolverLink> {
    let mut out = Vec::new();
    for tag in anchor_tags(html) {
        let Some(raw) = href_of(&tag) else { continue };
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let href = decode_entities(raw);
        if href.starts_with("magnet:?") {
            out.push(link(&href));
        } else if let Ok(u) = Url::parse(&href) {
            if is_default_protector_host(u.host_str().unwrap_or("")) {
                out.push(link(&href));
            }
        }
    }
    out
}

// ─── portao de anuncio do BLUDV (deteccao honesta no raspador) ──────────────

/// Hosts do BLUDV que publicam o portao de anuncios. Lista LOCAL ao gate do
/// site: NAO e protetor global nem amplia allowlist compartilhada.
const BLUDV_GATE_HOSTS: &[&str] = &[
    "bludvfilmes.xyz",
    "bludvfilmes1.xyz",
    "bludv.net",
    "bludv.xyz",
    "bludv.to",
];

/// O href e um botao do portao? HTTPS, host do BLUDV, `/gate/go/<16hex>` e um
/// unico `p` numerico; rejeita porta, credencial e fragmento.
pub fn bludv_is_gate_button(href: &str) -> bool {
    let Ok(u) = Url::parse(href) else {
        return false;
    };
    if u.scheme() != "https"
        || u.port().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return false;
    }
    let host = u.host_str().unwrap_or("");
    if !BLUDV_GATE_HOSTS.contains(&host) {
        return false;
    }
    let Some(rest) = u.path().strip_prefix("/gate/go/") else {
        return false;
    };
    if rest.len() != 16 || !rest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let pairs: Vec<_> = u.query_pairs().collect();
    pairs.len() == 1
        && pairs[0].0 == "p"
        && !pairs[0].1.is_empty()
        && pairs[0].1.bytes().all(|b| b.is_ascii_digit())
}

/// Hrefs dos botoes do portao, na ordem da pagina. O post so-gate vira
/// `gate-pending` com o PRIMEIRO deles (o post publica um portao por botao de
/// download, todos apontando para o mesmo pagamento — um basta para colher).
pub fn bludv_gate_buttons(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    for tag in anchor_tags(html) {
        let Some(raw) = href_of(&tag) else { continue };
        let href = decode_entities(raw.trim());
        if bludv_is_gate_button(&href) {
            out.push(href);
        }
    }
    out
}

#[cfg(test)]
mod gate_tests {
    use super::*;

    #[test]
    fn reconhece_botao_do_portao() {
        assert!(bludv_is_gate_button(
            "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609"
        ));
    }

    #[test]
    fn rejeita_variaveis_inseguras() {
        for bad in [
            "http://bludvfilmes1.xyz/gate/go/0646028353024d92?p=1",
            "https://bludvfilmes1.xyz:8443/gate/go/0646028353024d92?p=1",
            "https://user@bludvfilmes1.xyz/gate/go/0646028353024d92?p=1",
            "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=1#f",
            "https://malware.example/gate/go/0646028353024d92?p=1",
            "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=1&x=2",
            "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=abc",
            "https://bludvfilmes1.xyz/gate/go/ZZZZZZZZZZZZZZZZ?p=1",
        ] {
            assert!(!bludv_is_gate_button(bad), "{bad}");
        }
    }

    #[test]
    fn pagina_so_portao_tem_botao_de_portao() {
        let html = r#"<div class="downloads">
            <a href="https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609" class="customButton">Baixar</a>
        </div>"#;
        assert!(!bludv_gate_buttons(html).is_empty(), "pagina so-portao tem o botao");
        assert!(
            parse_bludv_links(html).is_empty(),
            "portao nao e link coletavel"
        );
    }
}
