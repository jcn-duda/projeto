//! Testes do TETO e da ORDEM do lote de consultas de arquivo (`sweepUndubbed`).
//!
//! A seleção é PURA (`al_sweeps_lookup`), então o teto de
//! [`MAX_FILE_LOOKUPS`] é provado sem I/O; o último teste confirma o mesmo
//! teto atravessando a rodada real com um duplo de fonte contando consultas.
//!
//! Filho de `al_sweeps_tests` (reusa os duplos e o relógio fixo de lá).

use adom_debrid::alldebrid_sweeps::{MagnetRow, SweepKind, SweepMode};

use super::super::facts::{config_of, Facts};
use super::super::lookup::{file_lookup_batch, MAX_FILE_LOOKUPS};
use super::{source, sweeper, FakeFacts, DAY, NOW};

/// Corte de idade do `sweepUndubbed` — o MESMO que a rodada calcula.
fn cutoff() -> i64 {
    NOW - config_of(SweepKind::Undubbed).min_age_ms.max(0)
}

/// Fatos de rodada com inventário presente (sem hold/retenção por padrão).
fn facts_with(preexisting: &[String]) -> Facts {
    let mut facts = Facts::default();
    facts.known_before = Some(preexisting.iter().cloned().collect());
    facts
}

/// Linha pronta, antiga e SEM prova de arquivo: candidata à consulta.
fn candidate(index: usize, uploaded_at_ms: i64) -> MagnetRow {
    MagnetRow {
        id: format!("id-{index}"),
        hash: format!("{index:040x}"),
        name: format!("Release {index}"),
        status: "Ready".into(),
        ready: true,
        uploaded_at_ms,
        files: Vec::new(),
    }
}

/// `total` candidatas com a MESMA idade (a ordem é a da listagem).
fn candidates(total: usize) -> Vec<MagnetRow> {
    (0..total)
        .map(|index| candidate(index, NOW - 30 * DAY))
        .collect()
}

fn indexes(range: std::ops::Range<usize>) -> Vec<usize> {
    range.collect()
}

// ---------------------------------------------------------------------------
// O teto: 99 / 100 / 101
// ---------------------------------------------------------------------------

#[test]
fn teto_declarado_e_cem() {
    assert_eq!(MAX_FILE_LOOKUPS, 100, "teto de lookups por rodada");
}

#[test]
fn noventa_e_nove_candidatas_consultam_noventa_e_nove() {
    let batch = file_lookup_batch(&candidates(99), &facts_with(&[]), cutoff());
    assert_eq!(batch, indexes(0..99));
}

#[test]
fn cem_candidatas_consultam_cem() {
    let batch = file_lookup_batch(&candidates(100), &facts_with(&[]), cutoff());
    assert_eq!(batch, indexes(0..100));
}

#[test]
fn cento_e_uma_candidatas_cortam_a_ultima() {
    let batch = file_lookup_batch(&candidates(101), &facts_with(&[]), cutoff());
    assert_eq!(batch.len(), MAX_FILE_LOOKUPS);
    assert_eq!(batch, indexes(0..100));
    assert_eq!(batch.last(), Some(&99), "o 100º é o último que sobra");
    assert!(
        !batch.contains(&100),
        "o 101º (o mais novo da fila) é exatamente quem fica de fora"
    );
}

#[test]
fn o_teto_corta_o_fim_da_fila_por_idade_e_preserva_a_ordem() {
    // A MAIS NOVA elegível está na POSIÇÃO 0 da listagem e as demais vêm em
    // idade decrescente: se o teto fosse um corte do array (ou uma amostra),
    // ela entraria. A fila é por idade, então a 101ª é a mais nova.
    let mut rows = vec![candidate(0, NOW - 8 * DAY)];
    rows.extend((1..=100).map(|index| candidate(index, NOW - (8 + index as i64) * DAY)));
    let batch = file_lookup_batch(&rows, &facts_with(&[]), cutoff());
    assert_eq!(batch.len(), MAX_FILE_LOOKUPS);
    assert_eq!(batch.first(), Some(&100), "as mais antigas abrem o lote");
    assert_eq!(batch.last(), Some(&1), "as menos antigas fecham o lote");
    assert!(
        !batch.contains(&0),
        "a mais nova é a 101ª da fila: fica de fora"
    );
    assert!(
        batch
            .windows(2)
            .all(|pair| rows[pair[0]].uploaded_at_ms <= rows[pair[1]].uploaded_at_ms),
        "o lote mantém a ordem de idade"
    );
}

// ---------------------------------------------------------------------------
// A cota conta CANDIDATA CONSULTÁVEL, não linha da listagem
// ---------------------------------------------------------------------------

#[test]
fn entrada_invalida_nao_consome_cota() {
    // 99 consultáveis + 1 já provada: se a inválida ocupasse cota o lote sairia
    // com 100. Só conta candidata efetivamente consultável.
    let mut rows = candidates(99);
    let mut proven = candidate(500, NOW - 30 * DAY);
    proven.files = vec!["Release.500.1080p.mkv".into()];
    rows.push(proven);
    let batch = file_lookup_batch(&rows, &facts_with(&[]), cutoff());
    assert_eq!(batch, indexes(0..99), "a linha já provada não gasta cota");
}

#[test]
fn filtro_de_elegibilidade_pinado() {
    // Cada linha viola UM critério; só a de índice 0 é consultável.
    let mut rows = vec![candidate(0, NOW - 30 * DAY)];
    let mut sem_hash = candidate(1, NOW - 30 * DAY);
    sem_hash.hash.clear();
    let mut sem_id = candidate(2, NOW - 30 * DAY);
    sem_id.id = "  ".into();
    let mut nao_pronta = candidate(3, NOW - 30 * DAY);
    nao_pronta.ready = false;
    nao_pronta.status = "Downloading".into();
    let mut ativa = candidate(4, NOW - 30 * DAY);
    ativa.status = "downloading".into();
    let mut ja_provada = candidate(5, NOW - 30 * DAY);
    ja_provada.files = vec!["a.mkv".into()];
    let sem_idade = candidate(6, 0);
    let recente = candidate(7, NOW - DAY);
    let inventariada = candidate(8, NOW - 30 * DAY);
    let retida = candidate(9, NOW - 30 * DAY);
    let held = candidate(10, NOW - 30 * DAY);
    rows.extend([
        sem_hash,
        sem_id,
        nao_pronta,
        ativa,
        ja_provada,
        sem_idade,
        recente,
        inventariada,
        retida,
        held,
    ]);
    let mut facts = facts_with(&[rows[8].hash.clone()]);
    facts.retained.insert(rows[9].hash.clone());
    facts.held.insert(rows[10].hash.clone());
    assert_eq!(
        file_lookup_batch(&rows, &facts, cutoff()),
        vec![0],
        "só a linha elegível consome cota"
    );
}

#[test]
fn hash_duplicado_consome_duas_cotas_sem_dedupe() {
    // Comportamento ATUAL, pinado (não corrigido): a seleção NÃO deduplica
    // hash — duas linhas do mesmo hash gastam dois lookups e empurram a 101ª
    // candidata para fora do lote.
    let mut rows = candidates(99);
    let mut twin = candidate(0, NOW - 30 * DAY);
    twin.id = "id-twin".into();
    twin.hash = rows[0].hash.clone();
    rows.push(twin);
    rows.push(candidate(100, NOW - 30 * DAY));
    let batch = file_lookup_batch(&rows, &facts_with(&[]), cutoff());
    assert_eq!(batch.len(), MAX_FILE_LOOKUPS);
    assert!(
        batch.contains(&0) && batch.contains(&99),
        "as duas linhas do mesmo hash entram"
    );
    assert!(!batch.contains(&100), "a 101ª candidata fica fora");
}

#[test]
fn sem_inventario_ninguem_e_consultado() {
    // `known_before` ausente = sem referência autorizada: lote vazio.
    assert!(file_lookup_batch(&candidates(3), &Facts::default(), cutoff()).is_empty());
}

// ---------------------------------------------------------------------------
// O teto atravessa a rodada real (contador de consultas do duplo)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rodada_de_cento_e_cinquenta_para_em_cem_consultas() {
    let source = source(Some(candidates(150)));
    let report = sweeper(SweepMode::ReadOnly, source.clone(), FakeFacts::loaded(&[]))
        .tick(NOW)
        .await;
    let calls = source.file_calls();
    assert!(
        calls.len() <= MAX_FILE_LOOKUPS,
        "nenhuma rodada passa de {MAX_FILE_LOOKUPS} consultas (foram {})",
        calls.len()
    );
    assert_eq!(
        calls,
        (0..MAX_FILE_LOOKUPS)
            .map(|index| format!("id-{index}"))
            .collect::<Vec<_>>(),
        "consulta exatamente o lote selecionado, uma vez cada"
    );
    assert!(
        !report.outcomes.is_empty(),
        "a rodada rodou os quatro tipos"
    );
}
