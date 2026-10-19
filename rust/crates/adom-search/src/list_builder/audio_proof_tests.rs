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
