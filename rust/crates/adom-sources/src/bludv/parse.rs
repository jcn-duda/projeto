//! Parsers HTML do BLUDV — porte essencial de `parsePosts` /
//! `parseDownloadLinks` e extrator de magnet do protetor legado.
//!
//! O coletor de links segue a máquina do `createLinkCollector`: percorre as
//! âncoras EM ORDEM DE DOCUMENTO, mantém o áudio da seção (dublado/legendado)
//! e classifica qualidade/fonte/tamanho pelo contexto `segmento + âncora`.
//! É o mesmo contexto que o Node usa para montar o título e o tamanho do item.
//!
//! Gate (`/gate/go/…`): detectado e **pulado** no caminho de busca (o TS
//! só aproveita hit imediato com orçamento 0 ms; solve de ~30 s nunca entra
//! na resposta). Sem cache de gate nesta fatia → gate = miss.

use std::sync::LazyLock;

use regex::Regex;

use adom_core::decode_entities;

use super::title::{audio_from_anchor, audio_from_segment, normalize_quality, normalize_source};
use super::types::{BludvDownloadLink, BludvPost};

pub use super::title::clean_post_title;
pub use super::title::release_title;

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
/// documento, com áudio/qualidade/fonte/tamanho do contexto. O cliente de
/// busca **pula** o gate (sem solve).
pub fn parse_download_links(html: &str) -> Vec<BludvDownloadLink> {
    let mut out = Vec::new();
    let mut audio_state = "desconhecido".to_string();
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
        let Some((url_raw, after_url)) = take_quoted(href_region) else {
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

        // Segmento = tudo desde o botão anterior (carrega o cabeçalho da seção
        // e a especificação logo antes do botão), como o `slice(cursor, index)`
        // do `createLinkCollector`.
        let segment = strip_tags(&html[cursor..abs]).to_ascii_uppercase();
        if let Some(audio) = audio_from_segment(&segment) {
            audio_state = audio.to_string();
        }
        let anchor_text = anchor_text_after(after_url);
        let local = audio_from_anchor(&anchor_text.to_ascii_uppercase());
        let audio = local.unwrap_or(audio_state.as_str()).to_string();

        // `context = segment + anchorText` (o Node concatena com espaço).
        let context = format!("{segment} {}", anchor_text.to_ascii_uppercase());
        let size = last_size(&context);
        let quality = normalize_quality(&context);
        let source = normalize_source(&context).map(str::to_string);
        let label = parse_spec(&segment).0;

        out.push(BludvDownloadLink {
            url,
            label,
            size,
            audio,
            quality,
            source,
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

/// Texto da âncora: depois do `>` da tag de abertura até `</a>`.
fn anchor_text_after(after_url: &str) -> String {
    let Some(gt) = after_url.find('>') else {
        return String::new();
    };
    let inner = &after_url[gt + 1..];
    let end = find_ci(inner, "</a>").unwrap_or(inner.len());
    strip_tags(&inner[..end])
}

static SIZE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([\d.,]+)\s*(TB|GB|MB|KB)(?-u:\b)").expect("regex de tamanho")
});

/// Último `N GB` do contexto (o `matchAll(...).pop()` do Node), normalizado.
fn last_size(context: &str) -> Option<String> {
    let caps = SIZE_RE.captures_iter(context).last()?;
    let value = caps.get(1)?.as_str();
    let unit = caps.get(2)?.as_str().to_ascii_uppercase();
    Some(format!("{value} {unit}"))
}

static AD_GATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)/gate/go/[a-f0-9]{16}(?:\?p=[0-9]+)?").expect("regex do portão")
});

/// O HTML tem o portão de anúncio em QUALQUER lugar? É o `hasAdGate` do TS
/// (o post deixa de ser cacheável mesmo quando o botão foi descartado).
pub fn has_ad_gate(html: &str) -> bool {
    AD_GATE_RE.is_match(html)
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

/// "3.39 GB" / "3,39 GB" → bytes (o `parseSize` do TS).
pub fn parse_size(text: &str) -> Option<f64> {
    let caps = SIZE_RE.captures(text)?;
    let value: f64 = caps.get(1)?.as_str().replace(',', ".").parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    let mult = match caps.get(2)?.as_str().to_ascii_uppercase().as_str() {
        "KB" => 1024.0,
        "MB" => 1024.0_f64.powi(2),
        "GB" => 1024.0_f64.powi(3),
        "TB" => 1024.0_f64.powi(4),
        _ => return None,
    };
    Some((value * mult).round())
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
        if tag.contains("systemads") || tag.contains("videosad") || tag.contains("/gate/go/") {
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

/// Última especificação do segmento: "WEB-DL 2160p x265 DV HDR" (sem o
/// tamanho). É o `label` do botão; o título da release usa qualidade/fonte
/// classificadas do contexto, como o Node.
fn parse_spec(segment: &str) -> (String, Option<String>) {
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
    let Some((start, open, _close)) = best else {
        return (String::new(), None);
    };
    let mut label = collapse_ws(&segment[start..open]);
    // Corta prefixo se houver outra fonte no meio do label.
    if let Some(cut) = last_source_index(&label, &sources) {
        if cut > 0 {
            label = label[cut..].trim().to_string();
        }
    }
    (label, None)
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
#[path = "parse_tests.rs"]
mod tests;
