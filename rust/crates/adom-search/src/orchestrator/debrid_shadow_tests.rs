//! Testes da sombra AllDebrid: comparação nativo × Node, amostragem, erro,
//! timeout e teto de hashes. Sem rede: a referência é uma closure.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use adom_debrid::verdict::{CheckOutcome, UnusableKind};

use super::{compare, probe_hashes, run, ReferenceConfig};
use crate::orchestrator::debrid_al_metrics as metrics;

const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

struct Saved(Vec<(&'static str, Option<String>)>);

impl Saved {
    fn set(pairs: &[(&'static str, &str)]) -> Self {
        let saved = pairs
            .iter()
            .map(|(name, value)| {
                let prev = std::env::var(name).ok();
                unsafe { std::env::set_var(name, value) };
                (*name, prev)
            })
            .collect();
        Self(saved)
    }
}

impl Drop for Saved {
    fn drop(&mut self) {
        for (name, prev) in &self.0 {
            unsafe {
                match prev {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

fn outcome(cached: &[&str], known: bool, unusable: bool) -> CheckOutcome {
    CheckOutcome {
        cached: cached.iter().map(|hash| (*hash).to_string()).collect(),
        known,
        unusable: unusable.then(|| (UnusableKind::Quota, "cheio".into())),
    }
}

fn cfg(native: CheckOutcome, node: Result<CheckOutcome, String>) -> ReferenceConfig {
    ReferenceConfig {
        native,
        hashes: vec![A.into(), B.into()],
        reference: Box::new(move || node),
    }
}

fn delta(before: &BTreeMap<String, u64>, after: &BTreeMap<String, u64>, key: &str) -> u64 {
    after[key] - before[key]
}

#[test]
fn compare_e_diferenca_simetrica_restrita_ao_probe() {
    let native = outcome(&[A], true, false);
    let node = outcome(&[&A.to_uppercase(), B], true, false);
    let probe = vec![A.to_string(), B.to_string()];
    assert_eq!(compare(&native, &node, &probe), (1, 0));
    assert_eq!(compare(&node, &native, &probe), (0, 1));
    assert_eq!(compare(&native, &native, &probe), (0, 0));
    // Hash fora do probe não conta (a nativa perguntou mais que a sombra).
    assert_eq!(compare(&native, &node, &[A.to_string()]), (0, 0));
}

#[test]
fn probe_hashes_respeita_o_teto_da_sombra() {
    let _guard = crate::test_env::lock();
    let _env = Saved::set(&[("DEBRID_AL_SHADOW_MAX_HASHES", "1")]);
    assert_eq!(
        probe_hashes(&[A.to_string(), B.to_string()]),
        vec![A.to_string()]
    );
    assert!(probe_hashes(&[]).is_empty());
}

#[test]
fn sem_veredito_node_a_sombra_conta_skipped() {
    let _guard = crate::test_env::lock();
    let before = metrics::debrid_al_metrics_snapshot();
    run(cfg(
        outcome(&[A], true, false),
        Ok(outcome(&[], false, false)),
    ));
    run(cfg(
        outcome(&[A], true, false),
        Ok(outcome(&[], false, true)),
    ));
    let after = metrics::debrid_al_metrics_snapshot();
    assert_eq!(delta(&before, &after, metrics::SKIPPED), 2);
    assert_eq!(delta(&before, &after, metrics::COMPARED), 0);
}

#[test]
fn amostra_zero_nao_chama_a_referencia() {
    let _guard = crate::test_env::lock();
    let _env = Saved::set(&[("DEBRID_AL_SHADOW_PERCENT", "0")]);
    let called = Arc::new(AtomicBool::new(false));
    let flag = called.clone();
    let before = metrics::debrid_al_metrics_snapshot();
    run(ReferenceConfig {
        native: outcome(&[A], true, false),
        hashes: vec![A.to_string()],
        reference: Box::new(move || {
            flag.store(true, Ordering::SeqCst);
            Ok(outcome(&[A], true, false))
        }),
    });
    let after = metrics::debrid_al_metrics_snapshot();
    assert!(!called.load(Ordering::SeqCst));
    assert_eq!(delta(&before, &after, metrics::SKIPPED_SAMPLE), 1);
}

#[test]
fn nativa_sem_veredito_nao_vira_divergencia() {
    let _guard = crate::test_env::lock();
    let before = metrics::debrid_al_metrics_snapshot();
    // A nativa estourou o lote (known:false) e o Node confirmou A: não é
    // divergência de cache, é ausência de par.
    run(cfg(
        outcome(&[], false, false),
        Ok(outcome(&[A], true, false)),
    ));
    let after = metrics::debrid_al_metrics_snapshot();
    assert_eq!(delta(&before, &after, metrics::SKIPPED), 1);
    assert_eq!(delta(&before, &after, metrics::DIVERGENCE), 0);
    assert_eq!(delta(&before, &after, metrics::COMPARED), 0);
}

#[test]
fn comparacao_conta_divergencia_quando_o_node_sabe_de_um_hit_a_mais() {
    let _guard = crate::test_env::lock();
    let _env = Saved::set(&[("DEBRID_AL_SHADOW_PERCENT", "100")]);
    let before = metrics::debrid_al_metrics_snapshot();
    // Nativa confirma A; Node confirma A+B → falta B no nativo.
    run(cfg(
        outcome(&[A], true, false),
        Ok(outcome(&[A, B], true, false)),
    ));
    let after = metrics::debrid_al_metrics_snapshot();
    assert_eq!(delta(&before, &after, metrics::COMPARED), 1);
    assert_eq!(delta(&before, &after, metrics::DIVERGENCE), 1);
    assert_eq!(delta(&before, &after, metrics::ITEMS_MISSING), 1);
    assert_eq!(delta(&before, &after, metrics::ITEMS_EXTRA), 0);
}

#[test]
fn comparacao_sem_divergencia_quando_os_dois_concordam() {
    let _guard = crate::test_env::lock();
    let _env = Saved::set(&[("DEBRID_AL_SHADOW_PERCENT", "100")]);
    let before = metrics::debrid_al_metrics_snapshot();
    run(cfg(
        outcome(&[A], true, false),
        Ok(outcome(&[A], true, false)),
    ));
    let after = metrics::debrid_al_metrics_snapshot();
    assert_eq!(delta(&before, &after, metrics::COMPARED), 1);
    assert_eq!(delta(&before, &after, metrics::DIVERGENCE), 0);
}

#[test]
fn referencia_que_falha_conta_error_e_nao_divergencia() {
    let _guard = crate::test_env::lock();
    let _env = Saved::set(&[("DEBRID_AL_SHADOW_PERCENT", "100")]);
    let before = metrics::debrid_al_metrics_snapshot();
    run(cfg(
        outcome(&[A], true, false),
        Err("rota interna fora".into()),
    ));
    let after = metrics::debrid_al_metrics_snapshot();
    assert_eq!(delta(&before, &after, metrics::ERROR), 1);
    assert_eq!(delta(&before, &after, metrics::DIVERGENCE), 0);
}

#[test]
fn referencia_lenta_estoura_o_prazo_proprio() {
    let _guard = crate::test_env::lock();
    let _env = Saved::set(&[
        ("DEBRID_AL_SHADOW_PERCENT", "100"),
        ("DEBRID_AL_SHADOW_TIMEOUT_MS", "10"),
    ]);
    let before = metrics::debrid_al_metrics_snapshot();
    run(ReferenceConfig {
        native: outcome(&[A], true, false),
        hashes: vec![A.to_string()],
        reference: Box::new(|| {
            std::thread::sleep(Duration::from_millis(80));
            Ok(outcome(&[A], true, false))
        }),
    });
    let after = metrics::debrid_al_metrics_snapshot();
    assert_eq!(delta(&before, &after, metrics::TIMEOUT), 1);
    assert_eq!(delta(&before, &after, metrics::COMPARED), 0);
}
