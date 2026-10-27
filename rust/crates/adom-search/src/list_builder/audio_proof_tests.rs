//! Casos do `toStremioStream` do Node (chip, `_dubbed`, `_dubClaim`).

use super::*;

fn raw(title: &str) -> RawItem {
    RawItem {
        title: Some(title.into()),
        ..RawItem::default()
    }
}

fn proof(item: &RawItem, is_br: bool) -> AudioProof {
    let title = item.title.clone().unwrap_or_default();
    audio_proof(item, &title, is_br, &AudioAudit::default())
}

#[test]
fn titulo_dublado_sem_prova_e_promessa_sem_chip() {
    let p = proof(&raw("A Origem (2010) 720p Dublado"), true);
    assert_eq!(p.chip_audio, "", "sem prova o chip DUB some");
    assert!(!p.dubbed, "título não prova dublado");
    assert!(p.dub_claim, "o título BR promete");
}

#[test]
fn prova_de_arquivo_vira_dublado_e_chip() {
    let mut item = raw("A Origem (2010) 720p");
    item.proven_audio = Some("Dual".into());
    let p = proof(&item, true);
    assert_eq!(p.chip_audio, "Dual");
    assert!(p.dubbed);
    assert!(!p.dub_claim, "o título não promete nada");
}

#[test]
fn prova_vazia_derruba_a_promessa_e_mantem_legendado() {
    let mut item = raw("A Origem (2010) 720p Dublado");
    item.proven_audio = Some(String::new());
    let p = proof(&item, true);
    assert_eq!(p.chip_audio, "");
    assert!(!p.dubbed && !p.dub_claim);

    let mut leg = raw("A Origem (2010) 720p Legendado");
    leg.proven_audio = Some(String::new());
    assert_eq!(proof(&leg, true).chip_audio, "Legendado");
}

#[test]
fn nome_de_arquivo_com_pt_e_prova_positiva() {
    let mut item = raw("Movie 2010 1080p");
    item.proven_name = Some("Movie.2010.1080p.DUBLADO.mkv".into());
    assert!(proof(&item, false).dubbed);
}

#[test]
fn dn_de_cena_en_anula_a_promessa() {
    let mut item = raw("A Origem (2010) 1080p Dublado");
    item.magnet = Some("magnet:?xt=urn:btih:abc&dn=Inception.2010.1080p.BluRay.x264-YTS".into());
    let p = proof(&item, true);
    assert!(!p.dub_claim, "dn= de cena EN contradiz o post");
}

#[test]
fn origem_br_e_mentira_nunca_prometem() {
    let mut origem = raw("Filme 2020 1080p Dublado");
    origem.br_origin_only = true;
    assert!(!proof(&origem, true).dub_claim);

    let mut mentira = raw("Filme 2020 1080p");
    mentira.proven_audio = Some("Dublado".into());
    mentira.lied = true;
    assert!(!proof(&mentira, true).dubbed);
}

#[test]
fn env_vazio_mantem_as_listas_do_node() {
    let audit = AudioAudit::from_env_values(Some("false"), Some(" "), None);
    assert!(!audit.enabled);
    assert_eq!(audit.pt_markers, AudioAudit::default().pt_markers);
}

// `_bankDub` (evidência do classificador da captura) ----------------------

fn bank_item(title: &str) -> RawItem {
    let mut item = raw(title);
    item.from_fallback = true;
    item.is_br = true;
    item.extra.insert("dubbed".into(), true.into());
    item
}

fn with_dn(item: &mut RawItem, dn: &str) {
    item.magnet = Some(format!("magnet:?xt=urn:btih:{}&dn={dn}", "a".repeat(40)));
}

#[test]
fn bank_dub_so_na_reserva_br_com_dubbed_do_banco() {
    // Linha real: o título não cita áudio, só o `dubbed=1` do banco.
    let item = bank_item("Locke & Key 1ª e 2ª Temporada (2021) S01 [720p]");
    let p = proof(&item, true);
    assert!(
        p.bank_dub,
        "a evidência do banco precisa atravessar o build"
    );
    assert!(!p.dubbed, "não é prova de arquivo");
    assert!(!p.dub_claim, "o título não promete");

    assert!(
        !proof(&item, false).bank_dub,
        "a marca é exclusiva da reserva BR"
    );

    let mut sem_evidencia = bank_item("Locke & Key S01 [720p]");
    sem_evidencia.extra.remove("dubbed");
    assert!(!proof(&sem_evidencia, true).bank_dub);

    let mut vivo = bank_item("Locke & Key S01 [720p]");
    vivo.from_fallback = false;
    assert!(
        !proof(&vivo, true).bank_dub,
        "item cru de indexer não ganha a marca do banco"
    );
}

#[test]
fn bank_dub_respeita_as_guardas_do_claim() {
    // Promessa do título: o `_dubClaim` já basta, a marca não nasce.
    assert!(!proof(&bank_item("Locke & Key S01 DUBLADO"), true).bank_dub);

    let mut lied = bank_item("Locke & Key S01 [720p]");
    lied.lied = true;
    assert!(!proof(&lied, true).bank_dub);

    let mut origem = bank_item("Locke & Key S01 [720p]");
    origem.br_origin_only = true;
    assert!(
        !proof(&origem, true).bank_dub,
        "origem da conta não prova áudio"
    );

    let mut prova_vazia = bank_item("Locke & Key S01 [720p]");
    prova_vazia.proven_audio = Some(String::new());
    assert!(
        !proof(&prova_vazia, true).bank_dub,
        "prova vazia de áudio é EN"
    );

    let mut dn_en = bank_item("Locke & Key S01 [720p]");
    with_dn(&mut dn_en, "Locke.and.Key.S01E01.HDTV.x264-KILLERS[ettv]");
    assert!(
        !proof(&dn_en, true).bank_dub,
        "dn= de cena EN contradiz a classificação"
    );
}

#[test]
fn bank_dub_veta_legendado_e_idioma_estrangeiro() {
    assert!(
        !proof(&bank_item("Locke & Key S01 720p LEGENDADO"), true).bank_dub,
        "LEGENDADO no título vence o dubbed=1"
    );

    let mut dn_leg = bank_item("Locke & Key S01 [720p]");
    with_dn(&mut dn_leg, "Locke.and.Key.S01.LEGENDADO.1080p.WEB-DL");
    assert!(!proof(&dn_leg, true).bank_dub);

    assert!(
        !proof(&bank_item("Locke & Key Season 1 FRENCH 1080p WEB-DL"), true).bank_dub,
        "idioma estrangeiro nomeado sem PT veta"
    );

    let mut dn_german = bank_item("Locke & Key S01 [720p]");
    with_dn(
        &mut dn_german,
        "Locke.and.Key.S01.COMPLETE.GERMAN.1080p.NF.WEB-DL",
    );
    assert!(!proof(&dn_german, true).bank_dub);

    // PT explícito absorve a menção estrangeira; DUAL+LEGENDADO é faixa dupla.
    let mut dn_pt = bank_item("Locke & Key S01 [720p]");
    with_dn(&mut dn_pt, "Locke.and.Key.S01.PT-BR.FRENCH.1080p.WEB-DL");
    assert!(proof(&dn_pt, true).bank_dub);

    let mut dn_dual_leg = bank_item("Locke & Key S01 [720p]");
    with_dn(
        &mut dn_dual_leg,
        "Locke.and.Key.S01.Completa.DUAL.LEGENDADO.1080p.WEB-DL",
    );
    assert!(
        proof(&dn_dual_leg, true).bank_dub,
        "DUAL+LEGENDADO é faixa dupla, não legenda"
    );

    let mut dn_dual = bank_item("Locke & Key S01 [720p]");
    with_dn(&mut dn_dual, "Locke.and.Key.S01.Completa.DUAL.1080p.WEB-DL");
    assert!(proof(&dn_dual, true).bank_dub);
}

#[test]
fn espelho_de_cena_en_perde_a_origem_br_do_indexer() {
    let audit = AudioAudit::default();
    let mut espelho = raw("Barbie (2023) 1080p WEBRip [YTS.MX]");
    espelho.is_br = true;
    assert!(!origin_is_br(
        &espelho,
        "Barbie (2023) 1080p WEBRip [YTS.MX]",
        &audit
    ));

    let mut post = raw("Barbie (2023) 1080p Dublado");
    post.is_br = true;
    assert!(origin_is_br(&post, "Barbie (2023) 1080p Dublado", &audit));

    let mut dual = raw("A Rocha 1996 1080p DUAL");
    dual.pt_title_dual = true;
    assert!(
        origin_is_br(&dual, "A Rocha 1996 1080p DUAL", &audit),
        "ptTitleDual prova sozinho"
    );

    let global = raw("Barbie (2023) 1080p WEBRip [YTS.MX]");
    assert!(!origin_is_br(
        &global,
        "Barbie (2023) 1080p WEBRip [YTS.MX]",
        &audit
    ));
}

#[test]
fn dn_de_tracker_russo_tira_a_origem_br_do_post_legendado() {
    // The Cycle (2026): post BR LEGENDADO com o magnet russo `.2026.D.`.
    let audit = AudioAudit::default();
    let title = "The Cycle [1080p WEB-DL LEGENDADO]";
    let mut russo = raw(title);
    russo.is_br = true;
    with_dn(&mut russo, "The.Cycle.2026.D.WEB-DL.1O8Op.mkv");
    assert!(
        !origin_is_br(&russo, title, &audit),
        "o LEGENDADO do post não prova BR com dn russo"
    );

    let mut proprio = raw(title);
    proprio.is_br = true;
    with_dn(&mut proprio, "The.Cycle.2026.1080p.WEB-DL.Legendado.mkv");
    assert!(
        origin_is_br(&proprio, title, &audit),
        "dn sem marca russa segue BR"
    );

    let mut medido = raw(title);
    medido.is_br = true;
    with_dn(&mut medido, "The.Cycle.2026.D.WEB-DL.1080p");
    medido.proven_audio = Some("Dublado".into());
    assert!(
        origin_is_br(&medido, title, &audit),
        "prova de arquivo com PT vence o dn"
    );
}

// ptTitleDual in-process (porte de src/providers/pt-title-dual.ts) -------

fn dual_titles() -> PtTitleDualTitles {
    PtTitleDualTitles {
        pt: Some("A Rocha".into()),
        original: Some("The Rock".into()),
        en: None,
    }
}

#[test]
fn pt_title_dual_marca_pelo_ctx_e_prova_origem_br() {
    let mut items = vec![raw("A.Rocha.1996.1080p.BluRay.DUAL.5.1-SF")];
    apply_pt_title_dual(&mut items, Some(&dual_titles()));
    assert!(items[0].pt_title_dual);
    let audit = AudioAudit::default();
    assert!(
        origin_is_br(&items[0], items[0].title_text(), &audit),
        "a marca in-process tem que sobreviver à origem/áudio"
    );
}

#[test]
fn pt_title_dual_preserva_guardas_duais_do_ts() {
    let guardas = [
        "Dr.House.S06.HDLight.1080p.Multi.HEVC.5.1-Uzil",
        "A.Rocha.1996.1080p.BluRay.DUAL.MULTi",
        "A.Rocha.1996.BluRay.DUAL.VF",
        "A.Rocha.1996.DUAL.ESP",
        "A Rocha Queimada Dual Audio 1080p",
        "A Rocha LEGENDADO DUAL",
    ];
    for title in guardas {
        let mut items = vec![raw(title)];
        apply_pt_title_dual(&mut items, Some(&dual_titles()));
        assert!(!items[0].pt_title_dual, "{title} não pode virar BR");
    }
    // `lied` já provou mentira; `isBr` já provou origem.
    let mut lied = vec![RawItem {
        lied: true,
        ..raw("A.Rocha.1996.1080p.BluRay.DUAL-SF")
    }];
    apply_pt_title_dual(&mut lied, Some(&dual_titles()));
    assert!(!lied[0].pt_title_dual);
    let mut br = vec![RawItem {
        is_br: true,
        ..raw("A.Rocha.1996.1080p.BluRay.DUAL-SF")
    }];
    apply_pt_title_dual(&mut br, Some(&dual_titles()));
    assert!(!br[0].pt_title_dual);
}

#[test]
fn pt_title_dual_sem_ctx_nao_toca_e_nao_apaga_marca_existente() {
    let mut items = vec![raw("A.Rocha.1996.1080p.BluRay.DUAL-SF")];
    apply_pt_title_dual(&mut items, None);
    assert!(!items[0].pt_title_dual);

    let mut ja_marcado = vec![RawItem {
        pt_title_dual: true,
        ..raw("A.Rocha.1996.1080p.BluRay.DUAL-SF")
    }];
    apply_pt_title_dual(
        &mut ja_marcado,
        Some(&PtTitleDualTitles {
            pt: Some("Outra Obra".into()),
            original: Some("Another".into()),
            en: None,
        }),
    );
    assert!(
        ja_marcado[0].pt_title_dual,
        "a régua só adiciona a marca (como o TS), nunca apaga"
    );
}

/// O build in-process: o contexto vem do `SearchMeta` (não do flag da rota).
#[test]
fn build_marca_dual_pelo_ctx_sem_flag_da_rota() {
    use crate::list_builder::{
        build_stream_list, BuildContext, BuildOptions, DebridAnswer, DebridCheck,
    };
    use adom_core::{RankingStream, StreamDisplayConfig};

    struct SemDebrid;
    impl DebridCheck for SemDebrid {
        fn check(&mut self, _stream: &RankingStream) -> DebridAnswer {
            DebridAnswer::Unknown
        }
    }

    let ctx = BuildContext {
        names: vec!["A Rocha".into()],
        year: "1996".into(),
        titles: Some(dual_titles()),
        now_ms: 1_700_000_000_000,
        ..BuildContext::default()
    };
    let raw = vec![RawItem {
        title: Some("A.Rocha.1996.1080p.BluRay.DUAL.5.1-STARCKFILMES".into()),
        info_hash: Some("b".repeat(40)),
        seeders: Some(1.0),
        size_bytes: Some(2.0 * 1024.0 * 1024.0 * 1024.0),
        ..RawItem::default()
    }];
    let out = build_stream_list(
        &raw,
        &ctx,
        &BuildOptions::default(),
        &mut SemDebrid,
        &StreamDisplayConfig::default(),
    );
    assert!(
        out.streams.iter().any(|s| s.is_br),
        "o DUAL pt do TMDB tem que virar stream BR sem flag ptTitleDual na entrada"
    );
}
