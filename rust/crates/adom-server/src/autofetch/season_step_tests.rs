//! Season Pack Fill: payload, kill-switch, LRU por temporada e a régua do fill.
//!
//! Os casos de fill espelham `test/autofetch-season-fill.test.ts` (pack
//! "Temporada Completa" sem número não invalida nada). O golden `.jsonl` deste
//! caminho é de CONTRATO (`kind: "contract"`), não de paridade com o Node.

use adom_autofetch::v3::{SeasonFillSkip, SeasonGap};
use adom_index::NativeKv;
use serde_json::{json, Map, Value};

use super::{
    execute, index_key, plan, plan_fill, take, FillStep, SeasonFillFacts, SeasonRegister,
    SeasonSkip, SeasonStep, SeasonStepConfig, SEASON_PREFIX,
};

const NOW: i64 = 1_700_000_000_000;

fn config() -> SeasonStepConfig {
    SeasonStepConfig {
        enabled: true,
        paused: false,
        max_seasons: 200,
        max_keys: 256,
        ttl_seconds: 21_600,
    }
}

fn body(value: Value) -> Map<String, Value> {
    value.as_object().expect("objeto").clone()
}

fn payload(season: i64) -> Map<String, Value> {
    body(json!({
        "adapter_id": "alldebrid",
        "account": "digest-da-conta",
        "imdb": "tt0903747",
        "season": season,
        "cache_key": "streams:v21:busca",
    }))
}

fn register(season: i64, cache_key: &str) -> SeasonRegister {
    SeasonRegister {
        adapter_id: "alldebrid".into(),
        account: "digest-da-conta".into(),
        imdb_id: "tt0903747".into(),
        season,
        cache_key: cache_key.into(),
    }
}

fn planned(payload: &Map<String, Value>) -> SeasonRegister {
    match plan(payload, &config()) {
        SeasonStep::Register(register) => register,
        SeasonStep::Skip(reason) => panic!("esperava registro, veio {reason:?}"),
    }
}

/// (a) Payload fora do contrato nunca vira registro.
#[test]
fn payload_invalido_vira_skip_com_motivo() {
    let casos = [
        json!({ "adapter_id": "alldebrid", "account": "x", "imdb": "tt1", "cache_key": "k" }),
        json!({ "adapter_id": "", "account": "x", "imdb": "tt1", "season": 2, "cache_key": "k" }),
        json!({ "adapter_id": "alldebrid", "account": "none", "imdb": "tt1", "season": 2, "cache_key": "k" }),
        json!({ "adapter_id": "alldebrid", "account": "x", "imdb": "0903747", "season": 2, "cache_key": "k" }),
        json!({ "adapter_id": "alldebrid", "account": "x", "imdb": "tt0903747", "season": 0, "cache_key": "k" }),
        json!({ "adapter_id": "alldebrid", "account": "x", "imdb": "tt0903747", "season": "2", "cache_key": "k" }),
        json!({ "adapter_id": "alldebrid", "account": "x", "imdb": "tt0903747", "season": 2, "cache_key": " " }),
    ];
    for caso in casos {
        assert_eq!(
            plan(&body(caso.clone()), &config()),
            SeasonStep::Skip(SeasonSkip::InvalidPayload),
            "payload {caso} deveria ser recusado"
        );
    }
    assert_eq!(SeasonSkip::InvalidPayload.as_str(), "invalid");
}

/// (b) Pausa desliga o registro E o preenchimento.
#[test]
fn worker_pausado_desliga_registro_e_fill() {
    let cfg = SeasonStepConfig {
        paused: true,
        ..config()
    };
    assert_eq!(
        plan(&payload(2), &cfg),
        SeasonStep::Skip(SeasonSkip::WorkerPaused)
    );
    let facts = SeasonFillFacts {
        title: "Some Show Season 2 Complete",
        gap: SeasonGap { season: Some(2) },
        is_pack: true,
    };
    assert_eq!(
        plan_fill(&cfg, facts),
        FillStep::Skip(SeasonSkip::WorkerPaused)
    );
    assert_eq!(SeasonSkip::WorkerPaused.as_str(), "paused");
}

#[test]
fn toggle_e_teto_desligam_o_indice() {
    let sem_toggle = SeasonStepConfig {
        enabled: false,
        ..config()
    };
    assert_eq!(
        plan(&payload(2), &sem_toggle),
        SeasonStep::Skip(SeasonSkip::FillDisabled)
    );
    let sem_indice = SeasonStepConfig {
        max_seasons: 0,
        ..config()
    };
    assert_eq!(
        plan(&payload(2), &sem_indice),
        SeasonStep::Skip(SeasonSkip::IndexOff)
    );
}

/// (e) O fill escolhe a MESMA temporada que o TS escolheria.
#[test]
fn fill_escolhe_a_temporada_declarada() {
    let cfg = config();
    let caso = |title: &'static str, season: Option<i64>, is_pack: bool| {
        plan_fill(
            &cfg,
            SeasonFillFacts {
                title,
                gap: SeasonGap { season },
                is_pack,
            },
        )
    };
    assert_eq!(
        caso("Some Show Season 2 Complete", Some(2), true),
        FillStep::Fill { season: 2 }
    );
    // Pack de outra temporada não preenche o buraco.
    assert_eq!(
        caso("Some Show Season 3 Complete", Some(2), true),
        FillStep::Skip(SeasonSkip::Rule(SeasonFillSkip::UndeclaredSeason))
    );
    // Release que não é pack.
    assert_eq!(
        caso("Some Show Season 2 Complete", Some(2), false),
        FillStep::Skip(SeasonSkip::Rule(SeasonFillSkip::NotPack))
    );
    // O caso de `autofetch-season-fill.test.ts`: "Temporada Completa" sem
    // número é buraco NÃO declarado e não vira S1.
    assert_eq!(
        caso("Show Temporada Completa Dublado", None, true),
        FillStep::Skip(SeasonSkip::Rule(SeasonFillSkip::NoDeclaredSeason))
    );
    assert_eq!(
        SeasonSkip::Rule(SeasonFillSkip::NoDeclaredSeason).as_str(),
        "no-declared-season"
    );
}

/// Registro no KV: a chave é a do TS e o teto por temporada descarta a mais
/// antiga (LRU), sem duplicar a mesma busca.
#[test]
fn registro_grava_no_kv_com_teto_por_temporada() {
    let kv = NativeKv::open_memory().expect("kv");
    let cfg = SeasonStepConfig {
        max_keys: 2,
        ..config()
    };
    let entry = index_key("alldebrid", "digest-da-conta", "tt0903747", 2);
    assert_eq!(
        entry,
        format!("{SEASON_PREFIX}alldebrid:digest-da-conta:tt0903747:2")
    );
    assert_eq!(
        planned(&payload(2)).key(),
        "alldebrid:digest-da-conta:tt0903747:2"
    );

    for key in ["busca-1", "busca-2"] {
        let report = execute(&kv, &register(2, key), &cfg, NOW).expect("grava");
        assert!(report.registered);
    }
    // A mesma busca não duplica e NÃO reposiciona (o `Set` do TS preserva a
    // ordem de inserção); por isso o teto descarta `busca-1`, não `busca-2`.
    let report = execute(&kv, &register(2, "busca-1"), &cfg, NOW).expect("grava");
    assert_eq!(report.keys, 2);
    let report = execute(&kv, &register(2, "busca-3"), &cfg, NOW).expect("grava");
    assert_eq!(report.keys, 2);
    assert_eq!(
        kv.get_json(&entry, NOW).expect("lê"),
        Some(json!(["busca-2", "busca-3"])),
        "teto por temporada: a mais antiga sai, a repetida mantém o lugar"
    );
    // Temporada diferente é outra entrada.
    execute(&kv, &register(3, "busca-s3"), &cfg, NOW).expect("grava");
    assert!(kv
        .get_json(
            &index_key("alldebrid", "digest-da-conta", "tt0903747", 3),
            NOW
        )
        .expect("lê")
        .is_some());
}

/// Pack pronto: `take` devolve as buscas da temporada e apaga a entrada (a
/// invalidação em si é do store de streams, fora deste passo).
#[test]
fn take_devolve_as_buscas_e_apaga_a_entrada() {
    let kv = NativeKv::open_memory().expect("kv");
    let cfg = config();
    let entry = register(2, "busca-1");
    execute(&kv, &entry, &cfg, NOW).expect("grava");
    execute(&kv, &register(2, "busca-2"), &cfg, NOW).expect("grava");
    let keys = take(&kv, &entry, NOW).expect("take");
    assert_eq!(keys, vec!["busca-1".to_string(), "busca-2".to_string()]);
    assert_eq!(
        take(&kv, &entry, NOW).expect("take vazio"),
        Vec::<String>::new()
    );
}

/// Índice desligado não grava — e uma entrada corrompida é lida como vazia,
/// nunca como erro que derrubaria a passagem.
#[test]
fn indice_desligado_nao_grava_e_entrada_podre_e_vazia() {
    let kv = NativeKv::open_memory().expect("kv");
    let cfg = SeasonStepConfig {
        enabled: false,
        ..config()
    };
    let report = execute(&kv, &register(2, "busca-1"), &cfg, NOW).expect("sem escrita");
    assert!(!report.registered);
    assert!(kv
        .get_json(
            &index_key("alldebrid", "digest-da-conta", "tt0903747", 2),
            NOW
        )
        .expect("lê")
        .is_none());

    kv.put_json(
        &index_key("alldebrid", "digest-da-conta", "tt0903747", 2),
        &json!({ "keys": "podre" }),
        21_600,
        NOW,
    )
    .expect("grava podre");
    let report = execute(&kv, &register(2, "busca-1"), &config(), NOW).expect("grava");
    assert!(report.registered);
    assert_eq!(report.keys, 1);
}

// Golden de CONTRATO (fixture `.jsonl`) do registro e da régua do fill.
#[path = "season_step_golden.rs"]
mod golden;
