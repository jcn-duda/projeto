//! Porte de `src/utils/latest-writer.ts` â€” coordenador de versÃµes concorrentes
//! da MESMA busca (parcial na resposta, tardio mescla depois).
//!
//! A mecÃ¢nica do TS, mantida fiÃ©l:
//!
//! - **fase** invalida uma estratÃ©gia antiga (episÃ³dio quando o fallback de
//!   pack comeÃ§a) â€” `advance()`;
//! - **revisÃ£o** garante que o lote mais novo da fase vence mesmo se o
//!   pÃ³s-processamento terminar antes;
//! - **resgate de defasado** (`staleRescue`): um lote de fase ANTIGA e ÃšTIL
//!   ainda pode salvar a busca quando nenhuma fase nova trouxe valor â€” mas um
//!   lote antigo VAZIO jamais substitui resultado Ãºtil mais recente.
//!
//! A "mesclagem" do tardio NÃƒO Ã© concatenaÃ§Ã£o de listas: o passe tardio
//! reconstrÃ³i a lista do ZERO com a coleta COMPLETA (`CollectWindow::completion`)
//! e regrava a entrada â€” por isso o writer sÃ³ decide SE o commit acontece
//! (fase atual, ou resgate), e o QUE gravar vem do rebuild. `commit` aqui Ã©
//! sÃ­ncrono; a fatia de integraÃ§Ã£o o liga Ã  escrita do store SWR
//! (`crate::cache`) dentro de `runtime.capture()`.

use std::sync::Mutex;

#[derive(Debug, Default)]
struct WriterState {
    phase: u64,
    revision: u64,
    /// Ãšltima fase que commitou valor ÃšTIL (`-1` = nenhuma).
    useful_phase: i64,
}

#[derive(Debug, Default)]
pub struct LatestWriter {
    state: Mutex<WriterState>,
}

/// O que `run` decidiu sobre o commit â€” observÃ¡vel para o log/trace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitKind {
    /// Fase atual e revisÃ£o mais nova: commit normal.
    Current,
    /// Fase antiga, mas Ãºtil e nenhuma fase nova foi Ãºtil: resgate.
    StaleRescue,
    /// NÃ£o commitou (defasado e sem resgate possÃ­vel).
    Skipped,
}

impl LatestWriter {
    pub fn new() -> Self {
        LatestWriter {
            state: Mutex::new(WriterState {
                // `usefulPhase = -1` do TS: nenhuma fase commitou valor útil.
                useful_phase: -1,
                ..WriterState::default()
            }),
        }
    }

    /// `run.phase()`.
    pub fn phase(&self) -> u64 {
        self.state.lock().expect("estado do writer").phase
    }

    /// `run.advance()`: a fase nova invalida a antiga. Devolve a fase.
    pub fn advance(&self) -> u64 {
        let mut state = self.state.lock().expect("estado do writer");
        state.phase += 1;
        state.revision += 1;
        state.phase
    }

    /// Porte de `run(input, expectedPhase)` â€” sem `await`: `build` produz o
    /// valor, `useful` decide (`default: lista não vazia` no TS) e `commit`
    /// grava QUANDO a versÃ£o ainda Ã© a mais nova (ou resgata). O valor SEMPRE
    /// volta, como no TS â€” a resposta parcial sai mesmo quando o commit não
    /// roda.
    pub fn run<T>(
        &self,
        expected_phase: u64,
        build: impl FnOnce() -> T,
        useful: impl Fn(&T) -> bool,
        mut commit: impl FnMut(&T),
    ) -> (T, CommitKind) {
        // `const ownRevision = ++revision` â€” atÃ´mico com a leitura de fase.
        let own_revision = {
            let mut state = self.state.lock().expect("estado do writer");
            state.revision += 1;
            state.revision
        };
        let value = build();
        let decision = {
            let state = self.state.lock().expect("estado do writer");
            let current = expected_phase == state.phase && own_revision == state.revision;
            let stale_rescue = expected_phase < state.phase
                && useful(&value)
                && state.useful_phase < expected_phase as i64;
            if current {
                CommitKind::Current
            } else if stale_rescue {
                CommitKind::StaleRescue
            } else {
                CommitKind::Skipped
            }
        };
        if decision != CommitKind::Skipped {
            commit(&value);
            if useful(&value) {
                let mut state = self.state.lock().expect("estado do writer");
                state.useful_phase = state.useful_phase.max(expected_phase as i64);
            }
        }
        (value, decision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Useful padrão do TS: lista não vazia. `&Vec` de propósito: o item fn
    /// é inferido contra `Fn(&T)` de [`LatestWriter::run`] — com fatia, o
    /// `T` vira `[String]` (unsized) e a inferência quebra.
    #[allow(clippy::ptr_arg)]
    fn useful(v: &Vec<String>) -> bool {
        !v.is_empty()
    }

    #[test]
    fn fase_atual_commita_e_devolve_o_valor() {
        let writer = LatestWriter::new();
        let (value, kind) = writer.run(0, || vec!["a".to_string()], useful, |_| {});
        assert_eq!(value, vec!["a".to_string()]);
        assert_eq!(kind, CommitKind::Current);
    }

    #[test]
    fn fase_antiga_vazia_nao_substitui_fase_nova() {
        let writer = LatestWriter::new();
        writer.advance();
        let (_value, kind) = writer.run(0, Vec::<String>::new, useful, |_| panic!("não commita"));
        assert_eq!(kind, CommitKind::Skipped);
    }

    #[test]
    fn lote_tardio_da_fase_atual_vence_o_defasado() {
        // RevisÃ£o: o pÃ³s-processamento antigo termina DEPOIS do novo â€” o mais
        // novo vence mesmo assim.
        let writer = LatestWriter::new();
        let commits = std::sync::Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let (primeiro, k1) = {
            let commits = commits.clone();
            writer.run(
                0,
                || vec!["parcial".to_string()],
                useful,
                move |v: &Vec<String>| commits.lock().unwrap().push(v.clone()),
            )
        };
        // Fase avanÃ§a (fallback de pack comeÃ§ou) e o tardio da fase nova commita.
        writer.advance();
        let (segundo, k2) = {
            let commits = commits.clone();
            writer.run(
                1,
                || vec!["completa".to_string()],
                useful,
                move |v: &Vec<String>| commits.lock().unwrap().push(v.clone()),
            )
        };
        // O antigo termina por Ãºltimo e Ã© descartado.
        let (_terceiro, k3) = {
            let commits = commits.clone();
            writer.run(
                0,
                || vec!["velho".to_string()],
                useful,
                move |v: &Vec<String>| commits.lock().unwrap().push(v.clone()),
            )
        };
        assert_eq!(k1, CommitKind::Current);
        assert_eq!(k2, CommitKind::Current);
        assert_eq!(k3, CommitKind::Skipped);
        assert_eq!(primeiro, vec!["parcial".to_string()]);
        assert_eq!(segundo, vec!["completa".to_string()]);
        let guard = commits.lock().unwrap();
        assert_eq!(*guard, vec![vec!["parcial"], vec!["completa"]]);
    }

    #[test]
    fn defasado_util_resgata_quando_nenhuma_fase_nova_foi_util() {
        let writer = LatestWriter::new();
        writer.advance(); // fase 1 commitou algo VAZIO.
        let (_vazio, k) = writer.run(1, Vec::<String>::new, useful, |_| {});
        assert_eq!(k, CommitKind::Current);
        // A fase 0 ainda tem um lote Ãºtil em voo: resgata.
        let commits = Mutex::new(Vec::<Vec<String>>::new());
        let (_resgate, k2) = {
            let commits = &commits;
            writer.run(
                0,
                || vec!["salva".to_string()],
                useful,
                move |v: &Vec<String>| commits.lock().unwrap().push(v.clone()),
            )
        };
        assert_eq!(k2, CommitKind::StaleRescue);
        assert_eq!(*commits.lock().unwrap(), vec![vec!["salva"]]);
        // Resgatou uma vez; não resgata de novo (usefulPhase >= fase).
        let (_nada, k3) = writer.run(
            0,
            || vec!["de novo".to_string()],
            useful,
            |_| panic!("não resgata 2×"),
        );
        assert_eq!(k3, CommitKind::Skipped);
    }
}
