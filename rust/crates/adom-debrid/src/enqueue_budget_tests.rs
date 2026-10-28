use super::{EnqueueBudget, WINDOW_MS};

const ADAPTER: &str = "torbox";
const ACCOUNT: &str = "acc_budget";
const T0: i64 = 1_700_000_000_000;

/// Porte de `test/autofetch-queue.test.ts`: três aceitos, o quarto barrado, e
/// outra conta com orçamento próprio.
#[test]
fn limite_de_tres_libera_tres_e_bloqueia_o_quarto() {
    let budget = EnqueueBudget::new();
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(3), T0));
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(3), T0 + 1));
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(3), T0 + 2));
    assert!(
        !budget.check_and_record(ADAPTER, ACCOUNT, Some(3), T0 + 3),
        "quarto enqueue bloqueado pelo limite"
    );
    assert!(budget.check_and_record(ADAPTER, "other_user", Some(3), T0));
    assert_eq!(
        budget.used(ADAPTER, ACCOUNT, T0 + 3),
        3,
        "recusa não consome orçamento"
    );
}

#[test]
fn janela_deslizante_solta_um_carimbo_por_vez() {
    let budget = EnqueueBudget::new();
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(2), T0));
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(2), T0 + 10));
    assert!(!budget.check_and_record(ADAPTER, ACCOUNT, Some(2), T0 + 11));

    // 1h depois do PRIMEIRO carimbo ele sai da janela e abre uma vaga só.
    let later = T0 + WINDOW_MS + 1;
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(2), later));
    assert!(!budget.check_and_record(ADAPTER, ACCOUNT, Some(2), later));
}

#[test]
fn carimbo_na_borda_da_janela_ja_expirou() {
    let budget = EnqueueBudget::new();
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(1), T0));
    assert_eq!(budget.used(ADAPTER, ACCOUNT, T0 + WINDOW_MS - 1), 1);
    assert_eq!(budget.used(ADAPTER, ACCOUNT, T0 + WINDOW_MS), 0);
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(1), T0 + WINDOW_MS));
}

#[test]
fn sem_limite_sempre_libera_mas_registra() {
    let budget = EnqueueBudget::new();
    for offset in 0..50 {
        assert!(budget.check_and_record(ADAPTER, ACCOUNT, None, T0 + offset));
    }
    assert_eq!(budget.used(ADAPTER, ACCOUNT, T0 + 49), 50);
}

#[test]
fn limite_zero_bloqueia_tudo_sem_registrar() {
    let budget = EnqueueBudget::new();
    assert!(!budget.check_and_record(ADAPTER, ACCOUNT, Some(0), T0));
    assert_eq!(budget.used(ADAPTER, ACCOUNT, T0), 0);
}

#[test]
fn chave_vazia_nao_orcamenta_nem_bloqueia() {
    let budget = EnqueueBudget::new();
    assert!(budget.check_and_record("", ACCOUNT, Some(1), T0));
    assert!(budget.check_and_record(ADAPTER, "", Some(1), T0));
    assert_eq!(budget.used("", ACCOUNT, T0), 0);
    assert_eq!(budget.used(ADAPTER, "", T0), 0);
    budget.block_budget("", ACCOUNT, 5_000, T0);
    assert_eq!(budget.budget_blocked_until("", ACCOUNT, T0), 0);
}

#[test]
fn block_budget_guarda_ate_o_prazo_e_expira_sozinho() {
    let budget = EnqueueBudget::new();
    budget.block_budget(ADAPTER, ACCOUNT, 30_000, T0);
    assert_eq!(
        budget.budget_blocked_until(ADAPTER, ACCOUNT, T0 + 1),
        T0 + 30_000
    );
    assert_eq!(
        budget.budget_blocked_until(ADAPTER, ACCOUNT, T0 + 29_999),
        T0 + 30_000
    );
    assert_eq!(
        budget.budget_blocked_until(ADAPTER, ACCOUNT, T0 + 30_000),
        0
    );
    assert_eq!(
        budget.budget_blocked_until(ADAPTER, "other_user", T0 + 1),
        0,
        "bloqueio não vaza entre contas"
    );
}

#[test]
fn backoff_nao_positivo_nao_bloqueia_nem_encurta() {
    let budget = EnqueueBudget::new();
    budget.block_budget(ADAPTER, ACCOUNT, 0, T0);
    budget.block_budget(ADAPTER, ACCOUNT, -5, T0);
    assert_eq!(budget.budget_blocked_until(ADAPTER, ACCOUNT, T0), 0);

    budget.block_budget(ADAPTER, ACCOUNT, 10_000, T0);
    budget.block_budget(ADAPTER, ACCOUNT, 0, T0 + 1);
    assert_eq!(
        budget.budget_blocked_until(ADAPTER, ACCOUNT, T0 + 1),
        T0 + 10_000,
        "backoff zero não encurta o bloqueio vigente"
    );
}

#[test]
fn reset_de_uma_chave_preserva_as_outras() {
    let budget = EnqueueBudget::new();
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(2), T0));
    assert!(budget.check_and_record(ADAPTER, "other_user", Some(2), T0));
    budget.block_budget(ADAPTER, ACCOUNT, 60_000, T0);

    budget.reset_budget(Some(ADAPTER), Some(ACCOUNT));
    assert_eq!(budget.used(ADAPTER, ACCOUNT, T0), 0);
    assert_eq!(budget.budget_blocked_until(ADAPTER, ACCOUNT, T0), 0);
    assert_eq!(
        budget.used(ADAPTER, "other_user", T0),
        1,
        "reset por chave não toca outra conta"
    );

    budget.reset_budget(None, None);
    assert_eq!(budget.used(ADAPTER, "other_user", T0), 0);
}

#[test]
fn reset_com_apenas_um_lado_limpa_tudo() {
    let budget = EnqueueBudget::new();
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(2), T0));
    budget.block_budget(ADAPTER, ACCOUNT, 60_000, T0);
    budget.reset_budget(Some(ADAPTER), None);
    assert_eq!(budget.used(ADAPTER, ACCOUNT, T0), 0);
    assert_eq!(budget.budget_blocked_until(ADAPTER, ACCOUNT, T0), 0);
}

#[test]
fn clones_compartilham_o_mesmo_contador() {
    fn assert_shared<T: Send + Sync + 'static>() {}
    assert_shared::<EnqueueBudget>();

    let budget = EnqueueBudget::new();
    let clone = budget.clone();
    assert!(clone.check_and_record(ADAPTER, ACCOUNT, Some(2), T0));
    assert!(budget.check_and_record(ADAPTER, ACCOUNT, Some(2), T0));
    assert!(!budget.check_and_record(ADAPTER, ACCOUNT, Some(2), T0));
}
