//! Seleção PURA do lote de consultas de arquivo do `sweepUndubbed`.
//!
//! Separado de `al_sweeps_run` por dois motivos: o teto de 400 linhas do
//! arquivo de execução e, principalmente, para o TETO de lookups ser testável
//! sem I/O — a decisão de QUEM consultar não fala com a conta. O orquestrador
//! (`Sweeper::load_audio_proofs`) só chama este lote e faz as consultas.

use adom_debrid::alldebrid_sweeps::MagnetRow;

use super::facts::Facts;

/// `DEBRID_SWEEP_UNDUBBED_MAX` (100): teto de consultas de arquivo por rodada,
/// o mesmo `max_per_round` da decisão. Aplicado UMA vez, no fim da seleção —
/// corte do FIM da fila ordenada por idade, nunca amostragem.
pub(super) const MAX_FILE_LOOKUPS: usize = 100;

/// Índices das linhas que merecem consulta de arquivo, as mais antigas
/// primeiro, no máximo [`MAX_FILE_LOOKUPS`].
///
/// Só entra linha sem prova (`files` vazio), pronta, não ativa, de idade
/// provada e fora do inventário/hold/retenção. Sem `known_before` não há
/// referência autorizada: o lote é vazio (a rodada fecha, como antes).
pub(super) fn file_lookup_batch(rows: &[MagnetRow], facts: &Facts, cutoff_ms: i64) -> Vec<usize> {
    let Some(known_before) = facts.known_before.as_ref() else {
        return Vec::new();
    };
    let mut candidates: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let hash = row.normalized_hash();
            if hash.is_empty()
                || row.id.trim().is_empty()
                || !row.is_ready()
                || row.is_active()
                || !row.files.is_empty()
                || row.uploaded_at_ms <= 0
                || row.uploaded_at_ms > cutoff_ms
                || known_before.contains(&hash)
                || facts.held.contains(&hash)
                || facts.retained.contains(&hash)
            {
                return None;
            }
            Some(index)
        })
        .collect();
    // Os mais antigos primeiro: o lote limitado é o que a varredura pode
    // apagar nesta rodada (mesmo `max_per_round` da decisão).
    candidates.sort_by_key(|index| rows[*index].uploaded_at_ms);
    candidates.truncate(MAX_FILE_LOOKUPS);
    candidates
}
