use super::*;

fn titles(pt: &str, original: &str) -> PtTitleDualTitles {
    PtTitleDualTitles {
        pt: Some(pt.into()),
        original: Some(original.into()),
        en: None,
    }
}

fn item(title: &str) -> PtTitleDualItem<'_> {
    PtTitleDualItem {
        title: Some(title),
        ..PtTitleDualItem::default()
    }
}

fn marked(title: &str, titles: &PtTitleDualTitles) -> bool {
    should_mark_pt_title_dual(&item(title), Some(titles))
}

#[test]
fn marca_pt_tmdb_distinto_com_dual_literal() {
    assert!(marked(
        "Lanternas.S01E04.WEB-DL.1080p.x264.DUAL.5.1-STARCKFILMES",
        &titles("Lanternas", "Lanterns")
    ));
    assert!(marked(
        "O.Cavaleiro.dos.Sete.Reinos.S01E06.WEB-DL.1080p.x264.DUAL.5.1-SF",
        &titles(
            "O Cavaleiro dos Sete Reinos",
            "A Knight of the Seven Kingdoms"
        )
    ));
    assert!(marked(
        "A.Rocha.1996.1080p.BluRay.DUAL-SF",
        &titles("A Rocha", "The Rock")
    ));
    assert!(marked(
        "O Grande Truque (2006) BluRay 720p Dual Audio",
        &titles("O Grande Truque", "The Prestige")
    ));
    // Artigo do TMDB ausente na release: casa pelo pt sem determinante.
    assert!(marked(
        "Grande Truque (2006) BluRay 720p Dual Audio",
        &titles("O Grande Truque", "The Prestige")
    ));
}

// Regressão b867c13: a guarda de tokens do strip é POR CAMINHO.
#[test]
fn guarda_de_tokens_legado_vs_dois_lados() {
    assert!(marked(
        "Corvo 1994 1080p BluRay DUAL",
        &titles("O Corvo", "The Crow")
    ));
    assert!(marked(
        "Origem 2010 1080p BluRay DUAL",
        &titles("A Origem", "Inception")
    ));
    assert!(marked(
        "O Corvo 1994 1080p BluRay DUAL",
        &titles("O Corvo", "The Crow")
    ));
    // Guarda dos DOIS lados (3 tokens): "A Rocha" (2 tokens) NÃO pode
    // virar "rocha" contra o título mutilado "Na Rocha Queimada".
    assert!(!marked(
        "Na Rocha Queimada Dual",
        &titles("A Rocha", "The Rock")
    ));
    // Legado: "rocha" casa o prefixo, mas "queimada" não é ano/qualidade.
    assert!(!marked(
        "Rocha Queimada Dual",
        &titles("A Rocha", "The Rock")
    ));
}

#[test]
fn nao_marca_multi_pt_igual_estrangeiro_legendado_lied_ou_sem_titles() {
    assert!(!marked(
        "Dr.House.S06.HDLight.1080p.Multi.HEVC.5.1-Uzil",
        &titles("Dr House", "House")
    ));
    // DUAL+MULTI (cena francesa) e tokens da lista mínima não podem regredir.
    assert!(!marked(
        "A.Rocha.1996.1080p.BluRay.DUAL.MULTi",
        &titles("A Rocha", "The Rock")
    ));
    assert!(!marked(
        "A.Rocha.1996.BluRay.DUAL.VF",
        &titles("A Rocha", "The Rock")
    ));
    assert!(!marked(
        "A.Rocha.1996.DUAL.ESP",
        &titles("A Rocha", "The Rock")
    ));
    // Prefixo pt sem fronteira de release: homônimo não herda a obra.
    assert!(!marked(
        "A Rocha Queimada Dual Audio 1080p",
        &titles("A Rocha", "The Rock")
    ));
    assert!(!marked(
        "Moana.2026.1080p-Dual-Lat",
        &titles("Moana", "Moana")
    ));
    assert!(!marked(
        "A Rocha 1996 Dual Latino",
        &titles("A Rocha", "The Rock")
    ));
    assert!(!marked(
        "A Rocha 1996 1080p Dual Audio [Eng-Spa]",
        &titles("A Rocha", "The Rock")
    ));
    assert!(!marked(
        "A Rocha LEGENDADO DUAL",
        &titles("A Rocha", "The Rock")
    ));

    let lied = PtTitleDualItem {
        lied: true,
        ..item("A.Rocha.1996.1080p.BluRay.DUAL-SF")
    };
    assert!(!should_mark_pt_title_dual(
        &lied,
        Some(&titles("A Rocha", "The Rock"))
    ));
    assert!(!should_mark_pt_title_dual(
        &item("A.Rocha.1996.1080p.BluRay.DUAL-SF"),
        None
    ));
    assert!(!should_mark_pt_title_dual(
        &item("A.Rocha.1996.1080p.BluRay.DUAL-SF"),
        Some(&titles("", "The Rock"))
    ));
}

#[test]
fn pt_igual_original_ou_en_nao_marca_e_br_ja_provado_nao_precisa() {
    assert!(!marked(
        "A.Rocha.1996.1080p.BluRay.DUAL-SF",
        &titles("A Rocha", "A Rocha")
    ));
    let with_en = PtTitleDualTitles {
        pt: Some("A Rocha".into()),
        original: Some("The Rock".into()),
        en: Some("A Rocha".into()),
    };
    assert!(!marked("A.Rocha.1996.1080p.BluRay.DUAL-SF", &with_en));
    let is_br = PtTitleDualItem {
        is_br: true,
        ..item("A.Rocha.1996.1080p.BluRay.DUAL-SF")
    };
    assert!(!should_mark_pt_title_dual(
        &is_br,
        Some(&titles("A Rocha", "The Rock"))
    ));
}

#[test]
fn lote_preserva_ordem_e_reusa_a_mesma_regua() {
    let titles = titles("A Rocha", "The Rock");
    let items = [
        item("A.Rocha.1996.1080p.BluRay.DUAL-SF"),
        item("The Rock 1996 1080p BluRay x264"),
        item("A Rocha LEGENDADO DUAL"),
    ];
    assert_eq!(
        pt_title_dual_marks(&items, Some(&titles)),
        vec![true, false, false]
    );
    assert_eq!(pt_title_dual_marks(&items, None), vec![false, false, false]);
}

#[test]
fn contracoes_dos_dois_lados_casam() {
    assert!(marked(
        "A Hora da Zona Morta 2010 1080p DUAL",
        &titles("Na Hora da Zona Morta", "The Dead Zone")
    ));
    // Título usa "Title" quando `title` está vazio.
    let mut alt = item("");
    alt.title_pascal = Some("A.Rocha.1996.1080p.BluRay.DUAL-SF");
    assert!(should_mark_pt_title_dual(
        &alt,
        Some(&titles("A Rocha", "The Rock"))
    ));
}
