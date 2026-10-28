//! Posse durável no passo ÚNICO: a régua de `ALLDEBRID_SUBMITTED_TTL_MS` do
//! Node (`hasDurableOwnership`, `src/debrid/alldebrid-inventory.ts:117-132`)
//! vale IGUAL no nativo. Kill-switch de um lado só é pior que nenhum: o
//! operador acharia ter desligado a evicção e ela seguiria lendo `adsub` por
//! presença (`evict_job.rs:325`) — apagando na conta do usuário.
//!
//! O `config()` do arquivo pai tem `ownership: true` (default do Node = 7 dias);
//! aqui o campo é desligado explicitamente, sem mexer em env do processo.

use super::*;

/// TTL <= 0 (posse desligada): nada é pedido, removido ou marcado — e a conta
/// NÃO é tocada. O motivo é o do PASSO, não o de cada item.
#[tokio::test]
async fn posse_desligada_zera_o_passo_e_nao_toca_a_conta() {
    let kv = kv();
    let ready = completo(&kv);
    let io = StubIo::new(vec![Ok(vec![FALLBACK.to_string()])]);
    let mut off = config();
    off.ownership = false;

    let report = run(&kv, &io, &work(&ready), &off, NOW).await;

    assert_eq!((report.requested, report.removed, report.marked), (0, 0, 0));
    assert_eq!(report.skips.get("evict-ownership-off"), Some(&1));
    assert!(report.errors.is_empty(), "desligado não é erro");
    assert!(io.calls().is_empty(), "posse desligada: zero ida à conta");
    assert!(
        kv.get_json(&adrm_key(ACCOUNT, FALLBACK), NOW)
            .unwrap()
            .is_none(),
        "sem remoção não nasce `adrm`"
    );
}

/// TTL > 0 (o default do Node, 7 dias): o MESMO cenário abre o gate e o
/// fallback sem prova sai — a régua não virou bloqueio permanente.
#[tokio::test]
async fn posse_ligada_abre_o_gate_e_remove() {
    let kv = kv();
    let ready = completo(&kv);
    let io = StubIo::new(vec![Ok(vec![FALLBACK.to_string()])]);

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 1, "gate de posse aberto autoriza o plano");
    assert_eq!(report.removed, 1);
    assert_eq!(report.marked, 1);
    assert_eq!(io.calls(), vec![vec![FALLBACK.to_string()]]);
    assert_eq!(report.skips.get("evict-ownership-off"), None);
}
