//! Segunda fatia das fixtures da DECISÃO pura.
//!
//! Cobre o que a part1 não pinava: a **idade do `sweepUndubbed`** (o `adrm` de
//! 3 dias que bloqueia re-upload só nasce do que esta régua manda apagar),
//! a **retenção BR no `sweepDead`**, a **posse do `reconcile`** e a
//! **máquina de estados** (`active`/`not_ready`).
//!
//! Os fixtures (`row`/`dead_row`/`Facts`) vêm da part1 por `super`: um único
//! construtor para as duas fatias, nenhuma cópia.

use super::super::{plan_reconcile, plan_sweep_dead, plan_sweep_undubbed, Reason, SweepConfig};
use super::{dead_row, hash_of, row, Facts, DAY, NOW, UPLOADED};

/// `uploadDate` recente o bastante para o piso de 7 d barrar: o magnet está na
/// conta há 2 d, e apagá-lo agora gravaria `adrm` em cima de acervo novo.
#[test]
fn sweep_undubbed_arquivo_recente_fica_por_idade() {
    let mut recent = row('a');
    recent.uploaded_at_ms = NOW - 2 * DAY;
    let facts = Facts::loaded();
    let plan = plan_sweep_undubbed(&[recent], &facts.view(), &SweepConfig::undubbed());
    assert!(plan.delete.is_empty(), "jovem demais: não entra no plano");
    assert_eq!(plan.skip[&hash_of('a')], Reason::TooYoung);
    assert_eq!(plan.keep, vec![hash_of('a')], "keep e skip andam juntos");
}

/// `uploadDate` ausente/ilegível (`0`) é idade NÃO PROVADA: fail-safe, o
/// arquivo fica. Sem isto, uma linha sem data condenaria o magnet e gravaria
/// `adrm` (3 dias de bloqueio de re-upload) em cima de culpa não provada.
#[test]
fn sweep_undubbed_sem_data_de_upload_nao_apaga() {
    let mut sem_data = row('a');
    sem_data.uploaded_at_ms = 0;
    let facts = Facts::loaded();
    let plan = plan_sweep_undubbed(&[sem_data], &facts.view(), &SweepConfig::undubbed());
    assert!(
        plan.delete.is_empty(),
        "data ausente nunca vira delete (fail-safe)"
    );
    assert_eq!(plan.skip[&hash_of('a')], Reason::NoUploadDate);
}

/// Idade acima do piso: o magnet estrangeiro provado É o alvo da varredura.
#[test]
fn sweep_undubbed_arquivo_velho_entra_no_plano() {
    let mut velho = row('a');
    velho.uploaded_at_ms = NOW - 8 * DAY; // piso default = 7 d
    let facts = Facts::loaded();
    let plan = plan_sweep_undubbed(&[velho], &facts.view(), &SweepConfig::undubbed());
    assert_eq!(plan.delete, vec![hash_of('a')]);
    assert!(plan.skip.is_empty(), "quem sai não carrega motivo");
}

/// Fronteira EXATA da régua: a comparação é `idade > limiar` (estrita), então
/// idade == `min_age_ms` JÁ SAI e um único ms a menos ainda fica. Pinado para
/// que um `<` no lugar de `<=` (ou vice-versa) não passe despercebido.
#[test]
fn sweep_undubbed_fronteira_de_idade_esta_pinada() {
    let config = SweepConfig::undubbed();
    assert_eq!(config.min_age_ms, 7 * DAY, "piso default do sweepUndubbed");
    let mut exato = row('a');
    exato.uploaded_at_ms = NOW - config.min_age_ms;
    let mut um_ms_mais_novo = row('b');
    um_ms_mais_novo.uploaded_at_ms = NOW - config.min_age_ms + 1;
    let facts = Facts::loaded();
    let plan = plan_sweep_undubbed(&[exato, um_ms_mais_novo], &facts.view(), &config);
    assert_eq!(
        plan.delete,
        vec![hash_of('a')],
        "idade == limiar SAI (régua `>` estrita)"
    );
    assert_eq!(plan.skip[&hash_of('b')], Reason::TooYoung);
}

/// Decisão DELIBERADA desta fatia (documentada em `alldebrid_sweeps.rs`, régua
/// 4): a retenção BR vale TAMBÉM no `sweepDead` — o TS apagava morto retido;
/// aqui o pack BR multiobra retido é acervo caro e fica. O morto comum sai: a
/// única diferença entre as duas linhas é o `adprot`.
#[test]
fn sweep_dead_respeita_retencao_br() {
    let rows = [dead_row('a'), dead_row('b')];
    let mut facts = Facts::loaded();
    facts.retained.insert(hash_of('a'));
    let plan = plan_sweep_dead(&rows, &facts.view(), &SweepConfig::dead());
    assert_eq!(plan.delete, vec![hash_of('b')], "morto não retido sai");
    assert_eq!(
        plan.skip[&hash_of('a')],
        Reason::RetentionBr,
        "o motivo tem que ser o BR, não um freio vizinho"
    );
    assert_eq!(plan.count(Reason::RetentionBr), 1);
}

/// Reconcile: posse (`adsub`) AUSENTE não apaga (`no_ownership`); com a
/// etiqueta no instante do upload, o mesmo magnet sai. A única variável entre
/// as duas rodadas é `owned_at`.
#[test]
fn reconcile_posse_ausente_nao_apaga_e_etiquetada_apaga() {
    let rows = [row('a'), row('b')];
    let mut facts = Facts::loaded();
    facts.owned_at.insert(hash_of('a'), UPLOADED);
    let plan = plan_reconcile(&rows, &facts.view(), &SweepConfig::reconcile());
    assert_eq!(plan.delete, vec![hash_of('a')], "posse provada sai");
    assert_eq!(plan.skip[&hash_of('b')], Reason::NoOwnership);
    assert_eq!(plan.keep, vec![hash_of('b')]);

    // Sem etiqueta nenhuma, o MESMO par continua na conta.
    let sem_posse = Facts::loaded();
    let plan = plan_reconcile(&rows, &sem_posse.view(), &SweepConfig::reconcile());
    assert!(plan.delete.is_empty(), "sem posse ninguém sai");
    assert_eq!(plan.count(Reason::NoOwnership), 2);
}

/// Máquina de estados do `reconcile`: download em curso é `active` (não é
/// lixo), não-pronto e parado é `not_ready` (o reconcile não mexe) e só o
/// `ready` nosso e antigo entra no plano.
#[test]
fn reconcile_estados_active_e_not_ready_ficam() {
    let mut baixando = row('a');
    baixando.status = "Downloading".into();
    baixando.ready = false;
    let mut parado = row('b');
    parado.status = "waiting".into();
    parado.ready = false;
    let mut pronto = row('c');
    pronto.status = "Ready".into();
    pronto.ready = true;
    let mut facts = Facts::loaded();
    for ch in ['a', 'b', 'c'] {
        facts.owned_at.insert(hash_of(ch), UPLOADED);
    }
    let plan = plan_reconcile(
        &[baixando, parado, pronto],
        &facts.view(),
        &SweepConfig::reconcile(),
    );
    assert_eq!(plan.delete, vec![hash_of('c')], "só o pronto sai");
    assert_eq!(plan.skip[&hash_of('a')], Reason::Active);
    assert_eq!(plan.skip[&hash_of('b')], Reason::NotReady);
}

/// O `sweepUndubbed` também não toca download em curso: apagar no meio do
/// download desperdiça a vaga e não prova áudio nenhum.
#[test]
fn sweep_undubbed_download_em_curso_fica() {
    let mut processando = row('a');
    processando.status = "Processing".into();
    processando.ready = false;
    let facts = Facts::loaded();
    let plan = plan_sweep_undubbed(&[processando], &facts.view(), &SweepConfig::undubbed());
    assert!(plan.delete.is_empty());
    assert_eq!(plan.skip[&hash_of('a')], Reason::Active);
}
