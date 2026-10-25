//! Fila, lease do hash em voo e marker do Chupim.
//!
//! Tudo sobre o `NativeKv` (`cache.db`), com o relógio entrando por parâmetro —
//! o crate não chama `SystemTime`, o que mantém os testes determinísticos.
//!
//! # Regras que não variam (T3-L4)
//!
//! - O `hold` é gravado ANTES da checagem de cache (quem chama respeita a ordem;
//!   aqui a gravação é durável, não um `Map` de processo como no Node).
//! - O `marker` só é gravado no aceite (`release(..., accepted = true)`).
//! - `suppressed` e `terminal` são checados ANTES da fila.
//!
//! # Dono único
//!
//! Leitura-modificação-escrita da fila é `get_json` + `put_json` sem CAS: o
//! `NativeKv` não tem transação. Um escritor por vez é premissa do desenho (a
//! thread do worker na T3-L5); duas instâncias concorrentes podem perder um
//! item, como já acontecia com o `cache.set` do Node.

use std::sync::atomic::{AtomicU64, Ordering};

use adom_store::kv::NativeKv;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::{
    hold_key, marker_key, obra_key, queue_key, Episode, MarkerRecord, ObraRecord, QueueEntry,
    HOLD_LEASE_MS, HOLD_TTL_SECONDS, MARKER_TTL_SECONDS, OBRA_TTL_SECONDS, QUEUE_TTL_SECONDS,
};
use crate::{suppressed, terminal};

/// Resultado do `enqueue`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnqueueOutcome {
    Enqueued,
    /// Já está na fila, ou a obra+episódio está terminal dentro do TTL.
    Duplicate,
    /// A obra+episódio desistiu (`suppressed`): não entra na fila.
    Suppressed,
}

/// Fonte do marker gravado pelo aceite do próprio Chupim.
pub const SOURCE_AUTOFETCH: &str = "autofetch";

/// Identificador da rodada do lease. Nasce de `now_ms` + contador, então duas
/// instâncias (ou dois boots) nunca produzem o mesmo `run` para o mesmo hash.
static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

/// Lease de um hash em voo: quem segura o hash pode checar cache e enfileirar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hold {
    pub imdb_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    pub hash: String,
    pub lease_until_ms: i64,
    pub run: String,
}

impl Hold {
    /// Lease que começa em `now_ms` e vale `lease_ms`.
    pub fn new(imdb_id: &str, ep: Option<Episode>, hash: &str, now_ms: i64, lease_ms: i64) -> Self {
        Self {
            imdb_id: imdb_id.to_string(),
            season: ep.map(|(season, _)| season),
            episode: ep.map(|(_, episode)| episode),
            hash: hash.to_lowercase(),
            lease_until_ms: now_ms.saturating_add(lease_ms),
            run: next_run(now_ms),
        }
    }

    pub fn episode_key(&self) -> Option<Episode> {
        match (self.season, self.episode) {
            (Some(season), Some(episode)) => Some((season, episode)),
            _ => None,
        }
    }

    pub fn identity(&self) -> String {
        crate::state::identity(&self.imdb_id, self.episode_key())
    }

    pub fn expired(&self, now_ms: i64) -> bool {
        now_ms >= self.lease_until_ms
    }

    fn to_value(&self) -> Result<Value, String> {
        serde_json::to_value(self).map_err(|err| err.to_string())
    }

    fn from_value(value: Value) -> Result<Self, String> {
        serde_json::from_value(value).map_err(|err| format!("hold ilegível: {err}"))
    }
}

fn next_run(now_ms: i64) -> String {
    format!("{now_ms}-{}", RUN_SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Estado durável do Chupim: fila única, lease por hash e marker de aceite.
pub struct AutofetchQueue {
    kv: NativeKv,
}

impl AutofetchQueue {
    pub fn new(kv: NativeKv) -> Self {
        Self { kv }
    }

    // -----------------------------------------------------------------------
    // Fila
    // -----------------------------------------------------------------------

    /// Enfileira uma obra+episódio. Dedupe, terminal e suppressed são barreiras
    /// ANTES da fila, nesta ordem.
    pub fn enqueue(
        &self,
        imdb_id: &str,
        ep: Option<Episode>,
        now_ms: i64,
    ) -> Result<EnqueueOutcome, String> {
        if imdb_id.is_empty() {
            return Err("enqueue sem obra".into());
        }
        if suppressed::is_suppressed(&self.kv, imdb_id, ep, now_ms)? {
            return Ok(EnqueueOutcome::Suppressed);
        }
        if terminal::terminal_for(&self.kv, imdb_id, ep, now_ms)?.is_some() {
            return Ok(EnqueueOutcome::Duplicate);
        }
        let mut entries = self.entries(now_ms)?;
        if entries.iter().any(|entry| entry.matches(imdb_id, ep)) {
            return Ok(EnqueueOutcome::Duplicate);
        }
        entries.push(QueueEntry::new(imdb_id, ep, now_ms));
        self.write_entries(&entries, now_ms)?;
        self.touch_obra(imdb_id, now_ms)?;
        Ok(EnqueueOutcome::Enqueued)
    }

    /// Fila viva, na ordem de entrada.
    pub fn entries(&self, now_ms: i64) -> Result<Vec<QueueEntry>, String> {
        let Some(value) = self.kv.get_json(&queue_key(), now_ms)? else {
            return Ok(Vec::new());
        };
        serde_json::from_value(value).map_err(|err| format!("fila ilegível: {err}"))
    }

    pub fn len(&self, now_ms: i64) -> Result<usize, String> {
        Ok(self.entries(now_ms)?.len())
    }

    pub fn is_empty(&self, now_ms: i64) -> Result<bool, String> {
        Ok(self.len(now_ms)? == 0)
    }

    /// Tira o primeiro item da fila (o dreno da T3-L6 consome por aqui).
    pub fn take(&self, now_ms: i64) -> Result<Option<QueueEntry>, String> {
        let mut entries = self.entries(now_ms)?;
        if entries.is_empty() {
            return Ok(None);
        }
        let head = entries.remove(0);
        self.write_entries(&entries, now_ms)?;
        Ok(Some(head))
    }

    fn write_entries(&self, entries: &[QueueEntry], now_ms: i64) -> Result<(), String> {
        if entries.is_empty() {
            self.kv.forget(&queue_key())?;
            return Ok(());
        }
        let value = serde_json::to_value(entries).map_err(|err| err.to_string())?;
        self.kv
            .put_json(&queue_key(), &value, QUEUE_TTL_SECONDS, now_ms)
    }

    /// Registro de obra (contadores e espelho do terminal). Ausente = zerado.
    pub fn obra(&self, imdb_id: &str, now_ms: i64) -> Result<ObraRecord, String> {
        let Some(value) = self.kv.get_json(&obra_key(imdb_id), now_ms)? else {
            return Ok(ObraRecord::default());
        };
        serde_json::from_value(value).map_err(|err| format!("obra ilegível: {err}"))
    }

    /// Registro de obra: quantas vezes entrou na fila e quando foi a última.
    fn touch_obra(&self, imdb_id: &str, now_ms: i64) -> Result<(), String> {
        let key = obra_key(imdb_id);
        let mut record = match self.kv.get_json(&key, now_ms)? {
            Some(value) => serde_json::from_value::<ObraRecord>(value)
                .map_err(|err| format!("obra ilegível: {err}"))?,
            None => ObraRecord::default(),
        };
        record.queued += 1;
        record.last_at = now_ms;
        let value = serde_json::to_value(&record).map_err(|err| err.to_string())?;
        self.kv.put_json(&key, &value, OBRA_TTL_SECONDS, now_ms)
    }

    // -----------------------------------------------------------------------
    // Lease do hash em voo
    // -----------------------------------------------------------------------

    /// Grava o lease e o devolve. Chamar ANTES da checagem de cache.
    pub fn hold(
        &self,
        imdb_id: &str,
        ep: Option<Episode>,
        hash: &str,
        now_ms: i64,
    ) -> Result<Hold, String> {
        if hash.is_empty() {
            return Err("hold sem hash".into());
        }
        let hold = Hold::new(imdb_id, ep, hash, now_ms, HOLD_LEASE_MS);
        self.put_hold(&hold)?;
        Ok(hold)
    }

    /// Grava (ou reescreve) um lease já montado — restauração e teste.
    pub fn put_hold(&self, hold: &Hold) -> Result<(), String> {
        if hold.imdb_id.is_empty() || hold.hash.is_empty() {
            return Err("hold sem obra ou hash".into());
        }
        self.kv.put_json(
            &hold_key(&hold.imdb_id, &hold.hash),
            &hold.to_value()?,
            HOLD_TTL_SECONDS,
            hold.lease_until_ms,
        )
    }

    /// O lease ainda vale E continua sendo desta rodada (`run`).
    pub fn is_held(&self, hold: &Hold, now_ms: i64) -> Result<bool, String> {
        if hold.expired(now_ms) {
            return Ok(false);
        }
        let key = hold_key(&hold.imdb_id, &hold.hash);
        let Some(value) = self.kv.get_json(&key, now_ms)? else {
            return Ok(false);
        };
        let stored = Hold::from_value(value)?;
        Ok(stored.run == hold.run && !stored.expired(now_ms))
    }

    /// Solta o lease. `accepted = true` grava o marker (só o aceite marca).
    /// Devolve `false` quando o lease já era de outra rodada — o marker não sai.
    pub fn release(&self, hold: &Hold, accepted: bool, now_ms: i64) -> Result<bool, String> {
        let key = hold_key(&hold.imdb_id, &hold.hash);
        let mut released = false;
        if let Some(value) = self.kv.get_json(&key, now_ms)? {
            let stored = Hold::from_value(value)?;
            if stored.run == hold.run {
                released = self.kv.forget(&key)?;
            }
        }
        if released && accepted {
            self.mark(&hold.hash, SOURCE_AUTOFETCH, now_ms)?;
        }
        Ok(released)
    }

    // -----------------------------------------------------------------------
    // Marker
    // -----------------------------------------------------------------------

    /// Marker do hash (aceite registrado), dentro do TTL.
    pub fn marker(&self, hash: &str, now_ms: i64) -> Result<Option<MarkerRecord>, String> {
        if hash.is_empty() {
            return Ok(None);
        }
        let Some(value) = self.kv.get_json(&marker_key(hash), now_ms)? else {
            return Ok(None);
        };
        serde_json::from_value(value)
            .map(Some)
            .map_err(|err| format!("marker ilegível: {err}"))
    }

    fn mark(&self, hash: &str, source: &str, now_ms: i64) -> Result<(), String> {
        let record = MarkerRecord {
            at: now_ms,
            source: source.to_string(),
        };
        let value = serde_json::to_value(&record).map_err(|err| err.to_string())?;
        self.kv
            .put_json(&marker_key(hash), &value, MARKER_TTL_SECONDS, now_ms)
    }

    // -----------------------------------------------------------------------
    // Delegados: suppressed e terminal
    // -----------------------------------------------------------------------

    pub fn suppress(
        &self,
        imdb_id: &str,
        ep: Option<Episode>,
        reason: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        suppressed::suppress(&self.kv, imdb_id, ep, reason, now_ms)
    }

    pub fn unsuppress(&self, imdb_id: &str, ep: Option<Episode>) -> Result<bool, String> {
        suppressed::unsuppress(&self.kv, imdb_id, ep)
    }

    /// Identidades suprimidas vivas (`tt7` / `tt7:1:2`).
    pub fn suppressed_keys(&self, now_ms: i64) -> Result<Vec<String>, String> {
        suppressed::identities(&self.kv, now_ms)
    }

    pub fn terminate(
        &self,
        imdb_id: &str,
        ep: Option<Episode>,
        reason: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        terminal::terminate(&self.kv, imdb_id, ep, reason, now_ms)
    }

    pub fn terminal_for(
        &self,
        imdb_id: &str,
        ep: Option<Episode>,
        now_ms: i64,
    ) -> Result<Option<crate::state::TerminalRecord>, String> {
        terminal::terminal_for(&self.kv, imdb_id, ep, now_ms)
    }
}
