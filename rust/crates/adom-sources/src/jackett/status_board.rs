//! Última amostra POR indexer das buscas vivas — o que o painel mostra.
//!
//! Antes da Fase 5 o `jackett.ts` do Node chamava `indexerStatus.record` a
//! cada consulta; com a busca no gateway ninguém mais gravava e o painel
//! passou a mostrar todos os indexadores "desconhecido". O placar fica aqui,
//! no processo, porque o coletor do orquestrador é um `Arc<dyn Collector>`
//! opaco: o ponto que vê cada desfecho é o mesmo que alimenta o breaker
//! (`client_outcomes.rs`). Quem lê é a admin do gateway (`GET /indexers/status`)
//! e o Node traduz para o `indexer-status.ts` (estado, TTL, alerta BR).
//!
//! Só entra o que o breaker também contaria: `record_status:true` e consulta
//! real (o colhedor e as varreduras inline/tardias não pintam o card, como no
//! TS). Breaker aberto não gera amostra (não houve consulta), mas atualiza a
//! foto do circuito.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use super::breaker::BreakerSnapshot;

/// Foto do circuito no instante da gravação.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakerView {
    pub tripped: bool,
    pub state: &'static str,
    pub fail_streak: u32,
    pub cooldown_remaining_ms: u64,
}

/// Última consulta medida de um indexer (o `StateSample` do TS + `at`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerSample {
    pub id: String,
    pub ok: bool,
    pub ms: u64,
    pub results: usize,
    pub budget_ms: u64,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardEntry {
    pub id: String,
    pub sample: Option<IndexerSample>,
    pub breaker: Option<BreakerView>,
    /// Quando a foto do circuito foi tirada (o cooldown é descontado na leitura).
    #[serde(skip)]
    breaker_at: i64,
}

fn board() -> &'static Mutex<BTreeMap<String, BoardEntry>> {
    static BOARD: OnceLock<Mutex<BTreeMap<String, BoardEntry>>> = OnceLock::new();
    BOARD.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn entry<'a>(map: &'a mut BTreeMap<String, BoardEntry>, id: &str) -> &'a mut BoardEntry {
    map.entry(id.to_string()).or_insert_with(|| BoardEntry {
        id: id.to_string(),
        sample: None,
        breaker: None,
        breaker_at: 0,
    })
}

/// Grava a amostra de uma consulta real (e a foto do circuito depois dela).
pub fn record_sample(sample: IndexerSample, breaker: &BreakerSnapshot) {
    let mut map = board().lock().unwrap_or_else(|e| e.into_inner());
    let at = sample.at;
    let slot = entry(&mut map, &sample.id.clone());
    slot.sample = Some(sample);
    slot.breaker = Some(view(breaker));
    slot.breaker_at = at;
}

/// Breaker aberto: sem consulta, sem amostra — só a foto do circuito.
pub fn note_breaker(indexer: &str, breaker: &BreakerSnapshot, now_ms: i64) {
    let mut map = board().lock().unwrap_or_else(|e| e.into_inner());
    let slot = entry(&mut map, indexer);
    slot.breaker = Some(view(breaker));
    slot.breaker_at = now_ms;
}

fn view(snap: &BreakerSnapshot) -> BreakerView {
    BreakerView {
        tripped: snap.tripped,
        state: snap.state,
        fail_streak: snap.fail_streak,
        cooldown_remaining_ms: snap.cooldown_remaining_ms,
    }
}

/// Placar inteiro; o cooldown restante é descontado até `now_ms` e o circuito
/// que esfriou volta a "fechado".
pub fn snapshot(now_ms: i64) -> Vec<BoardEntry> {
    let map = board().lock().unwrap_or_else(|e| e.into_inner());
    map.values()
        .map(|entry| {
            let mut out = entry.clone();
            if let Some(b) = out.breaker.as_mut() {
                let elapsed = u64::try_from(now_ms.saturating_sub(entry.breaker_at)).unwrap_or(0);
                b.cooldown_remaining_ms = b.cooldown_remaining_ms.saturating_sub(elapsed);
                if b.tripped && b.cooldown_remaining_ms == 0 {
                    b.tripped = false;
                    b.state = "fechado";
                }
            }
            out
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn clear_for_tests() {
    board().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(tripped: bool, remaining: u64) -> BreakerSnapshot {
        BreakerSnapshot {
            enabled: true,
            tripped,
            state: if tripped { "aberto" } else { "fechado" },
            fail_streak: if tripped { 3 } else { 0 },
            failures_required: 3,
            cooldown_ms: 300_000,
            cooldown_remaining_ms: remaining,
        }
    }

    // Um teste só: o placar é global do processo e testes paralelos se pisariam.
    #[test]
    fn grava_amostra_e_desconta_o_cooldown_na_leitura() {
        clear_for_tests();
        let sample = IndexerSample {
            id: "eztv".into(),
            ok: true,
            ms: 420,
            results: 12,
            budget_ms: 8_000,
            at: 1_000,
        };
        record_sample(sample, &snap(false, 0));
        note_breaker("bludv-cardigann", &snap(true, 60_000), 1_000);

        let rows = snapshot(31_000);
        let eztv = rows.iter().find(|r| r.id == "eztv").expect("eztv");
        assert_eq!(eztv.sample.as_ref().map(|s| s.ms), Some(420));
        let bludv = rows
            .iter()
            .find(|r| r.id == "bludv-cardigann")
            .expect("bludv");
        assert!(
            bludv.sample.is_none(),
            "breaker aberto não inventa consulta"
        );
        let b = bludv.breaker.as_ref().expect("circuito");
        assert!(b.tripped);
        assert_eq!(b.cooldown_remaining_ms, 30_000);

        let later = snapshot(70_000);
        let b = later
            .iter()
            .find(|r| r.id == "bludv-cardigann")
            .and_then(|r| r.breaker.clone())
            .expect("circuito");
        assert!(!b.tripped, "o circuito esfria sozinho");
        assert_eq!(b.state, "fechado");
        clear_for_tests();
    }
}
