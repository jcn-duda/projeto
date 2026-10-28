//! Paridade da metade de LOTE do recheck: `runRecheck` (settle, expiração,
//! terminal de progresso) e `manageSettleLru`, de `autofetch-settle-expire.test.ts`
//! e da parte pura de `autofetch-stalls*.test.ts`.
//!
//! Nada aqui lê relógio: `age_ms` e o horizonte já vêm medidos.

use super::{lot_outcome, settle_lru_evictions, LotFacts, LotOutcome, SettleLotRef};

fn facts() -> LotFacts {
    LotFacts {
        remaining: 2,
        is_settle: false,
        attempts: 0,
        recheck_max: 24,
        age_ms: 0,
        settle_horizon_ms: 1_800_000,
    }
}

fn settle_lot(key: &str, created_at: i64) -> SettleLotRef {
    SettleLotRef {
        search_key: key.to_string(),
        created_at,
        info_hashes: vec![format!("{key}-hash")],
        is_settle: true,
        adapter_id: "alldebrid".to_string(),
    }
}

#[test]
fn lote_vazio_termina_e_descarta_a_fila() {
    assert_eq!(
        lot_outcome(LotFacts {
            remaining: 0,
            ..facts()
        }),
        LotOutcome::Finished
    );
    // Lote vazio termina ANTES de olhar settle/idade: nada a expirar.
    assert_eq!(
        lot_outcome(LotFacts {
            remaining: 0,
            is_settle: true,
            age_ms: 9_999_999,
            ..facts()
        }),
        LotOutcome::Finished
    );
}

#[test]
fn settle_vencido_expira_no_limiar_exato() {
    assert_eq!(
        lot_outcome(LotFacts {
            is_settle: true,
            age_ms: 1_799_999,
            ..facts()
        }),
        LotOutcome::Continue
    );
    assert_eq!(
        lot_outcome(LotFacts {
            is_settle: true,
            age_ms: 1_800_000,
            ..facts()
        }),
        LotOutcome::Expired
    );
}

#[test]
fn entrar_em_settle_nao_drena_a_fila() {
    // `attempts >= autoFetchRecheckMax` entra em settle — e NADA é drenado.
    // Dreno só por evidência comprovada; settle é espera, não prova.
    assert_eq!(
        lot_outcome(LotFacts {
            attempts: 23,
            ..facts()
        }),
        LotOutcome::Continue
    );
    assert_eq!(
        lot_outcome(LotFacts {
            attempts: 24,
            ..facts()
        }),
        LotOutcome::EnterSettle
    );
    // Já em settle, o contador não faz voltar a "entrar em settle".
    assert_eq!(
        lot_outcome(LotFacts {
            is_settle: true,
            attempts: 999,
            age_ms: 1_000,
            ..facts()
        }),
        LotOutcome::Continue
    );
}

#[test]
fn expiracao_vence_a_entrada_em_settle() {
    assert_eq!(
        lot_outcome(LotFacts {
            is_settle: true,
            attempts: 999,
            age_ms: 1_800_000,
            ..facts()
        }),
        LotOutcome::Expired
    );
}

#[test]
fn settle_lru_evicta_os_mais_antigos_primeiro() {
    let lots = vec![
        settle_lot("novo", 300),
        settle_lot("antigo", 100),
        settle_lot("meio", 200),
    ];
    let evicted = settle_lru_evictions(&lots, 2);
    assert_eq!(evicted.len(), 1);
    assert_eq!(evicted[0].search_key, "antigo");
    // O adapter do PRÓPRIO lote viaja junto: é com ele que a memória de
    // progresso é limpa, nunca com o adapter "corrente".
    assert_eq!(evicted[0].adapter_id, "alldebrid");
}

#[test]
fn settle_lru_nao_mexe_dentro_do_limite() {
    let lots = vec![settle_lot("a", 1), settle_lot("b", 2)];
    assert!(settle_lru_evictions(&lots, 2).is_empty());
    assert!(settle_lru_evictions(&lots, 8).is_empty());
}

#[test]
fn settle_lru_ignora_lotes_que_ainda_nao_assentaram() {
    let mut vivo = settle_lot("vivo", 0);
    vivo.is_settle = false;
    let lots = vec![
        vivo,
        settle_lot("s1", 10),
        settle_lot("s2", 20),
        settle_lot("s3", 30),
    ];
    let evicted = settle_lru_evictions(&lots, 2);
    assert_eq!(evicted.len(), 1);
    assert_eq!(evicted[0].search_key, "s1");
}
