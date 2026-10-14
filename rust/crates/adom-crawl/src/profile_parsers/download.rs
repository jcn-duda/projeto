//! Ponte do raspador para os botões de download do VacaTorrent.
//!
//! O corpo está em `crate::br_core::vaca` (port fiel de
//! `resolvers/profiles/vacatorrent-parsers.ts` + `resolvers/link-collector.ts` +
//! `resolvers/release-rules.ts`), porque o resolver lê o MESMO TypeScript e as
//! duas cópias divergiam. Aqui só ficam o endereço histórico da API
//! (`adom_crawl::profile_parsers::parse_download_links`), a lista base de
//! protetores e o wrapper que decide o que fazer com o `throw` do desempate.

use crate::br_core::vaca::post_links;
use crate::profile_parsers::ResolverLink;
use crate::shared::protector_suffixes;

// `VacaParseOptions` continua saindo daqui: é a API que os adaptadores do
// raspador e do resolver já importam de `profile_parsers`.
pub use crate::br_core::vaca::VacaParseOptions;

/// Base de protetores do TS (`resolvers/protector.ts::BASE_PROTECTOR_SUFFIXES`).
///
/// `t.co`/`vacadb.org` NÃO pertencem à base: em `vacatorrent-parsers.ts:51` eles
/// são `ASSERT_ONLY_SUFFIXES` (passagem no `assertAllowedUrl`), nunca botão de
/// download. A lista vive uma única vez em `shared::protector_suffixes`.
pub const BASE_PROTECTOR_SUFFIXES: &[&str] = protector_suffixes::PROTECTOR_SUFFIXES;

/// Protetores do VacaTorrent/comando: base do TS + `systemtech.space` do site
/// (`vacatorrent-parsers.ts:55-58`).
pub fn is_default_protector_host(hostname: &str) -> bool {
    protector_suffixes::is_protector_host(hostname)
}

/// `parseDownloadLinks` com o `throw` do desempate VISÍVEL.
///
/// Autoridade: `vacatorrent-parsers.ts:92-100` passa o `packPattern` CRU (sem
/// `/g`) como `packMatchAll` e `release-rules.ts:222-228` faz o `matchAll` do JS
/// lançar `TypeError`; `link-collector.ts:94-106` NÃO envolve o botão emitido em
/// `try/catch`, então o post inteiro falha. Devolver lista parcial seria inventar
/// um comportamento que o TS não tem.
pub fn try_parse_download_links(
    html: &str,
    base_url: Option<&str>,
    is_protector_host: Option<&dyn Fn(&str) -> bool>,
    options: Option<&VacaParseOptions>,
) -> Result<Vec<ResolverLink>, String> {
    if html.is_empty() {
        return Ok(Vec::new());
    }
    let sem_opcoes = VacaParseOptions::default();
    post_links(
        html,
        base_url,
        options.unwrap_or(&sem_opcoes),
        is_protector_host,
    )
}

/// Parseia botões de download do VacaTorrent (filme ou episódio).
///
/// Variante tolerante da API histórica: o `Err` do desempate vira lista VAZIA
/// (exatamente o que o `throw` produz para quem chama — nenhum botão), e o
/// `page_parser` cai no status `no_torrent`. Quem precisa distinguir "sem
/// torrent" de "o parser explodiu" deve usar `try_parse_download_links`.
pub fn parse_download_links(
    html: &str,
    base_url: Option<&str>,
    is_protector_host: Option<&dyn Fn(&str) -> bool>,
    options: Option<&VacaParseOptions>,
) -> Vec<ResolverLink> {
    try_parse_download_links(html, base_url, is_protector_host, options).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_protetores_bate_com_o_ts() {
        // Base do TS (`protector.ts:9-15`).
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

    /// O `Err` do desempate tem que ser VISÍVEL na variante `try_` e degradar
    /// para vazio na histórica — nunca lista parcial.
    #[test]
    fn empate_devolve_zero_botoes_e_o_motivo() {
        let html = r#"<div>EPISÓDIO 3 TEMPORADA COMPLETA</div>
            <a href="https://systemtech.space/enc/go.php?id=1">Download 1080p (2 GB)</a>"#;
        let erro = try_parse_download_links(html, Some("https://vaca.example/x/"), None, None);
        assert!(
            matches!(&erro, Err(e) if e.contains("matchAll")),
            "{erro:?}"
        );
        assert_eq!(
            parse_download_links(html, Some("https://vaca.example/x/"), None, None),
            Vec::new()
        );
    }
}
