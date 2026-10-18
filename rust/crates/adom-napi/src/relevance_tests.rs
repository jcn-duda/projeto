use super::*;

fn entry(title: &str) -> RelevanceEntry {
    RelevanceEntry {
        title: Some(title.to_string()),
        title_pascal: None,
        magnet: None,
        magnet_uri: None,
        guid: None,
        is_br: false,
    }
}

fn query(names: &[&str]) -> RelevanceQueryNapi {
    query_for_ano(names, "2020")
}

fn query_for_ano(names: &[&str], year: &str) -> RelevanceQueryNapi {
    RelevanceQueryNapi {
        names: names.iter().map(|s| s.to_string()).collect(),
        year: year.to_string(),
        alt_year: None,
        is_series: false,
        season: None,
        episode: None,
        multi_work_root: None,
        home_release_at: None,
    }
}

fn settings() -> RelevanceSettingsNapi {
    RelevanceSettingsNapi {
        now_ms: 1_760_000_000_000,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: 48 * 3600 * 1000,
        title_precision_tail_cut: true,
    }
}

#[test]
fn mantem_o_caso_e_rejeita_o_outro_obra() {
    let out = filter_relevant_raw_napi(
        vec![
            entry("Outra Obra 2020 1080p"),
            entry("Filme 2020 1080p DUBLADO"),
        ],
        query(&["Filme"]),
        settings(),
    );
    assert_eq!(out.kept, vec![1]);
    assert_eq!(out.rejected.len(), 1);
    assert_eq!(out.rejected[0].index, 0);
    assert_eq!(out.rejected[0].reason, 0); // 'title'
}

#[test]
fn sem_nomes_nada_e_filtrado() {
    let out = filter_relevant_raw_napi(vec![entry("Qualquer Coisa")], query(&[]), settings());
    assert_eq!(out.kept, vec![0]);
    assert!(out.rejected.is_empty());
}

#[test]
fn inventario_resgata_pack_da_franquia() {
    let q = RelevanceQueryNapi {
        season: None,
        ..query(&["Star Trek"])
    };
    let out = filter_inventory_relevant_napi(
        vec![entry("FILMOGRAFIA COMPLETA STAR TREK-PTBR")],
        q,
        settings(),
    );
    assert_eq!(out.kept, vec![0]);
}

#[test]
fn lote_vazio_devolve_vazio() {
    let out = filter_relevant_raw_napi(Vec::new(), query(&["Filme"]), settings());
    assert!(out.kept.is_empty() && out.rejected.is_empty());
}

// --- Conversão napi -> core (a lógica em si é golden do core) ---

#[allow(clippy::too_many_arguments)]
fn entry_campos(
    title: Option<&str>,
    title_pascal: Option<&str>,
    magnet: Option<&str>,
    magnet_uri: Option<&str>,
    guid: Option<&str>,
    is_br: bool,
) -> RelevanceEntry {
    RelevanceEntry {
        title: title.map(String::from),
        title_pascal: title_pascal.map(String::from),
        magnet: magnet.map(String::from),
        magnet_uri: magnet_uri.map(String::from),
        guid: guid.map(String::from),
        is_br,
    }
}

/// (a) `title` vazio mas `title_pascal` preenchido: o `||` do JS tem que
/// valer depois da conversão (campo vazio = ausente).
#[test]
fn title_vazio_cai_no_title_pascal() {
    let out = filter_relevant_raw_napi(
        vec![entry_campos(
            Some(""),
            Some("Filme 2020 1080p DUBLADO"),
            None,
            None,
            None,
            false,
        )],
        query(&["Filme"]),
        settings(),
    );
    assert_eq!(out.kept, vec![0]);
    assert!(out.rejected.is_empty());
}

/// (b) `magnet` vazio mas `magnet_uri` preenchido: o `dn=` do URI tem que
/// chegar ao `magnet_year_contradicts` (ano longe do catálogo -> reason 1).
#[test]
fn magnet_vazio_cai_no_magnet_uri() {
    let out = filter_relevant_raw_napi(
        vec![entry_campos(
            Some("Filme 2020 1080p"),
            None,
            Some(""),
            Some("magnet:?dn=Filme+2030+1080p"),
            None,
            false,
        )],
        query(&["Filme"]),
        settings(),
    );
    assert!(out.kept.is_empty());
    assert_eq!(out.rejected.len(), 1);
    assert_eq!(out.rejected[0].index, 0);
    assert_eq!(out.rejected[0].reason, 1); // 'magnet-year'
}

/// (c) `guid` preenchido: terceiro da cadeia (`magnet`, `magnet_uri`,
/// `guid`), de onde sai o `dn=` da release.
#[test]
fn guid_fornece_o_dn() {
    let out = filter_relevant_raw_napi(
        vec![entry_campos(
            Some("Filme 2020 1080p"),
            None,
            None,
            None,
            Some("magnet:?dn=Filme+2030"),
            false,
        )],
        query(&["Filme"]),
        settings(),
    );
    assert_eq!(out.rejected.len(), 1);
    assert_eq!(out.rejected[0].reason, 1); // 'magnet-year' via guid
}

/// (d) Ano dual: item que só casa no ano alternativo passa no passe dual;
/// no corte de um ano só (`ForYear`, que ignora `alt_year`) sai rejeitado.
#[test]
fn ano_dual_mantem_o_caso_do_ano_alternativo() {
    let dual = filter_relevant_raw_napi(
        vec![entry("Filme 2021 1080p")],
        RelevanceQueryNapi {
            year: "2018".to_string(),
            alt_year: Some("2021".to_string()),
            ..query(&["Filme"])
        },
        settings(),
    );
    assert_eq!(dual.kept, vec![0]);
    let um_ano = filter_relevant_raw_for_year_napi(
        vec![entry("Filme 2021 1080p")],
        query_for_ano(&["Filme"], "2018"),
        settings(),
    );
    assert_eq!(um_ano.kept, Vec::<u32>::new());
    assert_eq!(um_ano.rejected[0].reason, 0); // 'title'
}

/// (e) Série com episódio pedido e `dn=` do magnet apontando OUTRO
/// episódio -> reason 4 (`'episode'`); o gêmeo sem magnet fica.
#[test]
fn episodio_pedido_com_dn_contraditorio_rejeita() {
    let mut q = query(&["Serie"]);
    q.is_series = true;
    q.season = Some(1);
    q.episode = Some(5);
    let out = filter_relevant_raw_napi(
        vec![
            entry_campos(
                Some("Serie S01E05 2020"),
                None,
                Some("magnet:?dn=Serie+S01E02+2020"),
                None,
                None,
                false,
            ),
            entry("Serie S01E05 2020"),
        ],
        q,
        settings(),
    );
    assert_eq!(out.kept, vec![1]);
    assert_eq!(out.rejected.len(), 1);
    assert_eq!(out.rejected[0].index, 0);
    assert_eq!(out.rejected[0].reason, 4); // 'episode'
}

/// (f) `is_br=true` tem que chegar ao `matches_br_title` (prefixo + ano),
/// e não à cadeia estrita do global.
#[test]
fn br_casa_por_matches_br_title() {
    let out = filter_relevant_raw_napi(
        vec![entry_campos(
            Some("Filme 2020 DUBLADO 1080p"),
            None,
            None,
            None,
            None,
            true,
        )],
        query(&["Filme"]),
        settings(),
    );
    assert_eq!(out.kept, vec![0]);
    assert!(out.rejected.is_empty());
}

/// (g) Rejeitados saem em ordem crescente de índice, com o mantido no meio.
#[test]
fn rejeitados_em_ordem_crescente_de_indice() {
    let out = filter_relevant_raw_napi(
        vec![
            entry("Outra Obra 2020 1080p"),
            entry("Filme 2020 1080p DUBLADO"),
            entry("Coisa Estranha 2020 1080p"),
        ],
        query(&["Filme"]),
        settings(),
    );
    assert_eq!(out.kept, vec![1]);
    assert_eq!(
        out.rejected.iter().map(|r| r.index).collect::<Vec<_>>(),
        vec![0, 2]
    );
    assert!(out.rejected.iter().all(|r| r.reason == 0)); // 'title'
}
