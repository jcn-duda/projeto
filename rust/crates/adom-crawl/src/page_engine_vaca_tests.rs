use super::*;

const POST: &str = r#"<h1 class="custom-main-title">Resident Evil</h1>
<div class="streaming-container"><a href="https://vaqueirofilmes.com/movie-links/63714/" class="mf-card">6 links</a></div>"#;
const MAGNET: &str =
    "magnet:?xt=urn:btih:c63e38cc6e205c95e008b63023cc565e61673293&dn=ResidentEvil2026WEB-DL1080";

fn link(url: &str) -> ResolverLink {
    ResolverLink {
        url: url.to_string(),
        ..ResolverLink::default()
    }
}

/// Markup real de `/pt/movie-links/63714/` (2026-11-02), reduzido.
const LINKS_PAGE: &str = r#"<div class="ml-links-box">
<div><p class="ml-group-label">Assistir</p>
<a href="https://vaqueirofilmes.com/pt/movie/resident-evil/?video=0" class="ml-btn ml-btn-video">Veja Online</a></div>
<div><p class="ml-group-label">Download</p><div class="dl-btn-wrap">
<a href="https://vaqueirofilmes.com/enc/go.php?id=ic4GCg1EIMbo" class="ml-btn">Português | Inglês • 1080p • 1.87 GB</a>
</div></div></div>"#;

#[test]
fn botao_no_host_do_site_e_reconhecido_e_veja_online_nao() {
    let links = try_parse_download_links(
        LINKS_PAGE,
        Some("https://vaqueirofilmes.com/pt/movie-links/63714/"),
        None,
        None,
    )
    .expect("botões");
    let urls: Vec<&str> = links.iter().map(|l| l.url.as_str()).collect();
    assert_eq!(
        urls,
        vec!["https://vaqueirofilmes.com/enc/go.php?id=ic4GCg1EIMbo"]
    );
}

#[test]
fn post_real_aponta_a_pagina_de_links() {
    assert_eq!(
        extract_movie_links(
            POST,
            Some("https://vaqueirofilmes.com/pt/movie/resident-evil/")
        )
        .as_deref(),
        Some("https://vaqueirofilmes.com/movie-links/63714/")
    );
}

#[test]
fn post_seguido_vira_done_com_o_magnet() {
    let mut found = link(MAGNET);
    found.quality = Some(1080);
    let parsed = page_parser::parse_vaca_followed(
        "movie",
        "https://vaqueirofilmes.com/pt/movie/resident-evil/",
        POST,
        &[found],
    );
    assert_eq!(parsed.status, "done");
    assert_eq!(parsed.releases.len(), 1);
    assert_eq!(parsed.releases[0].magnet, MAGNET);
}

#[test]
fn obra_so_streaming_segue_no_torrent() {
    let parsed = page_parser::parse_vaca_followed(
        "movie",
        "https://vaqueirofilmes.com/pt/movie/resident-evil/",
        POST,
        &[],
    );
    assert_eq!(parsed.status, "no-torrent");
}

#[test]
fn cadeia_sem_magnet_e_falha_nunca_no_torrent() {
    let erro = settle_buttons(vec![link("https://x/a")], vec![ButtonEnd::Lost]).unwrap_err();
    assert!(erro.starts_with("layout:"), "{erro}");
}

#[test]
fn acerto_parcial_aproveita_e_botao_vazio_nao_e_falha() {
    let links = vec![link("https://x/a"), link("https://x/b")];
    let ok = settle_buttons(
        links,
        vec![ButtonEnd::Lost, ButtonEnd::Magnet(MAGNET.to_string())],
    )
    .expect("parcial");
    assert_eq!(ok.len(), 1);
    assert_eq!(ok[0].url, MAGNET);
    let vazio = settle_buttons(vec![link("https://x/a")], vec![ButtonEnd::Empty]).expect("vazio");
    assert!(vazio.is_empty());
}

#[test]
fn rede_e_transitoria_e_terminais_nao_voltam_a_fila() {
    assert!(button_end(ProtectorError::Timeout).is_err());
    assert!(button_end(ProtectorError::HttpError(403)).is_err());
    assert_eq!(
        button_end(ProtectorError::LinkExpired),
        Ok(ButtonEnd::Empty)
    );
    assert_eq!(button_end(ProtectorError::NoMagnet), Ok(ButtonEnd::Lost));
}

#[test]
fn post_sem_caminho_so_passa_com_a_marca_do_tema() {
    assert!(no_hop("<div class=\"streaming-container\"></div>").is_ok());
    assert!(no_hop("<h1>Novo Endereço</h1>").is_err());
}

#[test]
fn semente_leva_so_o_clearance() {
    assert_eq!(
        clearance_of("_svu=1; cf_clearance=abc=d; HstPt=2").as_deref(),
        Some("cf_clearance=abc=d")
    );
    assert_eq!(clearance_of("_svu=1"), None);
}

/// `data-link` real de série: o magnet em base64 vem com `&#038;` no lugar de `&`.
#[test]
fn data_link_de_serie_sai_com_entidade_decodificada() {
    let html = r#"<a data-link="bWFnbmV0Oj94dD11cm46YnRpaDpiNjE3ZGQ3NzgzZDBkNjllYjJjODZjY2NmZjY2MmU0Y2I1YzlmM2Q2JiMwMzg7ZG49Q292ZW4=">x</a>"#;
    assert_eq!(
        magnet::VACA.extract(html).as_deref(),
        Some("magnet:?xt=urn:btih:b617dd7783d0d69eb2c86cccff662e4cb5c9f3d6&dn=Coven")
    );
}

// ─── Fase 1.3: corte de botões e Fase 1.2: telemetria de done magro ────────

/// Magnet válido por índice: 40 hex únicos, para volume sem dedupe de hash.
fn magnet_n(i: usize) -> String {
    format!("magnet:?xt=urn:btih:{:040x}&dn=Botao{i}", i)
}

fn botoes(n: usize) -> Vec<ResolverLink> {
    (0..n)
        .map(|i| link(&format!("https://vaqueirofilmes.com/enc/go.php?id=b{i}")))
        .collect()
}

/// Página com mais botões que o teto: o total é capturado ANTES do corte e o
/// marcador do `progress` traz a contagem exata (Fase 1.3).
#[test]
fn corte_captura_o_total_e_monta_o_marcador_de_progresso() {
    let (cortados, total) = take_buttons(botoes(MAX_BUTTONS + 57));
    assert_eq!(total, MAX_BUTTONS + 57, "total visto antes do corte");
    assert_eq!(cortados.len(), MAX_BUTTONS);
    assert_eq!(
        clipped_progress(total, cortados.len()),
        format!(
            r#"{{"buttonsClipped":{},"buttonsSeen":{}}}"#,
            MAX_BUTTONS + 57,
            MAX_BUTTONS
        )
    );
}

/// Página dentro do teto: nada é cortado (Fase 1.3).
#[test]
fn dentro_do_teto_nao_ha_corte() {
    let (links, total) = take_buttons(botoes(MAX_BUTTONS));
    assert_eq!((links.len(), total), (MAX_BUTTONS, MAX_BUTTONS));
}

/// Volume no teto, por si só, não muda o desfecho do parser: `done` sai como
/// sempre — o corte é só de quantidade seguida (Fase 1.3).
#[test]
fn parser_com_volume_no_teto_mantem_done() {
    let links: Vec<ResolverLink> = (0..MAX_BUTTONS).map(|i| link(&magnet_n(i))).collect();
    let parsed = page_parser::parse_vaca_followed(
        "movie",
        "https://vaqueirofilmes.com/pt/movie/resident-evil/",
        POST,
        &links,
    );
    assert_eq!(parsed.status, "done");
    assert_eq!(parsed.releases.len(), MAX_BUTTONS);
}

/// `done` com 1 release: a telemetria (Fase 1.2) é só log — status e releases
/// seguem inalterados.
#[test]
fn done_com_um_release_mantem_o_status_e_sobe_telemetria() {
    let parsed = page_parser::parse_vaca_followed(
        "movie",
        "https://vaqueirofilmes.com/pt/movie/resident-evil/",
        POST,
        &[link(MAGNET)],
    );
    assert_eq!(parsed.status, "done");
    assert_eq!(parsed.releases.len(), 1);
    assert_eq!(scarce_message(1, 1), "done com 1 release(s), 1 botão(ões)");
}

/// Formato do log do corte: é o que a medição no Docker vai buscar.
#[test]
fn mensagem_do_corte_tem_o_formato_do_log() {
    assert_eq!(
        clip_message(MAX_BUTTONS + 57),
        format!("{} botões, cortado em {MAX_BUTTONS}", MAX_BUTTONS + 57)
    );
}
