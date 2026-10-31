//! Testes do plano de limpeza e da escolha manual. Casos portados de
//! `test/catalog.test.ts` (planForeignCleanup) e `test/catalog-audit.test.ts`
//! (listForReview, planManualDeletion), com os mesmos dados e expectativas.

use std::collections::HashSet;

use super::{
    list_for_review, plan_foreign_cleanup, plan_manual_deletion, CleanupTarget, ForeignCleanupOpts,
    ForeignPlan,
};
use crate::rows::{CatalogStore, Row};

const ACCOUNT: &str = "conta-de-teste";
const ADAPTER: &str = "alldebrid";
const DAY_MS: i64 = 24 * 3600 * 1000;
const NOW: i64 = 1_800_000_000_000;

/// Hash de teste de 40 caracteres: `h("1a")` repete o par 20 vezes.
fn h(par: &str) -> String {
    par.repeat(20)
}

fn store() -> CatalogStore {
    CatalogStore::open_memory().expect("banco em memória")
}

fn put(store: &CatalogStore, row: Row) {
    store.put_row(&row).expect("grava linha");
}

/// Linha viva, pronta, sem prova.
fn row(id: &str, hash: &str, filename: &str, uploaded_at: i64) -> Row {
    Row {
        adapter: ADAPTER.into(),
        account: ACCOUNT.into(),
        service_id: id.into(),
        hash: hash.into(),
        filename: filename.into(),
        size: 1000,
        status: "Ready".into(),
        ready: 1,
        uploaded_at,
        cached: "unknown".into(),
        first_seen_at: NOW,
        last_seen_at: NOW,
        ..Row::default()
    }
}

/// Linha condenada por estrangeiro (prova de cena), como o `foreignVerdict` grava.
fn foreign(id: &str, hash: &str, uploaded_at: i64) -> Row {
    Row {
        foreign_proof: "cena".into(),
        ..row(id, hash, "Foreign.2021.RARBG", uploaded_at)
    }
}

fn old() -> i64 {
    NOW - 30 * DAY_MS
}

fn opts(max: i64) -> ForeignCleanupOpts {
    ForeignCleanupOpts {
        now_ms: NOW,
        min_age_ms: 7 * DAY_MS,
        max,
        include_known: false,
    }
}

fn none_protected(_: &str) -> bool {
    false
}

/// Plano automático: opções default (7 dias, sem `known`, sem proteção).
fn run(store: &CatalogStore, max: i64) -> ForeignPlan {
    run_with(store, &opts(max), None, &none_protected)
}

fn run_with(
    store: &CatalogStore,
    o: &ForeignCleanupOpts,
    known: Option<&HashSet<String>>,
    protected: &dyn Fn(&str) -> bool,
) -> ForeignPlan {
    plan_foreign_cleanup(store, ACCOUNT, ADAPTER, o, known, protected).unwrap()
}

fn ids(targets: &[CleanupTarget]) -> Vec<&str> {
    targets.iter().map(|t| t.service_id.as_str()).collect()
}

/// Nomes das chaves de um objeto JSON, em ordem alfabética.
fn chaves(json: &serde_json::Value) -> Vec<&str> {
    let mut out: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    out.sort_unstable();
    out
}

#[test]
fn condenado_jovem_protegido_sem_prova_e_teto() {
    let store = store();
    let held = h("3c");
    put(&store, foreign("1", &h("1a"), old()));
    put(&store, foreign("2", &h("2b"), NOW - 60_000));
    put(&store, foreign("3", &held, old()));
    put(
        &store,
        row("4", &h("4d"), "Nome do Filme Dublado", NOW - 60_000),
    );
    let protected = |hash: &str| hash == held;
    let plan = run_with(&store, &opts(10), None, &protected);
    // Só o estrangeiro VELHO e solto é alvo.
    assert_eq!(ids(&plan.targets), vec!["1"]);
    assert_eq!(plan.targets[0].reason, "estrangeiro provado");
    assert_eq!(plan.skipped.young, 1, "referentes ao candidato jovem");
    assert_eq!(plan.skipped.protected, 1, "o held poupa um");
    assert_eq!(plan.skipped.not_condemned, 1, "o dublado sem prova");
    assert_eq!(plan.skipped.active, 0);
    assert_eq!(plan.skipped.known, 0);
}

#[test]
fn teto_max_pega_os_mais_antigos_e_zero_nao_tem_teto() {
    let store = store();
    // Fora de ordem de idade: o corte olha uploaded_at, não a ordem de inserção.
    put(&store, foreign("a", &h("1a"), NOW - 30 * DAY_MS));
    put(&store, foreign("b", &h("2b"), NOW - 40 * DAY_MS));
    put(&store, foreign("c", &h("3c"), NOW - 35 * DAY_MS));
    assert_eq!(ids(&run(&store, 2).targets), vec!["b", "c"]);
    // TS: `teto > 0 && ...` — max 0 significa sem limite.
    assert_eq!(run(&store, 0).targets.len(), 3);
}

#[test]
fn known_exclui_o_acervo_do_usuario_e_normaliza_a_lista() {
    let store = store();
    put(&store, foreign("1", &h("1a"), old()));
    put(&store, foreign("2", &h("9e"), old()));
    put(&store, foreign("3", &h("ab"), old()));
    // Lista em maiúsculas e com um vazio: o vazio não conta; a maiúscula vira
    // minúscula para casar com o hash guardado.
    let known: HashSet<String> = [h("9E"), h("AB"), String::new()].into_iter().collect();
    let plan = run_with(&store, &opts(10), Some(&known), &none_protected);
    assert_eq!(ids(&plan.targets), vec!["1"], "só o hash solto é alvo");
    assert_eq!(plan.skipped.known, 2);

    // TS: `knownHashes` ausente → nenhuma exclusão e nenhum `known`.
    let sem_lista = run(&store, 10);
    assert_eq!(sem_lista.targets.len(), 3);
    assert!(sem_lista.targets.iter().all(|t| !t.known));
    assert_eq!(sem_lista.skipped.known, 0);
}

#[test]
fn include_known_inclui_o_acervo_e_marca_a_flag() {
    let store = store();
    let do_operador = h("ac");
    put(&store, foreign("1", &h("1a"), old()));
    put(&store, foreign("2", &do_operador, old()));
    let known: HashSet<String> = [do_operador.clone()].into_iter().collect();
    let o = ForeignCleanupOpts {
        include_known: true,
        ..opts(10)
    };
    let plan = run_with(&store, &o, Some(&known), &none_protected);
    assert_eq!(
        plan.targets.len(),
        2,
        "com include_known, o preexistente também é alvo"
    );
    assert_eq!(plan.skipped.known, 0, "guarda desligada: não conta");
    let operador = plan
        .targets
        .iter()
        .find(|t| t.hash == do_operador)
        .expect("operador");
    assert!(
        operador.known,
        "a flag known vem verdadeira no preexistente"
    );
    let solto = plan
        .targets
        .iter()
        .find(|t| t.hash == h("1a"))
        .expect("solto");
    assert!(!solto.known, "o hash fora do snapshot fica known:false");
}

#[test]
fn trava_de_idade_no_limite_exato_e_casos_de_borda() {
    // `now - uploaded < min_age` é o corte: exatamente 7 dias não é jovem; 7 dias
    // menos 1 ms é. Data zerada nunca dispara a trava.
    let store = store();
    put(&store, foreign("exato", &h("1a"), NOW - 7 * DAY_MS));
    put(&store, foreign("jovem", &h("2b"), NOW - 7 * DAY_MS + 1));
    put(&store, foreign("sem-data", &h("3c"), 0));
    let plan = run(&store, 10);
    // Ordem por idade de envio: a data zerada (0) é a mais antiga.
    assert_eq!(ids(&plan.targets), vec!["sem-data", "exato"]);
    assert_eq!(plan.skipped.young, 1);

    // Sem idade mínima (0), nem o recente é jovem.
    let sem_trava = ForeignCleanupOpts {
        min_age_ms: 0,
        ..opts(10)
    };
    let plan = run_with(&store, &sem_trava, None, &none_protected);
    assert_eq!(plan.skipped.young, 0);
    assert_eq!(plan.targets.len(), 3);
}

#[test]
fn download_em_curso_fica() {
    let store = store();
    let baixando = Row {
        status: "Downloading".into(),
        ready: 0,
        ..foreign("1", &h("1a"), old())
    };
    put(&store, baixando);
    let plan = run(&store, 10);
    assert!(plan.targets.is_empty());
    assert_eq!(plan.skipped.active, 1);
}

#[test]
fn br_provado_nao_e_candidato() {
    // Só `foreign_proof` vira candidato: prova BR sem condenação é não-condenada.
    let store = store();
    let br = Row {
        pt_proof: "arquivo".into(),
        ..row("1", &h("1a"), "Filme Dublado", old())
    };
    put(&store, br);
    let plan = run(&store, 10);
    assert!(plan.targets.is_empty());
    assert_eq!(plan.skipped.not_condemned, 1);
}

#[test]
fn linha_apagada_fica_fora_de_todas_as_contas() {
    let store = store();
    let apagado = Row {
        deleted_at: NOW - 1,
        ..foreign("1", &h("1a"), old())
    };
    put(&store, apagado);
    let plan = run(&store, 10);
    assert!(plan.targets.is_empty());
    assert_eq!(plan.skipped.not_condemned, 0, "tombstone não conta");
}

#[test]
fn listagem_para_revisao_ordena_por_tamanho_e_filtra_balde() {
    let store = store();
    let com = |id: &str, hash: &str, size: i64, bucket: &str| Row {
        size,
        bucket: bucket.into(),
        ..row(id, hash, "Filme 2024", NOW - DAY_MS)
    };
    put(&store, com("1", &h("m1"), 1_000, "lixo"));
    put(&store, com("2", &h("m2"), 9_000, "lixo"));
    put(&store, com("3", &h("m3"), 5_000, "dub"));
    let todos = list_for_review(&store, ACCOUNT, ADAPTER, "", None, &none_protected).unwrap();
    let nomes: Vec<&str> = todos.iter().map(|r| r.service_id.as_str()).collect();
    assert_eq!(nomes, vec!["2", "3", "1"], "maiores primeiro");

    let so_dub = list_for_review(&store, ACCOUNT, ADAPTER, "dub", None, &none_protected).unwrap();
    assert_eq!(so_dub.len(), 1, "o filtro de balde vale");
    assert_eq!(so_dub[0].bucket, "dub");
}

#[test]
fn listagem_para_revisao_respeita_o_limite() {
    let store = store();
    for i in 0..105 {
        put(
            &store,
            row(&i.to_string(), &format!("{i:040x}"), "Filme", NOW - DAY_MS),
        );
    }
    let listar = |limit| list_for_review(&store, ACCOUNT, ADAPTER, "", limit, &none_protected);
    assert_eq!(listar(None).unwrap().len(), 100, "limite ausente vale 100");
    assert_eq!(listar(Some(2)).unwrap().len(), 2);
    assert!(
        listar(Some(-5)).unwrap().is_empty(),
        "limite negativo vira 0"
    );
}

#[test]
fn listagem_para_revisao_marca_protegido_ativo_e_usa_nomes_do_painel() {
    let store = store();
    let baixando = Row {
        status: "Downloading".into(),
        ready: 0,
        foreign_proof: "cena".into(),
        ..row("1", &h("1a"), "Baixando", NOW - DAY_MS)
    };
    put(&store, baixando);
    put(&store, row("2", &h("2b"), "Pronto", NOW - DAY_MS));
    let protegido = h("2b");
    let protected = |hash: &str| hash == protegido;
    let linhas = list_for_review(&store, ACCOUNT, ADAPTER, "", None, &protected).unwrap();
    let um = linhas.iter().find(|r| r.service_id == "1").unwrap();
    assert!(um.active && !um.ready && !um.protected);
    let dois = linhas.iter().find(|r| r.service_id == "2").unwrap();
    assert!(dois.protected && dois.ready && !dois.active);

    let json = serde_json::to_value(dois).unwrap();
    let campos = chaves(&json);
    assert_eq!(
        campos.len(),
        14,
        "a linha de revisão tem todos os campos do TS"
    );
    assert!(campos.contains(&"serviceId") && campos.contains(&"foreignProof"));
    assert!(campos.contains(&"uploadedAt") && campos.contains(&"imdbId"));
}

#[test]
fn manual_aceita_o_marcado_e_pula_download_em_curso() {
    // A escolha explícita é a autorização; a única guarda é `active`. Classificação
    // BR não filtra: o dublado sai como qualquer outro.
    let store = store();
    let baixando = Row {
        status: "Downloading".into(),
        ready: 0,
        ..row("2", &h("n2"), "B", NOW - DAY_MS)
    };
    let br = Row {
        bucket: "dub".into(),
        ..row("1", &h("n1"), "Filme Dublado", NOW - DAY_MS)
    };
    put(&store, br);
    put(&store, baixando);
    let marcados = ["1", "2", "999"].map(String::from);
    let plano = plan_manual_deletion(&store, ACCOUNT, ADAPTER, &marcados).unwrap();
    assert_eq!(ids(&plano.targets), vec!["1"], "só o que dá para apagar");
    assert_eq!(plano.targets[0].reason, "manual");
    assert!(!plano.targets[0].known);
    assert_eq!(plano.skipped.active, 1, "o download em curso é pulado");
    assert_eq!(
        plano.skipped.missing, 1,
        "id inexistente conta como ausente"
    );
}

#[test]
fn manual_ignora_vazio_e_repetido_e_conta_apagado_como_ausente() {
    let store = store();
    let apagado = Row {
        deleted_at: NOW - 1,
        ..row("2", &h("n4"), "Antigo", NOW - DAY_MS)
    };
    put(&store, row("1", &h("n5"), "Filme", NOW - DAY_MS));
    put(&store, apagado);
    let pedidos = ["1", "1", "", "2"].map(String::from);
    let plano = plan_manual_deletion(&store, ACCOUNT, ADAPTER, &pedidos).unwrap();
    assert_eq!(
        ids(&plano.targets),
        vec!["1"],
        "o repetido não duplica o alvo"
    );
    assert_eq!(plano.skipped.missing, 1, "o apagado conta; o vazio não");
    assert_eq!(plano.skipped.active, 0);
}

#[test]
fn json_dos_planos_usa_os_nomes_do_painel() {
    let store = store();
    put(&store, foreign("1", &h("1a"), old()));
    let json = serde_json::to_value(run(&store, 10)).unwrap();
    let alvo = &json["targets"][0];
    assert_eq!(
        chaves(alvo),
        vec!["filename", "hash", "known", "reason", "serviceId", "size"]
    );
    assert_eq!(alvo["serviceId"], "1");
    assert_eq!(alvo["reason"], "estrangeiro provado");
    assert_eq!(
        chaves(&json["skipped"]),
        vec!["active", "known", "notCondemned", "protected", "young"]
    );

    let manual = plan_manual_deletion(&store, ACCOUNT, ADAPTER, &["1".to_string()]).unwrap();
    let json = serde_json::to_value(&manual).unwrap();
    assert_eq!(json["targets"][0]["reason"], "manual");
    assert_eq!(chaves(&json["skipped"]), vec!["active", "missing"]);
}
