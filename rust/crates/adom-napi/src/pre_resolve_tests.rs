use super::*;

fn post(title: &str) -> PreResolvePost {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    PreResolvePost {
        title: Some(title.to_string()),
        title_pascal: None,
        magnet: None,
        magnet_uri: None,
        guid: None,
        is_br: false,
        info_hash: None,
        // URL única por post: senão o dedupe por downloadUrl come os casos.
        download_url: Some(format!("https://tracker.example/file{n}.torrent")),
        link_trusted: false,
    }
}

fn query() -> PreResolveQuery {
    PreResolveQuery {
        names: Vec::new(),
        wanted: Some("Filme".to_string()),
        year: None,
        query_year: None,
        alt_year: None,
        is_series: false,
        season: None,
        episode: None,
        multi_work_root: None,
        home_release_at: None,
        br_is_series: false,
        requested_season: None,
        requested_ep_season: None,
        requested_ep: None,
        max_resolves: 20,
        allow_private_urls: false,
    }
}

fn settings() -> PreResolveSettings {
    PreResolveSettings {
        now_ms: 1_760_000_000_000,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: 48 * 3600 * 1000,
        title_precision_tail_cut: true,
    }
}

#[test]
fn marcador_de_temporada_espelha_a_regex_do_ts() {
    // "S01E05": \bS(\d{1,2})\b não casa (o E cola no dígito) — como no JS.
    assert_eq!(title_season_marker("Serie S01E05 1080p"), None);
    assert_eq!(title_season_marker("Serie S01 1080p"), Some(1));
    assert_eq!(title_season_marker("Serie 2ª Temporada"), Some(2));
    assert_eq!(title_season_marker("Serie 3º TEMPORADA COMPLETA"), Some(3));
    assert_eq!(title_season_marker("Serie 3 ª Temporada"), Some(3));
    assert_eq!(title_season_marker("AbS01 resto"), None); // sem borda antes
    assert_eq!(title_season_marker("S012 x"), None); // \b falha nos 2 e no 1
    assert_eq!(title_season_marker("sem marcador"), None);
}

#[test]
fn score_espelha_a_ordem_do_ts() {
    let s4k_dual = resolve_candidate_score("Filme (2024) 4K 2160p Dual Áudio WEB-DL", None, None);
    let s1080_dual = resolve_candidate_score("Filme (2024) 1080p Dual Áudio WEB-DL", None, None);
    let s_cam = resolve_candidate_score("Filme (2024) 1080p Dual Áudio CAM", None, None);
    assert!(s4k_dual > s1080_dual);
    assert!(s1080_dual > s_cam);
    // Bônus de episódio pedido.
    assert!(resolve_candidate_score("Serie S01E05", Some(1), Some(5)) > 0);
}

#[test]
fn lote_aprova_filtrando_e_ordenando() {
    let mut posts = vec![
        post("Outra Obra 2020 1080p DUBLADO"),
        post("Filme 2020 1080p Dublado WEB-DL"),
        post("Filme 2020 CAM Dublado"),
        post("Filme 2020 2160p Dual Áudio BluRay"),
        post("Filme S03 1080p"),
    ];
    posts[4].download_url = Some("http://127.0.0.1:9117/dl/x".to_string());
    posts[3].info_hash = Some("abc".to_string());
    let mut q = query();
    q.requested_season = Some(1);
    let out = pre_resolve_br_napi(posts, q, settings());
    // 0 = outra obra; 4 = temporada errada ("S03" contra S01 pedida).
    // A URL privada do índice 4 bloqueada antes do fetch? Não: 4 já morreu
    // na etapa de temporada — a guarda de URL só roda pós-slice.
    assert_eq!(out.approved, vec![3, 1, 2]);
    assert_eq!(out.rejected.len(), 2);
    assert_eq!(out.rejected[0].index, 0);
    assert_eq!(out.rejected[0].reason, REJECT_TITLE);
    assert_eq!(out.rejected[1].index, 4);
    assert_eq!(out.rejected[1].reason, REJECT_SEASON);
}

#[test]
fn url_insegura_rejeitada_so_pos_slice() {
    let mut posts = vec![
        post("Filme 2020 CAM Dublado"),
        post("Filme 2020 2160p Dual BluRay"),
    ];
    // O CAM sobrevive ao corte: fica na lista SEM fetch, só marcado.
    posts[0].download_url = Some("http://127.0.0.1:9117/api/x".to_string());
    let out = pre_resolve_br_napi(posts, query(), settings());
    assert_eq!(out.approved, vec![1, 0]);
    assert_eq!(out.rejected.len(), 1);
    assert_eq!(out.rejected[0].index, 0);
    assert_eq!(out.rejected[0].reason, REJECT_UNSAFE_URL);
}

#[test]
fn url_insegura_cortada_pelo_teto_nem_chega_a_guarda() {
    let posts = vec![
        post("Filme 2020 CAM Dublado"), // score baixo, fora do teto 1
        post("Filme 2020 2160p Dual BluRay"),
    ];
    let mut q = query();
    q.max_resolves = 1;
    let out = pre_resolve_br_napi(posts, q, settings());
    // O CAM (índice 0) nem chega ao corte da URL: foi cortado pelo teto.
    assert_eq!(out.approved, vec![1]);
    assert!(out.rejected.is_empty());
}

#[test]
fn link_confiado_passa_da_guarda_de_url() {
    let mut posts = vec![post("Filme 2020 Dublado")];
    posts[0].link_trusted = true;
    posts[0].download_url = Some("http://127.0.0.1:7000/dl/bludv/a".to_string());
    let out = pre_resolve_br_napi(posts, query(), settings());
    assert_eq!(out.approved, vec![0]);
    assert!(out.rejected.is_empty());
}

#[test]
fn url_insegura_aprovada_com_allow_private() {
    let mut posts = vec![post("Filme 2020 Dublado")];
    posts[0].download_url = Some("http://192.168.1.10/file".to_string());
    let mut q = query();
    q.allow_private_urls = true;
    let out = pre_resolve_br_napi(posts, q, settings());
    assert_eq!(out.approved, vec![0]);
}

#[test]
fn episodiode_outro_episodio_rejeitado() {
    let posts = vec![
        post("Filme S01E02 1080p Dublado"),
        post("Filme S01E05 1080p"),
    ];
    let mut q = query();
    q.requested_ep_season = Some(1);
    q.requested_ep = Some(5);
    let out = pre_resolve_br_napi(posts, q, settings());
    assert_eq!(out.approved, vec![1]);
    assert_eq!(out.rejected[0].index, 0);
    assert_eq!(out.rejected[0].reason, REJECT_EPISODE);
}

#[test]
fn duplicado_por_url_rejeitado() {
    let mut posts = vec![post("Filme 2020 Dublado"), post("Filme 2020 Dublado x")];
    posts[1].download_url = posts[0].download_url.clone();
    let out = pre_resolve_br_napi(posts, query(), settings());
    assert_eq!(out.approved, vec![0]);
    assert_eq!(out.rejected[0].index, 1);
    assert_eq!(out.rejected[0].reason, REJECT_DUPLICATE);
}

#[test]
fn lote_vazio_devolve_vazio() {
    let out = pre_resolve_br_napi(Vec::new(), query(), settings());
    assert!(out.approved.is_empty() && out.rejected.is_empty());
}
