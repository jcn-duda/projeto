use super::*;
use crate::orchestrator::live_state::LiveAllState;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_A_UPPER: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn item(title: &str, hash: &str, indexer: &str) -> RawItem {
    RawItem {
        title: Some(title.into()),
        info_hash: Some(hash.into()),
        indexer: Some(indexer.into()),
        ..RawItem::default()
    }
}

fn state(failed: &[&str], pending: &[&str], empty: &[&str], all: LiveAllState) -> LiveBatchState {
    LiveBatchState {
        failed: failed.iter().map(|s| s.to_string()).collect(),
        pending: pending.iter().map(|s| s.to_string()).collect(),
        empty: empty.iter().map(|s| s.to_string()).collect(),
        all,
    }
}

fn titles(out: &[RawItem]) -> Vec<&str> {
    out.iter()
        .map(|i| i.title.as_deref().unwrap_or(""))
        .collect()
}

#[test]
fn vivo_supera_reserva_e_foto_quando_a_coleta_respondeu() {
    let mut banco = item("banco", "AAA", "mico");
    banco.from_fallback = true;
    let mut foto = item("foto", "CCC", "bludv");
    foto.from_snapshot = true;
    let live = vec![item("ao vivo", "EEE", "bludv")];

    // Sem contrato vivo: régua antiga (todas as marcas saem).
    let out = merge_fast_with_live(vec![banco.clone(), foto.clone()], live.clone(), false, None);
    assert_eq!(
        titles(&out),
        ["foto", "ao vivo"],
        "a reserva sai; a foto fica"
    );
    assert!(
        !out[0].from_snapshot,
        "coleta respondeu: a foto perde o selo"
    );

    // Jackett parado: nada muda, senão a foto vira lista viva completa.
    let out = merge_fast_with_live(vec![banco, foto], live, true, None);
    assert!(out[0].from_fallback && out[1].from_snapshot);
    assert_eq!(out.len(), 3);
}

/// Falha ISOLADA: o indexer que caiu mantém 📦; o que respondeu perde 📦 e
/// selo. É o que `clearInstantSnapshots` + fallback fazem no Node.
#[test]
fn falha_isolada_preserva_package_do_indexer_que_caiu() {
    let mut reserva_falha = item("reserva mico", "AAA", "mico");
    reserva_falha.from_fallback = true;
    let mut reserva_ok = item("reserva bludv", "BBB", "bludv");
    reserva_ok.from_fallback = true;
    let mut foto = item("foto", "CCC", "bludv");
    foto.from_snapshot = true;

    let state = state(&["mico"], &[], &[], LiveAllState::Ok);
    let out = merge_fast_with_live(
        vec![reserva_falha, reserva_ok, foto],
        Vec::new(),
        false,
        Some(&state),
    );
    assert_eq!(titles(&out), ["reserva mico", "foto"]);
    assert!(out[0].from_fallback, "mico falhou: a reserva 📦 dele fica");
    assert!(
        !out[1].from_snapshot,
        "bludv respondeu: a foto perde o selo"
    );
}

/// Pending não prova sucesso (conta como falho) e vazio suspeito também
/// não: ambos preservam a marca.
#[test]
fn pending_e_suspeito_preservam_package() {
    let mut pendente = item("pendente", "AAA", "mico");
    pendente.from_fallback = true;
    let mut suspeito = item("suspeito", "BBB", "hdr");
    suspeito.from_fallback = true;
    let mut foto_suspeita = item("foto hdr", "CCC", "hdr");
    foto_suspeita.from_snapshot = true;

    let state = state(&[], &["mico"], &["hdr"], LiveAllState::Ok);
    let out = merge_fast_with_live(
        vec![pendente, suspeito, foto_suspeita],
        Vec::new(),
        false,
        Some(&state),
    );
    assert_eq!(titles(&out), ["pendente", "suspeito", "foto hdr"]);
    assert!(out[0].from_fallback && out[1].from_fallback);
    assert!(out[2].from_snapshot, "vazio suspeito mantém o selo");
}

/// Agregado `/all` error/pending mantém TUDO, mesmo sem `all_failed`
/// estrutural: a foto não pode virar lista viva completa.
#[test]
fn agregado_falho_nao_limpa_marks() {
    for agregado in [LiveAllState::Error, LiveAllState::Pending] {
        let mut banco = item("banco", "AAA", "mico");
        banco.from_fallback = true;
        let mut foto = item("foto", "CCC", "bludv");
        foto.from_snapshot = true;

        let state = state(&[], &[], &[], agregado);
        let out = merge_fast_with_live(vec![banco, foto], Vec::new(), false, Some(&state));
        assert_eq!(out.len(), 2);
        assert!(out[0].from_fallback && out[1].from_snapshot);
    }
}

#[test]
fn tail_input_troca_o_prazo_da_resposta_pelo_do_tail() {
    use crate::orchestrator::tests::test_support::{config, MemorySwrStore};
    use std::sync::Arc;
    let mut cfg = config();
    cfg.tail_collect_ms = 25_000;
    let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()));
    let input = SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: None,
        prefix: String::new(),
        options: serde_json::json!({}),
        key: "k".into(),
        now_ms: 0,
        deadline_at: Some(1),
    };
    let before = crate::orchestrator::respond::now_ms();
    let tail = orch.tail_input(&input);
    assert!(tail.deadline_at.unwrap_or(0) >= before + 25_000);
}

/// `collectFallbackForBuild.liveHashes`: a reserva cujo hash está no lote
/// vivo sai mesmo com o indexer dela FALHO/pendente — o vivo vence sempre.
#[test]
fn reserva_com_hash_vivo_sai_mesmo_com_indexer_nao_provado() {
    let mut reserva = item("reserva mico", HASH_A, "mico");
    reserva.from_fallback = true;
    let mut outra_reserva = item("reserva hdr", HASH_B, "hdr");
    outra_reserva.from_fallback = true;
    // Mesmo hash da reserva, vindo de OUTRO indexer e com outra caixa: o
    // `hashOf` do Node normaliza, então o caso não escapa do dedupe.
    let vivo = item("vivo", HASH_A_UPPER, "bludv");

    let state = state(&["mico", "hdr"], &[], &[], LiveAllState::Ok);
    let out = merge_fast_with_live(
        vec![reserva, outra_reserva],
        vec![vivo],
        false,
        Some(&state),
    );
    assert_eq!(
        titles(&out),
        ["reserva hdr", "vivo"],
        "só a reserva com hash vivo cai; a do indexer falho sem hash vivo fica"
    );
    assert!(out[0].from_fallback);
}

/// Agregado falho também não mantém a duplicata: a falha agregada preserva
/// marcas, mas não a reserva que o vivo entregou.
#[test]
fn reserva_com_hash_vivo_sai_com_agregado_falho() {
    let mut reserva = item("reserva", HASH_A, "mico");
    reserva.from_fallback = true;
    let vivo = item("vivo", HASH_A_UPPER, "bludv");

    let state = state(&[], &[], &[], LiveAllState::Error);
    let out = merge_fast_with_live(vec![reserva], vec![vivo], false, Some(&state));
    assert_eq!(titles(&out), ["vivo"]);
}

/// Conflito de dedupe na FOTO: o hash vivo tira o selo mesmo com o indexer
/// não-provado, senão a primeira ocorrência (a foto) esconderia o item vivo e
/// exibiria 📦 num hash que a coleta entregou. Vale também com agregado falho.
#[test]
fn foto_com_hash_vivo_perde_selo_mesmo_com_indexer_nao_provado() {
    let mut foto = item("foto", HASH_A, "mico");
    foto.from_snapshot = true;
    let vivo = item("vivo", HASH_A_UPPER, "bludv");

    let state_ok = state(&["mico"], &[], &[], LiveAllState::Ok);
    let out = merge_fast_with_live(vec![foto], vec![vivo], false, Some(&state_ok));
    assert_eq!(titles(&out), ["foto", "vivo"]);
    assert!(
        !out[0].from_snapshot,
        "hash vivo vence a reserva; o dedupe mantém a primeira sem 📦"
    );

    // Agregado falho: a falha preserva as outras marcas, mas não esta.
    let mut foto_erro = item("foto erro", HASH_B, "hdr");
    foto_erro.from_snapshot = true;
    let vivo_erro = item("vivo erro", HASH_B, "bludv");
    let state_erro = state(&[], &[], &[], LiveAllState::Error);
    let out = merge_fast_with_live(vec![foto_erro], vec![vivo_erro], false, Some(&state_erro));
    assert_eq!(titles(&out), ["foto erro", "vivo erro"]);
    assert!(
        !out[0].from_snapshot,
        "hash vivo também limpa o selo no agregado falho"
    );

    // Quando o indexer da foto respondeu, a régua antiga a desmarca — com ou
    // sem hash vivo.
    let mut foto_ok = item("foto ok", HASH_B, "bludv");
    foto_ok.from_snapshot = true;
    let out = merge_fast_with_live(vec![foto_ok], Vec::new(), false, Some(&state_ok));
    assert!(!out[0].from_snapshot);
}

/// `hashOf` tenta `magnet`/`MagnetUri`/`Guid` quando o `infoHash` é sujo;
/// o dedupe não pode cegar com um `infoHash` inválido.
#[test]
fn hash_do_banco_cai_para_magnet_quando_info_hash_e_invalido() {
    let mut reserva_suja = item("x", "lixo", "mico");
    reserva_suja.from_fallback = true;
    reserva_suja.magnet = Some(format!("magnet:?xt=urn:btih:{HASH_A_UPPER}&dn=x"));
    let vivo = item("vivo", HASH_A, "bludv");
    let state = state(&["mico"], &[], &[], LiveAllState::Ok);
    let out = merge_fast_with_live(vec![reserva_suja], vec![vivo], false, Some(&state));
    assert_eq!(titles(&out), ["vivo"]);
}
