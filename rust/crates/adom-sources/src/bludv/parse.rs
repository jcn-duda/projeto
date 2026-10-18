//! Parsers HTML do BLUDV — porte essencial de `parsePosts` /
//! `parseDownloadLinks` e extrator de magnet do protetor legado.
//!
//! Gate (`/gate/go/…`): detectado e **pulado** no caminho de busca (o TS
//! só aproveita hit imediato com orçamento 0 ms; solve de ~30 s nunca entra
//! na resposta). Sem cache de gate nesta fatia → gate = miss.

use adom_core::decode_entities;

use super::types::{BludvDownloadLink, BludvPost};

/// Cards da página de busca: `div.post > div.title > a[href]`.
pub fn parse_posts(html: &str) -> Vec<BludvPost> {
    let mut posts = Vec::new();
    let mut rest = html;
    while let Some(post_idx) = find_ci(rest, "<div class=\"post\">") {
        let after_post = &rest[post_idx..];
        let Some(title_idx) = find_ci(after_post, "<div class=\"title\">") else {
            rest = &after_post[1..];
            continue;
        };
        let after_title = &after_post[title_idx..];
        let Some(href_start) = find_href(after_title) else {
            rest = &after_post[1..];
            continue;
        };
        let href_region = &after_title[href_start..];
        let Some((url_raw, after_url)) = take_quoted(href_region) else {
            rest = &after_post[1..];
            continue;
        };
        let Some(gt) = after_url.find('>') else {
            rest = &after_post[1..];
            continue;
        };
        let after_gt = &after_url[gt + 1..];
        let Some(close) = find_ci(after_gt, "</a>") else {
            rest = &after_post[1..];
            continue;
        };
        let title_html = &after_gt[..close];
        posts.push(BludvPost {
            url: decode_entities(url_raw.trim()),
            title: strip_tags(title_html),
        });
        rest = &after_gt[close + 4..];
    }
    posts
}

/// Links legado (`systemads`/`videosad`) e portão (`/gate/go/…`) em ordem de
/// documento, com seção de áudio. O cliente de busca **pula** o gate (sem solve).
pub fn parse_download_links(html: &str) -> Vec<BludvDownloadLink> {
    let mut out = Vec::new();
    let mut audio = "desconhecido".to_string();
    let mut cursor = 0usize;
    let lower = html.to_ascii_lowercase();
    let mut search_from = 0usize;

    while let Some(rel) = find_download_anchor(&lower[search_from..]) {
        let abs = search_from + rel;
        let tag_slice = &html[abs..];
        let Some(href_off) = find_href(tag_slice) else {
            search_from = abs + 1;
            continue;
        };
        let href_region = &tag_slice[href_off..];
        let Some((url_raw, _)) = take_quoted(href_region) else {
            search_from = abs + 1;
            continue;
        };
        let url = decode_entities(url_raw.trim());
        let is_legacy = is_legacy_protector(&url);
        let is_gate_path = url_looks_like_gate_path(&url);
        if !is_legacy && !is_gate_path {
            search_from = abs + 1;
            continue;
        }

        let segment = strip_tags(&html[cursor..abs]).to_ascii_uppercase();
        if let Some(marker) = last_audio_marker(&segment) {
            audio = marker.to_string();
        }
        let (label, size) = parse_spec(&segment);

        out.push(BludvDownloadLink {
            url,
            label,
            size,
            audio: audio.clone(),
        });

        // Avança após o `</a>` se existir.
        let close = tag_slice
            .to_ascii_lowercase()
            .find("</a>")
            .map(|i| abs + i + 4)
            .unwrap_or(abs + 1);
        cursor = close;
        search_from = close;
    }
    out
}

/// URL do portão de anúncio (`/gate/go/<16hex>?p=<digits>` no host BLUDV).
pub fn is_gate_url(value: &str, post_url: &str) -> bool {
    let Ok(post) = reqwest::Url::parse(post_url) else {
        return false;
    };
    let post_host = post.host_str().unwrap_or("");
    if !is_gate_host(post_host) {
        return false;
    }
    let url = match reqwest::Url::parse(value) {
        Ok(u) => u,
        Err(_) => match post.join(value) {
            Ok(u) => u,
            Err(_) => return false,
        },
    };
    if url.scheme() != "https" {
        // Em testes loopback aceitamos http do fake server — gate real é https.
        // Aqui só detectamos o path; o cliente de busca pula o gate de qualquer modo.
        if url.scheme() != "http" {
            return false;
        }
    }
    let host = url.host_str().unwrap_or("");
    if host != post_host && !is_gate_host(host) {
        return false;
    }
    let path = url.path();
    let Some(rest) = path.strip_prefix("/gate/go/") else {
        return false;
    };
    if rest.len() != 16 || !rest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let mut pairs = url.query_pairs();
    let Some((k, v)) = pairs.next() else {
        return false;
    };
    if pairs.next().is_some() || k != "p" {
        return false;
    }
    !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())
}

fn is_gate_host(host: &str) -> bool {
    matches!(
        host,
        "bludvfilmes.xyz"
            | "bludvfilmes1.xyz"
            | "bludv.net"
            | "bludv.xyz"
            | "bludv.to"
            | "127.0.0.1"
            | "localhost"
    )
}

/// Extrai o primeiro `magnet:?…` do HTML do protetor.
pub fn extract_magnet(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let start = lower.find("magnet:?")?;
    let slice = &body[start..];
    let end = slice
        .find(|c: char| c == '"' || c == '\'' || c == '<' || c == '>' || c.is_whitespace())
        .unwrap_or(slice.len());
    let mut magnet = slice[..end].to_string();
    while let Some(idx) = magnet.find("&amp;") {
        magnet.replace_range(idx..idx + 5, "&");
    }
    if is_valid_magnet_uri(&magnet) {
        Some(magnet)
    } else {
        None
    }
}

pub fn is_valid_magnet_uri(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if !lower.starts_with("magnet:?") {
        return false;
    }
    // Precisa de btih com 40 hex (ou 32 base32 — aceitamos ≥ 32 alnum).
    let Some(xt) = lower.find("xt=urn:btih:") else {
        return false;
    };
    let hash = &lower[xt + "xt=urn:btih:".len()..];
    let hash_end = hash
        .find(|c: char| c == '&' || c.is_whitespace())
        .unwrap_or(hash.len());
    let h = &hash[..hash_end];
    (h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        || (h.len() == 32 && h.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// "3.39 GB" → bytes.
pub fn parse_size(text: &str) -> Option<f64> {
    let mut parts = text.split_whitespace();
    let value_txt = parts.next()?;
    let unit = parts.next()?;
    let value: f64 = value_txt.replace(',', ".").parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    let mult = match unit.to_ascii_uppercase().as_str() {
        "KB" => 1024.0,
        "MB" => 1024.0_f64.powi(2),
        "GB" => 1024.0_f64.powi(3),
        "TB" => 1024.0_f64.powi(4),
        _ => return None,
    };
    Some((value * mult).round())
}

/// Título da release: post + label do botão (essencial do `releaseTitle`).
pub fn release_title(post_title: &str, link: &BludvDownloadLink) -> String {
    let post = post_title.trim();
    let label = link.label.trim();
    if label.is_empty() {
        post.to_string()
    } else {
        format!("{post} {label}")
    }
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    collapse_ws(&decode_entities(&out))
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    hay.to_ascii_lowercase().find(&needle.to_ascii_lowercase())
}

fn find_href(s: &str) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    let idx = lower.find("href=")?;
    Some(idx + 5)
}

fn take_quoted(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    let quote = s.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &s[quote.len_utf8()..];
    let end = rest.find(quote)?;
    Some((&rest[..end], &rest[end + quote.len_utf8()..]))
}

fn find_download_anchor(lower_slice: &str) -> Option<usize> {
    // Procura `<a` com systemads|videosad|/gate/go/ no mesmo tag.
    let mut search = 0usize;
    while let Some(rel) = lower_slice[search..].find("<a") {
        let abs = search + rel;
        let after = &lower_slice[abs..];
        let tag_end = after.find('>').unwrap_or(after.len().min(500));
        let tag = &after[..tag_end];
        if tag.contains("systemads")
            || tag.contains("videosad")
            || tag.contains("/gate/go/")
        {
            return Some(abs);
        }
        search = abs + 2;
    }
    None
}

fn is_legacy_protector(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && (lower.contains("systemads") || lower.contains("videosad"))
}

fn url_looks_like_gate_path(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("/gate/go/")
}

fn last_audio_marker(segment: &str) -> Option<&'static str> {
    // DUAL ÁUDIO / DUBLAD* → dublado; LEGENDAD* → legendado.
    let mut last: Option<&'static str> = None;
    let upper = segment;
    for (i, _) in upper.char_indices() {
        let rest = &upper[i..];
        if rest.starts_with("LEGENDAD") {
            last = Some("legendado");
            continue;
        }
        if rest.starts_with("DUBLAD") {
            last = Some("dublado");
            continue;
        }
        if rest.starts_with("DUAL") {
            let after = rest[4..].trim_start();
            if after.starts_with("ÁUDIO") || after.starts_with("AUDIO") {
                last = Some("dublado");
            }
        }
    }
    last
}

fn parse_spec(segment: &str) -> (String, Option<String>) {
    // Última ocorrência WEB-DL|BLURAY|…(…)
    let sources = ["WEB-DL", "BLURAY", "BLU-RAY", "BDRIP", "HDTV", "WEBRIP"];
    let mut best: Option<(usize, usize, usize)> = None; // start, paren_open, paren_close
    for (i, _) in segment.char_indices() {
        for src in &sources {
            if segment[i..].starts_with(src) {
                if let Some(rel_open) = segment[i..].find('(') {
                    let open = i + rel_open;
                    if let Some(rel_close) = segment[open + 1..].find(')') {
                        let close = open + 1 + rel_close;
                        best = Some((i, open, close));
                    }
                }
            }
        }
    }
    let Some((start, open, close)) = best else {
        return (String::new(), None);
    };
    let mut label = collapse_ws(&segment[start..open]);
    // Corta prefixo se houver outra fonte no meio do label.
    if let Some(cut) = last_source_index(&label, &sources) {
        if cut > 0 {
            label = label[cut..].trim().to_string();
        }
    }
    let size_raw = decode_entities(&segment[open + 1..close]);
    let size = size_raw
        .split(['-', '–', '—'])
        .next()
        .map(str::trim)
        .filter(|s| s.chars().any(|c| c.is_ascii_digit()))
        .map(str::to_string);
    (label, size)
}

fn last_source_index(label: &str, sources: &[&str]) -> Option<usize> {
    let upper = label.to_ascii_uppercase();
    let mut last = None;
    for (i, _) in upper.char_indices() {
        for src in sources {
            if upper[i..].starts_with(src) {
                last = Some(i);
            }
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_posts_basico() {
        let html = r#"
            <div class="post"><div class="title">
              <a href="https://bludv.example/filme/">Coringa (2019)</a>
            </div></div>
            <div class="post"><div class="title">
              <a href="https://bludv.example/outro/">Outro &amp; Filme</a>
            </div></div>
        "#;
        let posts = parse_posts(html);
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0].title, "Coringa (2019)");
        assert_eq!(posts[1].title, "Outro & Filme");
    }

    #[test]
    fn parse_download_links_respeita_secao_audio() {
        let html = r#"
            VERSÃO MKV DUAL ÁUDIO
            WEB-DL 1080p (3.39 GB - MKV)
            <a href="https://systemads.example/a">DL</a>
            VERSÃO MP4 LEGENDADO
            WEB-DL 720p (1.2 GB - MP4)
            <a href="https://videosad.example/b">DL</a>
        "#;
        let links = parse_download_links(html);
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].audio, "dublado");
        assert_eq!(links[0].size.as_deref(), Some("3.39 GB"));
        assert_eq!(links[1].audio, "legendado");
    }

    #[test]
    fn parse_download_links_inclui_gate() {
        let html = r#"
            <a href="https://systemads.example/a">DL</a>
            <a href="https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609">GATE</a>
        "#;
        let links = parse_download_links(html);
        assert_eq!(links.len(), 2);
        assert!(links[1].url.contains("/gate/go/"));
    }

    #[test]
    fn extract_magnet_valido() {
        let body = r#"<a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&amp;dn=x">x</a>"#;
        let m = extract_magnet(body).expect("magnet");
        assert!(m.starts_with("magnet:?"));
        assert!(!m.contains("&amp;"));
    }

    #[test]
    fn gate_url_detectado() {
        let post = "https://bludvfilmes1.xyz/post/";
        let gate = "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609";
        assert!(is_gate_url(gate, post));
        assert!(!is_gate_url("https://systemads.example/x", post));
    }
}
