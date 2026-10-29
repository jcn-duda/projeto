//! Testes da decisão pura da poda do `adprot` (`pruneMissing` do Node).

use std::collections::HashSet;

use super::{prune_missing_plan, RetentionEntry};

const NOW: i64 = 1_700_000_000_000;
const GRACE: i64 = 30 * 60 * 1000;

fn entry(hash: &str, accepted: Option<i64>) -> RetentionEntry {
    RetentionEntry {
        hash: hash.to_string(),
        accepted_at_ms: accepted,
    }
}

fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|item| item.to_string()).collect()
}

#[test]
fn so_poda_o_ausente_sem_hold_e_velho() {
    let entries = vec![
        entry("aaaa", Some(NOW - GRACE - 1)),
        entry("bbbb", Some(NOW - GRACE)),
        entry("cccc", Some(NOW - GRACE + 1)),
        entry("dddd", None),
    ];
    let plan = prune_missing_plan(&entries, &set(&["bbbb"]), &set(&["cccc"]), GRACE, NOW);
    // `bbbb` está na conta e `cccc` em hold: ficam. `dddd` sem carimbo não
    // prova idade — a graça NÃO o protege (o "corrompido" do Node).
    assert_eq!(plan, vec!["aaaa".to_string(), "dddd".to_string()]);
}

#[test]
fn graca_desligada_nao_segura_ninguem() {
    let entries = vec![entry("aaaa", Some(NOW - 1))];
    assert_eq!(
        prune_missing_plan(&entries, &HashSet::new(), &HashSet::new(), 0, NOW),
        vec!["aaaa".to_string()],
        "grace_ms <= 0 poda até o jovem: sem régua de idade não há o que esperar"
    );
}

#[test]
fn carimbo_no_futuro_e_jovem_demais_para_podar() {
    let entries = vec![entry("aaaa", Some(NOW + 60_000))];
    assert!(
        prune_missing_plan(&entries, &HashSet::new(), &HashSet::new(), GRACE, NOW).is_empty(),
        "idade negativa (relógio torto) é jovem: registro fica"
    );
}

#[test]
fn vazio_e_hash_vazia_nada_fazem() {
    assert!(prune_missing_plan(&[], &HashSet::new(), &HashSet::new(), GRACE, NOW).is_empty());
    let entries = vec![entry("", Some(0))];
    assert!(prune_missing_plan(&entries, &HashSet::new(), &HashSet::new(), GRACE, NOW).is_empty());
}
