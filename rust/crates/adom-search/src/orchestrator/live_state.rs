//! Estado vivo POR indexer de UMA coleta — o snapshot do `collectRaw` do Node
//! (que a rota interna de coleta devolvia antes da R5; hoje o coletor nativo
//! preenche).
//!
//! É o transporte do contrato de `src/providers/live-indexer-state.ts` para o
//! orquestrador, com as réguas que o `clearInstantSnapshots`/fallback do Node
//! leem: **falha isolada** (um indexer fora com outro servindo) preserva a
//! reserva 📦 do que falhou; **pending/unknown não provam sucesso**; **empty**
//! só é vazio suspeito quando o Node NÃO o marcou falho nem pendente
//! (`suspectIndexers()` = `empty − failed − pending` — conferido no TS antes
//! de inferir aqui).
//!
//! Dois campos do estado Node NÃO atravessam o fio (`snapshot()` exporta só
//! chaves): o MOTIVO de cada falha (`reason`) e `served` (quem entregou item
//! relevante). Consequências assumidas, ambas conservadoras:
//!
//! - sem `reason`, a falha é genérica — o motivo só aparece em log no TS;
//! - sem `served`, a fusão de coletas não consegue DESFAZER suspeita que outra
//!   coleta da mesma obra superou (o Node desfaz via `served`): aqui ela fica.
//!   Manter um 📦/selo a mais é seguro; inventar prova de sucesso e derrubar a
//!   reserva sem reinjeção do banco não é.
//!
//! A fusão segue `mergeLiveIndexerStates` na parte reproduzível com o fio
//! atual: união dos conjuntos e `all` por prioridade (`error` > `pending` >
//! `ok` > `unknown`). Sucesso de UM lote/coletor nunca apaga falha registrada
//! em outro; ausência de estado (`None`) não prova nada nos dois sentidos.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use crate::internal_types::LiveSnapshot;

/// Estado do ramo agregado `/all` (`AllState` do TS).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LiveAllState {
    #[default]
    Unknown,
    Pending,
    Ok,
    Error,
}

impl LiveAllState {
    fn from_wire(text: &str) -> Self {
        match text {
            "pending" => Self::Pending,
            "ok" => Self::Ok,
            "error" => Self::Error,
            _ => Self::Unknown,
        }
    }

    /// `allFailed()`: agregado falho OU que ainda pendeu no prazo — ambos
    /// impedem o Node de limpar selo/reserva (`clearInstantSnapshots`).
    pub fn failed(self) -> bool {
        matches!(self, Self::Error | Self::Pending)
    }

    /// Prioridade na fusão (a ordem de ramos de `mergeLiveIndexerStates`).
    fn rank(self) -> u8 {
        match self {
            Self::Unknown => 0,
            Self::Ok => 1,
            Self::Pending => 2,
            Self::Error => 3,
        }
    }
}

/// Snapshot vivo por indexer de UMA coleta (porte do contrato do Node).
///
/// Chaves já normalizadas (o Node guarda `String(id).toLowerCase()`); ordem
/// estável para snapshot/log/teste.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LiveBatchState {
    /// Responderam FALHA (o motivo não atravessa o fio).
    pub failed: BTreeSet<String>,
    /// Consultas vivas no prazo — contam como indisponíveis no Node
    /// (`failedIndexers()` inclui `pending`).
    pub pending: BTreeSet<String>,
    /// Responderam válido SEM item relevante (candidato a vazio suspeito).
    pub empty: BTreeSet<String>,
    /// Estado do ramo agregado `/all`.
    pub all: LiveAllState,
}

/// Chave de indexer como o Node normaliza (`trim().toLowerCase()`).
fn key(id: &str) -> String {
    id.trim().to_lowercase()
}

impl LiveBatchState {
    /// Estado sintético de falha estrutural SEM indexer conhecido: erro de
    /// tarefa/coletor que não chegou a devolver contrato vivo.
    ///
    /// Não inventa nomes (`failed`/`pending`/`empty` vazios), mas o agregado
    /// `error` impede que a ausência de estado vire "respondeu": quem consome
    /// (`merge_fast_with_live`) preserva 📦/selos nessa situação. A fusão por
    /// união mantém qualquer falha já registrada por outro lote.
    pub fn unknown_failure() -> Self {
        LiveBatchState {
            all: LiveAllState::Error,
            ..Self::default()
        }
    }

    /// Parse do `live` da rota interna. Chave vazia/branca é descartada, como
    /// o `noteStart`/`noteResult` do TS.
    pub fn from_wire(snapshot: &LiveSnapshot) -> Self {
        let set = |list: &[String]| -> BTreeSet<String> {
            list.iter()
                .map(|id| key(id))
                .filter(|k| !k.is_empty())
                .collect()
        };
        LiveBatchState {
            failed: set(&snapshot.failed),
            pending: set(&snapshot.pending),
            empty: set(&snapshot.empty),
            all: LiveAllState::from_wire(&snapshot.all),
        }
    }

    /// `failedIndexers()`: falhos + pendentes (pendente conta como falho).
    pub fn failed_indexers(&self) -> BTreeSet<String> {
        let mut out = self.failed.clone();
        out.extend(self.pending.iter().cloned());
        out
    }

    /// `suspectIndexers()`: `empty − failed − pending` — só é suspeito quem
    /// não falhou nem está pendente (régua lida do TS, não inferida).
    pub fn suspect_indexers(&self) -> BTreeSet<String> {
        let indisponivel = self.failed_indexers();
        self.empty
            .iter()
            .filter(|id| !indisponivel.contains(*id))
            .cloned()
            .collect()
    }

    /// `hasAnyFailure()`: falha PROVADA (por indexer ou agregada). Vazio
    /// suspeito não conta.
    pub fn has_any_failure(&self) -> bool {
        !self.failed_indexers().is_empty() || self.all.failed()
    }

    /// `needsFallback()`: falha provada OU vazio suspeito — o banco deve ser
    /// consultado/mantido. Mesma forma do `LiveState` de `adom_core::search_finish`,
    /// para o `late` consumir quando a fatia chegar.
    pub fn needs_fallback(&self) -> bool {
        self.has_any_failure() || !self.suspect_indexers().is_empty()
    }

    /// Indexers que esta coleta NÃO provou que responderam: falho, pendente ou
    /// vazio suspeito. É o conjunto que mantém 📦/selo — quem está fora deles
    /// entregou serviço (e a reserva é superada pelo vivo), como no Node.
    pub fn unproven(&self) -> BTreeSet<String> {
        let mut out = self.failed_indexers();
        out.extend(self.suspect_indexers());
        out
    }

    /// Fusão conservadora de coletas da mesma obra (`mergeLiveIndexerStates`):
    /// união dos conjuntos — sucesso de um lote NUNCA apaga falha de outro — e
    /// `all` vence por prioridade.
    pub fn merge(&mut self, other: &LiveBatchState) {
        self.failed.extend(other.failed.iter().cloned());
        self.pending.extend(other.pending.iter().cloned());
        self.empty.extend(other.empty.iter().cloned());
        if other.all.rank() > self.all.rank() {
            self.all = other.all;
        }
    }
}

/// Funde VÁRIOS estados (vários lotes/coletores). `None` não contribui:
/// ausência de contrato vivo nunca vira prova de sucesso nem de falha.
pub fn merge_states(
    states: impl IntoIterator<Item = Option<LiveBatchState>>,
) -> Option<LiveBatchState> {
    let mut out: Option<LiveBatchState> = None;
    for state in states.into_iter().flatten() {
        match &mut out {
            Some(acc) => acc.merge(&state),
            None => out = Some(state),
        }
    }
    out
}

/// Estado vivo COMPARTILHADO entre a janela e o completion: lotes que chegam
/// depois da resposta continuam o atualizando; o tail lê o estado FINAL.
pub type SharedLiveState = Arc<Mutex<Option<LiveBatchState>>>;

/// Compartilhamento vazio.
pub fn shared_live_state() -> SharedLiveState {
    Arc::new(Mutex::new(None))
}

/// Acumula o estado de UM lote no compartilhado. Chamado pela task de coleta
/// assim que o lote assenta — inclusive depois de a resposta sair, para o
/// tail ler o estado FINAL.
pub fn merge_into_shared(shared: &SharedLiveState, state: &LiveBatchState) {
    let mut guard = shared.lock().expect("estado vivo da coleta");
    match guard.as_mut() {
        Some(acc) => acc.merge(state),
        None => *guard = Some(state.clone()),
    }
}

/// Cópia do estado acumulado (chamar APÓS o completion assentar: as tasks que
/// o alimentam terminam antes do `JoinHandle` devolver).
pub fn live_state_snapshot(shared: &SharedLiveState) -> Option<LiveBatchState> {
    shared.lock().expect("estado vivo da coleta").clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::internal_types::LiveSnapshot;

    fn snapshot(failed: &[&str], pending: &[&str], empty: &[&str], all: &str) -> LiveSnapshot {
        LiveSnapshot {
            failed: failed.iter().map(|s| s.to_string()).collect(),
            pending: pending.iter().map(|s| s.to_string()).collect(),
            empty: empty.iter().map(|s| s.to_string()).collect(),
            all: all.to_string(),
        }
    }

    #[test]
    fn from_wire_normaliza_e_descarta_chave_vazia() {
        let state =
            LiveBatchState::from_wire(&snapshot(&["BLUDV", "  "], &["MiCo"], &["HDR "], "error"));
        assert!(state.failed.contains("bludv"));
        assert!(state.pending.contains("mico"));
        assert!(state.empty.contains("hdr"));
        assert_eq!(state.failed.len(), 1, "chave branca descartada");
        assert_eq!(state.all, LiveAllState::Error);
    }

    #[test]
    fn all_desconhecido_ou_lixo_vira_unknown_e_nao_falha() {
        for texto in ["", "unknown", "ok-ish"] {
            let state = LiveBatchState::from_wire(&snapshot(&[], &[], &[], texto));
            assert_eq!(state.all, LiveAllState::Unknown);
            assert!(!state.all.failed());
            assert!(!state.has_any_failure());
        }
    }

    #[test]
    fn pending_conta_como_indisponivel_e_agregado_pending_e_all_failed() {
        let state = LiveBatchState::from_wire(&snapshot(&["bludv"], &["jackett"], &[], "pending"));
        let falhos = state.failed_indexers();
        assert!(falhos.contains("bludv") && falhos.contains("jackett"));
        assert!(state.all.failed(), "agregado pendente é allFailed no Node");
        assert!(state.has_any_failure());
    }

    #[test]
    fn suspeito_e_apenas_o_empty_sem_falha_nem_pending() {
        // `bludv` falhou e `jackett` pende: o `empty` deles NÃO é suspeita.
        let state = LiveBatchState::from_wire(&snapshot(
            &["bludv"],
            &["jackett"],
            &["bludv", "jackett", "hdr", "tdf"],
            "ok",
        ));
        let suspeitos = state.suspect_indexers();
        assert_eq!(
            suspeitos,
            BTreeSet::from(["hdr".to_string(), "tdf".to_string()])
        );
        assert!(
            state.has_any_failure(),
            "falha e pending são prova, não suspeita"
        );

        // Só vazio: exige banco (`needsFallback`), mas NÃO é falha provada.
        let so_vazio = LiveBatchState::from_wire(&snapshot(&[], &[], &["hdr"], "ok"));
        assert_eq!(
            so_vazio.suspect_indexers(),
            BTreeSet::from(["hdr".to_string()])
        );
        assert!(
            !so_vazio.has_any_failure(),
            "vazio suspeito não é falha provada"
        );
        assert!(so_vazio.needs_fallback(), "mas exige banco no Node");
    }

    #[test]
    fn nao_comprovado_uni_falho_pendente_suspeito() {
        let state = LiveBatchState::from_wire(&snapshot(&["bludv"], &["jackett"], &["hdr"], "ok"));
        let nao_provado = state.unproven();
        assert_eq!(
            nao_provado,
            BTreeSet::from([
                "bludv".to_string(),
                "jackett".to_string(),
                "hdr".to_string()
            ])
        );
    }

    #[test]
    fn fusao_sucesso_de_outro_lote_nao_apaga_falha() {
        let mut estado = LiveBatchState::from_wire(&snapshot(&["jackett"], &[], &[], "ok"));
        let sucesso = LiveBatchState::from_wire(&snapshot(&[], &[], &["jackett"], "ok"));
        estado.merge(&sucesso);
        assert!(estado.failed.contains("jackett"), "falha isolada sobrevive");
        assert!(!estado.suspect_indexers().contains("jackett"));
        assert_eq!(estado.all, LiveAllState::Ok);
    }

    #[test]
    fn fusao_all_por_prioridade_error_pending_ok_unknown() {
        let base = LiveBatchState::from_wire(&snapshot(&[], &[], &[], "ok"));
        // error vence ok…
        let mut com_erro = base.clone();
        com_erro.merge(&LiveBatchState::from_wire(&snapshot(
            &[],
            &[],
            &[],
            "error",
        )));
        assert_eq!(com_erro.all, LiveAllState::Error);
        // pending vence ok…
        let mut com_pending = base.clone();
        com_pending.merge(&LiveBatchState::from_wire(&snapshot(
            &[],
            &[],
            &[],
            "pending",
        )));
        assert_eq!(com_pending.all, LiveAllState::Pending);
        // ok vence unknown; unknown não rebaixa.
        let mut de_unknown = LiveBatchState::default();
        de_unknown.merge(&base);
        assert_eq!(de_unknown.all, LiveAllState::Ok);
        let mut com_unknown = base.clone();
        com_unknown.merge(&LiveBatchState::default());
        assert_eq!(com_unknown.all, LiveAllState::Ok);
    }

    #[test]
    fn fusao_de_varios_com_none_nao_inventa_nem_apaga_estado() {
        let a = LiveBatchState::from_wire(&snapshot(&["jackett"], &[], &[], "ok"));
        let b = LiveBatchState::from_wire(&snapshot(&[], &["bludv"], &[], "pending"));
        let fundido = merge_states([None, Some(a), None, Some(b)]).expect("há estados");
        assert!(fundido.failed.contains("jackett"));
        assert!(fundido.pending.contains("bludv"));
        assert_eq!(fundido.all, LiveAllState::Pending);
        assert!(
            merge_states([None, None]).is_none(),
            "sem estado algum = None"
        );
    }

    #[test]
    fn falha_desconhecida_preserva_conjuntos_e_vira_agregado_error() {
        let mut estado =
            LiveBatchState::from_wire(&snapshot(&["bludv"], &["mico"], &["hdr"], "ok"));
        estado.merge(&LiveBatchState::unknown_failure());
        assert!(estado.failed.contains("bludv"), "falha registrada não some");
        assert!(estado.pending.contains("mico"));
        assert!(estado.suspect_indexers().contains("hdr"));
        assert_eq!(estado.all, LiveAllState::Error);
        assert!(estado.has_any_failure());
        assert!(LiveBatchState::unknown_failure().failed.is_empty());
    }

    #[test]
    fn compartilhado_acumula_e_snapshot_copia() {
        let shared = shared_live_state();
        assert!(live_state_snapshot(&shared).is_none());
        let early = LiveBatchState::from_wire(&snapshot(&["bludv"], &[], &[], "ok"));
        merge_into_shared(&shared, &early);
        let copia = live_state_snapshot(&shared).expect("estado");
        assert!(copia.failed.contains("bludv"));

        // Lote tardio (depois da resposta) soma ao estado que o tail lê.
        let late = LiveBatchState::from_wire(&snapshot(&[], &["jackett"], &["hdr"], "ok"));
        merge_into_shared(&shared, &late);
        let final_state = live_state_snapshot(&shared).expect("estado final");
        assert!(
            final_state.failed.contains("bludv"),
            "falha precoce sobrevive"
        );
        assert!(final_state.pending.contains("jackett"));
        assert!(final_state.suspect_indexers().contains("hdr"));
        assert_eq!(final_state.all, LiveAllState::Ok);
    }
}
