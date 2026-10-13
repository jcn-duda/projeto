use super::*;
use adom_core::decode_entities;
use regex::Regex;
use std::sync::OnceLock;

// ─── VacaTorrent / Coletor (`parseDownloadLinks`) ────────────────────────────

/// Base de protetores do TS (`resolvers/protector.ts::BASE_PROTECTOR_SUFFIXES`).
///
/// `t.co`/`vacadb.org` NÃO pertencem à base: em `vacatorrent-parsers.ts` eles são
/// `ASSERT_ONLY_SUFFIXES` (passagem no `assertAllowedUrl`), nunca botão de
/// download. `encurtador.com.br`/`linktracker.top` não existem no TS.
pub const BASE_PROTECTOR_SUFFIXES: &[&str] = &[
    "systemads1.com",
    "systemads.net",
    "videosad.net",
    "canalfutebol.com",
    "temreceita.com",
];

/// Protetores extras do SITE VacaTorrent
/// (`vacatorrent-parsers.ts::ALL_PROTECTOR_SUFFIXES` = base + estes).
const VACA_SITE_PROTECTOR_SUFFIXES: &[&str] = &["systemtech.space"];

fn host_matches(hostname: &str, suffixes: &[&str]) -> bool {
    let h = hostname.to_lowercase();
    suffixes
        .iter()
        .any(|s| h == *s || h.ends_with(&format!(".{s}")))
}

/// Verifica se o host é protetor pela BASE do TS (NerdFilmes/BLUDV/TDF usam esta).
pub fn is_default_protector_host(hostname: &str) -> bool {
    host_matches(hostname, BASE_PROTECTOR_SUFFIXES)
}

/// Protetores do VacaTorrent/comando: base do TS + `systemtech.space` do site.
fn is_vaca_protector_host(hostname: &str) -> bool {
    host_matches(hostname, BASE_PROTECTOR_SUFFIXES)
        || host_matches(hostname, VACA_SITE_PROTECTOR_SUFFIXES)
}

/// Número do episódio a partir do `re_ep`: o padrão é uma alternância e cada
/// match preenche SÓ UM dos três grupos (`EPISÓDIO 8`→1, `S5E08`→2, `E08`→3).
/// `c[1]` direto panica ("no group at index '1'") quando o match vem de 2/3;
/// aqui usa-se o grupo que participou.
fn episode_number(c: &regex::Captures<'_>) -> Option<u32> {
    c.get(1)
        .or_else(|| c.get(2))
        .or_else(|| c.get(3))
        .and_then(|m| m.as_str().parse::<u32>().ok())
}

/// `extractEpisode` do TS (`resolvers/release-rules.ts`): faixa
/// ("Episódios 01 ao 08") é PACK → `None`; senão devolve o ÚLTIMO marcador do
/// texto (não o primeiro) — é a regra que resolve o card S5 do vaca em 8.
fn extract_episode(text: &str, re_ep: &Regex, re_range: &Regex) -> Option<u32> {
    if re_range.is_match(text) {
        return None;
    }
    re_ep
        .captures_iter(text)
        .last()
        .and_then(|c| episode_number(&c))
}

/// Opções extras para `parse_download_links` (ex.: season e real_title do batch).
#[derive(Debug, Clone, Default)]
pub struct VacaParseOptions {
    pub season: Option<u32>,
    pub real_title: Option<String>,
}

/// Parseia botões de download do VacaTorrent (filme ou episódio).
pub fn parse_download_links(
    html: &str,
    base_url: Option<&str>,
    is_protector_host: Option<&dyn Fn(&str) -> bool>,
    options: Option<&VacaParseOptions>,
) -> Vec<ResolverLink> {
    if html.is_empty() {
        return Vec::new();
    }
    // Como o `createLinkCollector` do TS: decodifica as entidades HTML do
    // documento INTEIRO (após o `normalizeEpisodeMarkup`) antes de parsear, então
    // o href chega com `&` (não `&amp;`). `extract_attr` não decodifica de novo;
    // `strip_tags` decodifica o texto — mesma ordem de `decodeHtml`/`stripTags`.
    let normalized_html = decode_entities(&normalize_episode_markup(html));

    static RE_A: OnceLock<Regex> = OnceLock::new();
    let re_a = RE_A.get_or_init(|| Regex::new(r#"(?i)<a\b([^>]*)>([\s\S]*?)</a>"#).unwrap());

    static RE_SIZE: OnceLock<Regex> = OnceLock::new();
    let re_size = RE_SIZE.get_or_init(|| Regex::new(r"(?i)([\d.,]+)\s*(TB|GB|MB|KB)\b").unwrap());

    static RE_EP: OnceLock<Regex> = OnceLock::new();
    let re_ep = RE_EP.get_or_init(|| {
        Regex::new(r"(?i)(?:EPIS[ÓO]DIO|EP|CAP[ÍI]TULO|CAP)[.\s-]*(\d{1,3})\b|\bS\d{1,2}E(\d{1,3})\b|\bE(\d{1,3})\b").unwrap()
    });

    // `rangePattern` do vaca (`vacatorrent-parsers.ts`): faixa é PACK.
    static RE_RANGE: OnceLock<Regex> = OnceLock::new();
    let re_range = RE_RANGE.get_or_init(|| {
        Regex::new(r"(?i)(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\-s]*\d{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*\d{1,3}\b").unwrap()
    });

    let mut links = Vec::new();
    let mut current_audio: Option<String> = None;
    let mut current_ep: Option<u32> = None;
    let mut cursor = 0;

    let checker = is_protector_host.unwrap_or(&is_vaca_protector_host);

    for cap in re_a.captures_iter(&normalized_html) {
        let whole_match = cap.get(0).unwrap();
        let attrs = &cap[1];
        let anchor_raw = &cap[2];
        let anchor_text = strip_tags(anchor_raw);

        if is_watch_anchor(attrs, &anchor_text) {
            continue;
        }

        let raw_href = extract_attr(attrs, "href").unwrap_or_default();
        let raw_href = raw_href.trim();
        if raw_href.is_empty() {
            continue;
        }

        let resolved_url = if raw_href.starts_with("magnet:") || raw_href.starts_with("MAGNET:") {
            Some(normalize_magnet_uri(raw_href))
        } else {
            let mut resolved = None;
            if let Some(base) = base_url {
                if let Ok(b) = url::Url::parse(base) {
                    if let Ok(target) = b.join(raw_href) {
                        let mut check_host = target.host_str().unwrap_or("").to_string();
                        // Verifica parâmetro ?to=
                        for (k, v) in target.query_pairs() {
                            if k.eq_ignore_ascii_case("to") {
                                if let Ok(nested) = url::Url::parse(&v) {
                                    if let Some(nh) = nested.host_str() {
                                        check_host = nh.to_string();
                                    }
                                }
                            }
                        }
                        if checker(&check_host) {
                            resolved = Some(target.into());
                        }
                    }
                }
            }
            resolved
        };

        let Some(target_url) = resolved_url else {
            cursor = whole_match.end();
            continue;
        };

        let segment_slice = &normalized_html[cursor..whole_match.start()];
        let segment = strip_tags(segment_slice);
        cursor = whole_match.end();

        // 1. Áudio
        if let Some(seg_aud) = classify_vaca_audio(&segment) {
            current_audio = Some(seg_aud.to_string());
        }
        let local_audio = classify_vaca_audio(&anchor_text).map(String::from);
        let audio = local_audio.or_else(|| current_audio.clone());

        // 2. Episódio (escopo `anchor-writes` do TS): a âncora vence; senão o
        // ÚLTIMO marcador do segmento (estado do card); senão mantém o estado.
        if let Some(ep) = extract_episode(&anchor_text, re_ep, re_range) {
            current_ep = Some(ep);
        } else if let Some(ep) = extract_episode(&segment, re_ep, re_range) {
            current_ep = Some(ep);
        }

        // 3. Qualidade, fonte e tamanho
        let context = format!("{segment} {anchor_text}");
        let quality = normalize_quality(&context);
        let source = normalize_source(&context);

        let size = re_size
            .captures_iter(&context)
            .last()
            .map(|c| format!("{} {}", &c[1], &c[2]));

        let item = ResolverLink {
            url: target_url,
            quality,
            size,
            audio,
            episode: current_ep,
            episode_last: None,
            season: options.and_then(|o| o.season),
            source: source.map(String::from),
            real_title: options.and_then(|o| o.real_title.clone()),
            description: None,
        };

        links.push(item);
    }

    links
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_protetores_bate_com_o_ts() {
        // Base do TS (`protector.ts`).
        for host in [
            "systemads1.com",
            "systemads.net",
            "videosad.net",
            "canalfutebol.com",
            "temreceita.com",
        ] {
            assert!(is_default_protector_host(host), "{host}");
            assert!(
                is_default_protector_host(&format!("cdn.{host}")),
                "sub {host}"
            );
        }
        // `systemtech.space` é extra do SITE (vaca), não da base.
        assert!(!is_default_protector_host("systemtech.space"));
        // `t.co`/`vacadb.org` são ASSERT_ONLY no TS; os outros dois não existem.
        for host in ["t.co", "vacadb.org", "encurtador.com.br", "linktracker.top"] {
            assert!(!is_default_protector_host(host), "{host}");
        }
    }

    #[test]
    fn parse_download_links_aceita_protetores_da_base_ts() {
        let html = r#"
            <div class="downloads">
                <p>Português | Inglês</p>
                <a href="https://systemads1.com/enc/go.php?id=a">Download 1080p (2.0 GB)</a>
                <a href="https://cdn.systemads.net/enc/go.php?id=b">Download 720p (1.0 GB)</a>
                <a href="https://nao-protetor.example/x">Download 480p (0.5 GB)</a>
            </div>
        "#;
        let links = parse_download_links(html, Some("https://vacatorrent.com/x/"), None, None);
        let urls: Vec<&str> = links.iter().map(|l| l.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://systemads1.com/enc/go.php?id=a",
                "https://cdn.systemads.net/enc/go.php?id=b",
            ]
        );
    }
}
