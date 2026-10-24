//! Testes do RENAME de indexer APOSENTADO na lista EFETIVA da busca.
//!
//! Desde o F4.4 quem decide a lista de indexers consultada é o Rust. O `ji`
//! da URL de quem JÁ INSTALOU tem o id VELHO gravado, e o card velho é
//! ESTACIONADO (some do catálogo do Jackett): sem o rename, a instalação
//! continua consultando um id morto e o indexer desaparece sem erro nenhum.

use super::tests::meta_movie;
use super::*;
use crate::orchestrator::config::OrchestratorConfig;
use serde_json::json;

/// O `ji` da URL é a lista que a busca consulta. O caminho testado é o REAL:
/// segmento base64url → `decode_config` → `RequestSelection` → `plan_jobs` →
/// lista que o plano Torznab consulta.
#[test]
fn ji_selado_com_id_aposentado_vira_o_card_substituto() {
    let segment = adom_core::encode_config(&json!({
        "ji": ["torrentgalaxyclone", "eztv"]
    }));
    let options =
        adom_core::decode_config(&segment, &json!({}), "").expect("segmento de config válido");
    assert_eq!(
        options["jackettIndexers"],
        json!(["torrentgalaxy-cardigann", "eztv"]),
        "o decode do segmento renomeia o id aposentado"
    );

    let selection = RequestSelection::from_options(&options, false);
    let jobs = plan_jobs(
        &OrchestratorConfig::default(),
        &meta_movie(),
        "movie",
        Some(&segment),
        1_700_000_000_000,
        &selection,
    );
    assert!(!jobs.is_empty(), "o plano tem tarefa");
    for job in &jobs {
        assert_eq!(
            job.jackett_indexers_for_plan(),
            vec!["torrentgalaxy-cardigann".to_string(), "eztv".to_string()],
            "a lista EFETIVA consulta o card substituto, não o id morto"
        );
    }
}

/// O `ji` que cita o id VELHO e o NOVO não pode gerar duas consultas ao mesmo
/// card: a lista efetiva sai com uma entrada só.
#[test]
fn ji_com_id_velho_e_novo_nao_duplica_a_consulta() {
    let segment = adom_core::encode_config(&json!({
        "ji": ["torrentgalaxyclone", "torrentgalaxy-cardigann", "eztv"]
    }));
    let options =
        adom_core::decode_config(&segment, &json!({}), "").expect("segmento de config válido");
    assert_eq!(
        options["jackettIndexers"],
        json!(["torrentgalaxy-cardigann", "eztv"])
    );
    let selection = RequestSelection::from_options(&options, false);
    let jobs = plan_jobs(
        &OrchestratorConfig::default(),
        &meta_movie(),
        "movie",
        Some(&segment),
        1_700_000_000_000,
        &selection,
    );
    for job in &jobs {
        assert_eq!(
            job.jackett_indexers_for_plan(),
            vec!["torrentgalaxy-cardigann".to_string(), "eztv".to_string()],
            "o card é consultado uma vez só"
        );
    }
}

/// O card virtual `mico` não é indexer do Jackett: o rename não pode tirá-lo
/// da lista nem transformá-lo em id de card.
#[test]
fn rename_nao_engole_o_card_virtual_mico() {
    let selection = RequestSelection {
        providers: vec!["jackett".into()],
        jackett_indexers: vec!["mico".into(), "torrentgalaxyclone".into()],
        ..RequestSelection::default()
    };
    let jobs = plan_jobs(
        &OrchestratorConfig::default(),
        &meta_movie(),
        "movie",
        None,
        1_700_000_000_000,
        &selection,
    );
    for job in &jobs {
        assert_eq!(
            job.jackett_indexers_for_plan(),
            vec!["torrentgalaxy-cardigann".to_string()],
            "o mico sai do plano Torznab, mas continua na lista do job"
        );
        assert!(job.wants("mico"), "o coletor do Mico continua querendo");
    }
}
