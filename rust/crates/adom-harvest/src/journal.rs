//! Journal de execução do drain — uma chave por run (`harvest:v1:run:<run_id>`).
//!
//! Cada run é uma obra colhida: os passos na ordem em que aconteceram e o
//! veredito final (`running` → `done`/`failed`). O colhedor grava; o painel lê a
//! lista de chaves e o estado de cada run.
//!
//! Tudo aqui é TOLERANTE a leitura ruim: linha expirada ou JSON podre conta como
//! ausente. Journal é diagnóstico — ele nunca derruba o drain, que é quem
//! alimenta o índice.

use adom_core::prefix;
use serde::{Deserialize, Serialize};

use crate::queue::HARVEST_NAMESPACE;
use crate::store::HarvestStore;

/// 24 h: o run já terminou muito antes disso; o TTL evita lista infinita.
pub const JOURNAL_TTL_SECONDS: u64 = 86_400;

/// Prefixo das chaves de run — filtro de [`HarvestStore::journal_keys`].
///
/// Equivale a `format!("{}run:", prefix(HARVEST_NAMESPACE))` (amarrado por teste).
pub const JOURNAL_PREFIX: &str = "harvest:v1:run:";

/// Chave do journal de um run (mesma forma do `prefix('harvest')` do TS).
pub fn journal_key(run_id: &str) -> String {
    format!("{}run:{run_id}", prefix(HARVEST_NAMESPACE))
}

/// Estado de um run: a obra, as pontas do relógio, o veredito e os passos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRun {
    pub obra: String,
    pub started_ms: i64,
    /// `None` enquanto o run não foi fechado.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_ms: Option<i64>,
    /// `running` | `done` | `failed` — string livre, quem decide é o chamador.
    pub status: String,
    /// Por que o run falhou (`interrupted`, `orphan`, `preempted`, …).
    /// Ausente em run fechado como `done` — é diagnóstico, não veredito.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Passos na ordem de execução, sem repetição.
    #[serde(default)]
    pub steps: Vec<String>,
}

impl HarvestStore {
    /// Abre o run. IDEMPOTENTE: um segundo `begin` (retry do drain) não apaga
    /// passos nem o `started_ms` original.
    ///
    /// Linha ilegível é substituída: senão o run ficaria travado 24 h sem estado
    /// legível, e o `begin` é justamente quem define o começo.
    pub fn journal_begin(&self, run_id: &str, obra: &str, now_ms: i64) -> Result<(), String> {
        if self.journal_get(run_id, now_ms)?.is_some() {
            return Ok(());
        }
        let run = JournalRun {
            obra: obra.to_string(),
            started_ms: now_ms,
            finished_ms: None,
            status: "running".to_string(),
            reason: None,
            steps: Vec::new(),
        };
        self.write_journal(run_id, &run, now_ms)
    }

    /// Anota um passo (sem repetir, preservando a ordem) e RENOVA o TTL.
    ///
    /// Run ausente/expirado/podre → `Ok(())` sem criar nada: journal faltando é
    /// diagnóstico perdido, nunca falha de drain.
    pub fn journal_step(&self, run_id: &str, step: &str, now_ms: i64) -> Result<(), String> {
        let Some(mut run) = self.journal_get(run_id, now_ms)? else {
            return Ok(());
        };
        if !run.steps.iter().any(|done| done == step) {
            run.steps.push(step.to_string());
        }
        self.write_journal(run_id, &run, now_ms)
    }

    /// Fecha o run com o veredito do chamador e grava `finished_ms`.
    ///
    /// Sobrescreve um fechamento anterior (o último veredito é o que vale).
    /// Run ausente → `Ok(())`.
    pub fn journal_finish(&self, run_id: &str, status: &str, now_ms: i64) -> Result<(), String> {
        let Some(mut run) = self.journal_get(run_id, now_ms)? else {
            return Ok(());
        };
        run.status = status.to_string();
        run.finished_ms = Some(now_ms);
        // O último veredito é o que vale: fechar como não-falha não pode
        // arrastar o motivo de um `journal_fail` anterior.
        run.reason = None;
        self.write_journal(run_id, &run, now_ms)
    }

    /// Fecha o run como `failed` com o motivo (replay, preempção, drain).
    ///
    /// Separado de [`Self::journal_finish`] porque o motivo é o que o replay
    /// do boot seguinte lê para distinguir `interrupted` de `orphan`.
    pub fn journal_fail(&self, run_id: &str, reason: &str, now_ms: i64) -> Result<(), String> {
        let Some(mut run) = self.journal_get(run_id, now_ms)? else {
            return Ok(());
        };
        run.status = "failed".to_string();
        run.finished_ms = Some(now_ms);
        run.reason = Some(reason.to_string());
        self.write_journal(run_id, &run, now_ms)
    }

    /// Run vivo. JSON ilegível → `Ok(None)`: linha podre não vira erro de drain.
    pub fn journal_get(&self, run_id: &str, now_ms: i64) -> Result<Option<JournalRun>, String> {
        let Some(raw) = self.get_value(&journal_key(run_id), now_ms)? else {
            return Ok(None);
        };
        Ok(serde_json::from_str(&raw).ok())
    }

    /// Chaves de run vivas, já com o prefixo (`harvest:v1:run:<id>`).
    ///
    /// O id para [`Self::journal_get`]/[`Self::journal_forget`] sai de
    /// `strip_prefix(JOURNAL_PREFIX)`.
    pub fn journal_keys(&self, now_ms: i64) -> Result<Vec<String>, String> {
        self.keys_with_prefix(JOURNAL_PREFIX, now_ms)
    }

    /// Apaga o run (limpeza do painel). Run que não existe não é erro.
    pub fn journal_forget(&self, run_id: &str) -> Result<(), String> {
        self.forget_key(&journal_key(run_id)).map(|_| ())
    }

    fn write_journal(&self, run_id: &str, run: &JournalRun, now_ms: i64) -> Result<(), String> {
        let encoded =
            serde_json::to_string(run).map_err(|err| format!("serializar journal: {err}"))?;
        self.put_value(&journal_key(run_id), &encoded, JOURNAL_TTL_SECONDS, now_ms)
    }
}

// Dono do arquivo de teste: ele cobre journal E outbox (o estado do mesmo drain).
#[cfg(test)]
#[path = "journal_tests.rs"]
mod journal_tests;
