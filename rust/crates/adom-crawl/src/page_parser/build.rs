//! Montagem do `CrawlPageParsed` a partir dos links ACEITOS pelo parser do
//! site: filtro de magnet, dedupe por `btih`, agrupamento de série e o parser
//! JSON do Mico (que não tem página nem `<h1>`).

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::listing::parse_size;
use crate::mico::parse_mico_url;
use crate::profile_parsers::{extract_magnet, release_title, ResolverLink};
use crate::season_page::{page_season_of, season_page_groups, SeasonPageInfo};
use crate::shared::magnet_hash;

use super::types::{CrawlPageParsed, CrawlParsedGroup, CrawlParsedRelease};

/// Magnet de um link aceito: `extract_magnet` para magnet válido; senão o
/// prefixo `magnet:?` cru (o TorrentDosFilmes publica `magnet:?` sem validar).
fn magnet_of(link: &ResolverLink) -> Option<String> {
    extract_magnet(&link.url).or_else(|| {
        if link.url.starts_with("magnet:?") {
            Some(link.url.clone())
        } else {
            None
        }
    })
}

pub(super) fn build_release_from_link(
    title: &str,
    year: Option<i64>,
    indexer: &str,
    tracker: &str,
    link: &ResolverLink,
) -> CrawlParsedRelease {
    let rel_title = release_title(title, year.map(|y| y as u32), link, None);
    let magnet = extract_magnet(&link.url).unwrap_or_else(|| link.url.clone());
    let size_str = link.size.as_ref().map(|s| {
        parse_size(s)
            .map(|_| s.clone())
            .unwrap_or_else(|| s.clone())
    });

    CrawlParsedRelease {
        title: rel_title,
        magnet,
        indexer: indexer.to_string(),
        tracker: tracker.to_string(),
        is_br: true,
        seeders: 1,
        size: size_str,
    }
}

/// Releases MAGNET da página (dedupe por hash). Links sem magnet — URL de
/// protetor — são descartados da SAÍDA de releases (fronteira documentada do
/// shadow); quem decide `done` vs `no-torrent` é a contagem de links aceitos.
fn releases_from_links(
    title: &str,
    year: Option<i64>,
    indexer: &str,
    tracker: &str,
    links: &[ResolverLink],
) -> Vec<CrawlParsedRelease> {
    let mut releases = Vec::new();
    let mut seen_hashes = HashSet::new();

    for link in links {
        let Some(magnet) = magnet_of(link) else {
            continue;
        };

        if let Some(h) = magnet_hash(&magnet) {
            if !seen_hashes.insert(h) {
                continue;
            }
        }

        releases.push(build_release_from_link(
            title,
            year,
            indexer,
            tracker,
            &ResolverLink {
                url: magnet,
                quality: link.quality,
                size: link.size.clone(),
                audio: link.audio.clone(),
                episode: link.episode,
                episode_last: link.episode_last,
                season: link.season,
                source: link.source.clone(),
                real_title: link.real_title.clone(),
                description: link.description.clone(),
            },
        ));
    }

    releases
}

/// Resultado `done` a partir dos releases já montados (série = grupos).
#[allow(clippy::too_many_arguments)]
fn outcome_from_releases(
    url: &str,
    title: String,
    year: Option<i64>,
    imdb: Option<String>,
    work_type: &str,
    releases: Vec<CrawlParsedRelease>,
    is_series: bool,
) -> CrawlPageParsed {
    if !is_series {
        return CrawlPageParsed {
            url: url.to_string(),
            status: "done".to_string(),
            imdb,
            title: Some(title),
            year,
            original_title: None,
            season: None,
            work_type: Some(work_type.to_string()),
            releases,
            groups: Vec::new(),
            unlocated: Vec::new(),
            error: None,
        };
    }

    let season_decl = page_season_of(&title, url);
    let parsed_groups = season_page_groups(
        &releases,
        &SeasonPageInfo {
            season: season_decl,
            title: &title,
        },
    )
    .into_iter()
    .map(|g| CrawlParsedGroup {
        season: g.season,
        episode: g.episode,
        releases: g.releases,
    })
    .collect();

    CrawlPageParsed {
        url: url.to_string(),
        status: "done".to_string(),
        imdb,
        title: Some(title),
        year,
        original_title: None,
        season: season_decl,
        work_type: Some(work_type.to_string()),
        releases: Vec::new(),
        groups: parsed_groups,
        unlocated: Vec::new(),
        error: None,
    }
}

/// Monta o resultado a partir dos links do parser do site.
///
/// `magnet_required` distingue as duas famílias de branch:
/// - `true` (Apache/HDR/RedeTorrent/Vaca): o parser só devolve magnet; sem
///   release, `no-torrent` é o honesto (comportamento histórico).
/// - `false` (BLUDV/Comando/NerdFilmes/TDF): o parser também aceita BOTÃO de
///   protetor (URL sem magnet). A página TEM torrent mesmo quando este parser
///   puro ainda não resolveu o magnet → `done` com a lista de releases só de
///   magnet. Sem isso, todo post com protetor virava `no-torrent` no Rust
///   enquanto o TS dizia `done` (divergência sistemática de paridade/shadow).
#[allow(clippy::too_many_arguments)]
pub(super) fn build_parsed_outcome(
    url: &str,
    title: String,
    year: Option<i64>,
    imdb: Option<String>,
    work_type: &str,
    indexer: &str,
    tracker: &str,
    links: &[ResolverLink],
    is_series: bool,
    magnet_required: bool,
) -> CrawlPageParsed {
    let releases = releases_from_links(&title, year, indexer, tracker, links);

    if releases.is_empty() && magnet_required {
        return CrawlPageParsed::no_torrent(
            url,
            Some(title),
            year,
            imdb,
            Some(work_type.to_string()),
        );
    }

    outcome_from_releases(url, title, year, imdb, work_type, releases, is_series)
}

/// `INFO_HASH` do TS (`src/providers/mico.ts`): exatamente 40 dígitos hex.
fn is_valid_info_hash(hash: &str) -> bool {
    hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `cleanTitle` do TS (`src/providers/mico.ts`): tira os sufixos `👥 N`,
/// `💾 X GB`, parênteses de idiomas `(brazilian, eng)`, truncamento `(…`/`…`,
/// emojis, e colapsa espaços.
fn clean_mico_title(first_line: &str) -> String {
    static RE_EYES: OnceLock<Regex> = OnceLock::new();
    static RE_FLOPPY: OnceLock<Regex> = OnceLock::new();
    static RE_LANGS: OnceLock<Regex> = OnceLock::new();
    static RE_TRUNC: OnceLock<Regex> = OnceLock::new();
    static RE_ELLIPSIS: OnceLock<Regex> = OnceLock::new();
    static RE_EMOJI: OnceLock<Regex> = OnceLock::new();
    static RE_SPACE: OnceLock<Regex> = OnceLock::new();

    let eyes = RE_EYES.get_or_init(|| Regex::new(r"\s*👥.*$").unwrap());
    let floppy = RE_FLOPPY.get_or_init(|| Regex::new(r"\s*💾.*$").unwrap());
    let langs = RE_LANGS
        .get_or_init(|| Regex::new(r"(?i)\s*\((?:[a-z]+(?:\s*,\s*[a-z]+)*)\)\s*$").unwrap());
    let trunc = RE_TRUNC.get_or_init(|| Regex::new(r"(?i)\s*\([a-z ,]*…\s*$").unwrap());
    let ellipsis = RE_ELLIPSIS.get_or_init(|| Regex::new(r"…\s*$").unwrap());
    let emoji =
        RE_EMOJI.get_or_init(|| Regex::new(r"[\p{Extended_Pictographic}\u{FE0F}]").unwrap());
    let space = RE_SPACE.get_or_init(|| Regex::new(r"\s+").unwrap());

    let mut s = first_line.to_string();
    s = eyes.replace_all(&s, "").into_owned();
    s = floppy.replace_all(&s, "").into_owned();
    s = langs.replace_all(&s, "").into_owned();
    s = trunc.replace_all(&s, "").into_owned();
    s = ellipsis.replace_all(&s, "").into_owned();
    s = emoji.replace_all(&s, "").into_owned();
    s = space.replace_all(&s, " ").into_owned();
    s.trim().to_string()
}

/// Título de um stream do Mico: primeira linha de `title`, limpa por
/// `clean_mico_title`. Vazio → `None` (o TS DESCARTA o item). O TS usa SÓ
/// `title` (`mapStream`); NÃO há fallback para `name`.
fn mico_stream_title(item: &serde_json::Value) -> Option<String> {
    let raw = item.get("title").and_then(|t| t.as_str())?;
    let first = raw.lines().next().unwrap_or("");
    let clean = clean_mico_title(first);
    if clean.is_empty() {
        None
    } else {
        Some(clean)
    }
}

pub(super) fn parse_mico_content(url: &str, is_series: bool, json_text: &str) -> CrawlPageParsed {
    let parsed_url = parse_mico_url(url, None);
    let imdb = parsed_url.as_ref().map(|p| p.imdb.clone());

    let v: serde_json::Value = match serde_json::from_str(json_text) {
        Ok(val) => val,
        Err(e) => return CrawlPageParsed::error(url, &format!("mico json inválido: {e}")),
    };

    // Pode ser resposta de streams: { "streams": [...] }
    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        let mut releases = Vec::new();
        // `seen` pelo hash MINÚSCULO, como o Set do `fetchMicoStreams`.
        let mut seen: HashSet<String> = HashSet::new();
        for item in streams {
            // Só hash btih válido (40 hex) entra — como o `INFO_HASH` do TS.
            let info_hash = item
                .get("infoHash")
                .and_then(|h| h.as_str())
                .unwrap_or("")
                .trim();
            if !is_valid_info_hash(info_hash) {
                continue;
            }
            let hash = info_hash.to_lowercase();
            // Sem título válido (após o fallback `name`) descarta — nada de
            // "Mico Release" espúrio.
            let Some(title) = mico_stream_title(item) else {
                continue;
            };
            // Dedupe por infoHash.
            if !seen.insert(hash.clone()) {
                continue;
            }

            releases.push(CrawlParsedRelease {
                title,
                magnet: format!("magnet:?xt=urn:btih:{hash}"),
                indexer: "mico".to_string(),
                tracker: "Mico".to_string(),
                is_br: true,
                seeders: 1,
                size: None,
            });
        }

        return CrawlPageParsed {
            url: url.to_string(),
            status: if releases.is_empty() {
                "no-torrent".to_string()
            } else {
                "done".to_string()
            },
            imdb,
            title: None,
            year: None,
            original_title: None,
            season: None,
            work_type: Some(if is_series { "series" } else { "movie" }.to_string()),
            releases,
            groups: Vec::new(),
            unlocated: Vec::new(),
            error: None,
        };
    }

    CrawlPageParsed::no_torrent(
        url,
        None,
        None,
        imdb,
        Some(if is_series { "series" } else { "movie" }.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mico_deduplica_e_valida_hash_titulo() {
        let a = "a".repeat(40);
        let b = "B".repeat(40); // maiúsculo: o hash normaliza para minúsculo
        let c = "c".repeat(40);
        let json = format!(
            r#"{{"streams":[
                {{"infoHash":"{a}","title":"Filme Um"}},
                {{"infoHash":"{a}","title":"Filme Um (dup)"}},
                {{"infoHash":"invalido","title":"Sem hash"}},
                {{"infoHash":"{b}","title":"Filme Dois\nlinha extra"}},
                {{"infoHash":"{c}"}}
            ]}}"#,
        );
        let parsed = parse_mico_content("https://mico.example/tt1234567/movie", false, &json);
        assert_eq!(parsed.status, "done");
        assert_eq!(parsed.releases.len(), 2);
        assert_eq!(
            parsed.releases[0].magnet,
            format!("magnet:?xt=urn:btih:{a}")
        );
        assert_eq!(
            parsed.releases[1].magnet,
            format!("magnet:?xt=urn:btih:{}", b.to_lowercase())
        );
        assert_eq!(parsed.releases[0].title, "Filme Um");
        assert_eq!(parsed.releases[1].title, "Filme Dois");
        // Nunca o título espúrio do fallback antigo.
        assert!(parsed.releases.iter().all(|r| r.title != "Mico Release"));
    }

    #[test]
    fn parse_mico_sem_title_e_hash_invalido() {
        // Sem `title` (mesmo com `name`) o TS DESCARTA o item — não há fallback.
        let d = "d".repeat(40);
        let json = format!(r#"{{"streams":[{{"infoHash":"{d}","name":"Via Nome"}}]}}"#);
        let parsed = parse_mico_content("https://mico.example/tt1/movie", false, &json);
        assert!(parsed.releases.is_empty());
        assert_eq!(parsed.status, "no-torrent");

        // Sem hash válido (40 hex) não emite release.
        let so_invalido = r#"{"streams":[{"infoHash":"xyz","title":"Sem hash válido"}]}"#;
        let parsed2 = parse_mico_content("https://mico.example/tt1/movie", false, so_invalido);
        assert!(parsed2.releases.is_empty());
        assert_eq!(parsed2.status, "no-torrent");
    }

    #[test]
    fn parse_mico_limpa_titulo_como_o_ts() {
        // `cleanTitle`: tira `👥 N`, `💾 X GB` e `(brazilian, eng)`.
        let e = "e".repeat(40);
        let json = format!(
            r#"{{"streams":[{{"infoHash":"{e}","title":"Filme Emoji 👥 12 💾 1.5 GB (brazilian, eng)"}}]}}"#
        );
        let parsed = parse_mico_content("https://mico.example/tt1/movie", false, &json);
        assert_eq!(parsed.releases.len(), 1);
        assert_eq!(parsed.releases[0].title, "Filme Emoji");
    }
}
