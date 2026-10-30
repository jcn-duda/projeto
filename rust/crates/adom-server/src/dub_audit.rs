//! Interrogatório de áudio do tail — porte de `src/providers/dub-audit.ts`
//! (T3-L7a). O efeito `dub_audit` deixou de atravessar
//! `POST /internal/search/effects`: a fila, a drenagem e as ESCRITAS moram
//! aqui (as escritas em `dub_audit_writes`).
//!
//! O que NÃO mudou de lugar: a SELEÇÃO dos candidatos continua no núcleo
//! (`adom_search::list_builder::effects`, `seeds.audit`) e viaja no payload do
//! efeito. Este módulo só executa:
//!
//! - fila curta em memória (teto de 50), dedupe por hash+S+E e por conta;
//! - um `resolve` por candidato (`PlayResolver`, o mesmo do `/resolve`), com a
//!   conta QUE OFERECEU o candidato (o TS usava o ALS do momento da drenagem);
//! - mentira (`dub_lie`) vira a MESMA evidência do play: `mag.lie`, `idx.lied`
//!   e o `adprot` destravado (a release provou EN apesar da promessa PT);
//! - episódio errado COM prova (`episode_pick` + `evidence`) marca `idx.miss`
//!   (e a temporada inteira quando o arquivo não declara episódio);
//! - ambiguidade SEM prova (`episode_pick` sem `evidence`) não grava nada;
//! - qualquer outro erro (rede/credencial) também não grava: o candidato volta
//!   a ser oferecido pela próxima busca.
//!
//! A invalidação das listas é por OBRA (`streams.invalidate_for_obra`) — a
//! chave de busca do TS (`cache.forget(searchKey)`) nunca alcançou `streams`,
//! que já é RUST_OWNED.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use adom_core::{PlayHint, WorkHint};
use adom_debrid::DebridError;
use serde_json::{Map, Value};

use crate::resolve_native::PlayResolver;

/// Teto da fila em memória (`dubAuditPending.length > 50` no TS).
pub const PENDING_CAP: usize = 50;
/// `MAGNET_LIE_TTL` default (7 dias), igual ao `config.magnetDb.lieTtl`.
pub(crate) const DEFAULT_LIE_TTL: i64 = 7 * 24 * 3600;

/// Um hash a interrogar, já com a conta que o ofereceu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub adapter: String,
    /// Chave da conta: fica SÓ em memória, nunca em log.
    pub api_key: String,
    pub hash: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub imdb_id: Option<String>,
    pub work: Option<WorkHint>,
    pub dubbed: bool,
    /// Claim sem prova: o OK do resolve promove a lista (`_dubbed`).
    pub needs_promote: bool,
}

/// Escritas que o veredito dispara. Trait para o teste rodar sem disco.
pub trait AuditWrites: Send + Sync {
    fn is_lie(&self, adapter: &str, api_key: &str, hash: &str) -> bool;
    fn is_missing(
        &self,
        imdb_id: &str,
        season: Option<i64>,
        episode: Option<i64>,
        hash: &str,
        now_ms: i64,
    ) -> bool;
    fn mark_lie(&self, adapter: &str, api_key: &str, hash: &str, now_ms: i64);
    fn mark_lied(
        &self,
        imdb_id: &str,
        season: Option<i64>,
        episode: Option<i64>,
        hash: &str,
        now_ms: i64,
    );
    /// `whole_season` quando o arquivo não declara episódio (o TS chama
    /// `markMissingSeason` nesse caso).
    fn mark_missing(
        &self,
        imdb_id: &str,
        season: i64,
        episode: i64,
        hash: &str,
        whole_season: bool,
        now_ms: i64,
    );
    fn unprotect(&self, adapter: &str, api_key: &str, hash: &str);
    fn invalidate_obra(&self, imdb_id: &str);
    /// Prova de arquivo do play OK (`idx:v14:file:<hash>`). Default: não grava.
    fn mark_file_evidence(&self, _hash: &str, _ev: &adom_core::PlayFileEvidence, _now: i64) {}
}

/// Config viva do efeito (`AUDIO_AUDIT`/`DEBRID_DUB_AUDIT_MAX`).
#[derive(Debug, Clone, Copy)]
pub struct DubAuditConfig {
    pub enabled: bool,
    pub tail_max: usize,
    /// Prazo (ms) em que um candidato provado OK não volta à fila; 0 desliga.
    pub ok_ttl_ms: i64,
}

impl DubAuditConfig {
    pub fn from_env() -> Self {
        Self {
            enabled: env_on("AUDIO_AUDIT", true),
            tail_max: env_num("DEBRID_DUB_AUDIT_MAX", 2).max(0) as usize,
            ok_ttl_ms: env_num("DEBRID_DUB_AUDIT_OK_TTL_MS", 21_600_000).max(0),
        }
    }
}

pub(crate) fn env_on(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => value == "true",
        _ => default,
    }
}

pub(crate) fn env_num(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[derive(Default)]
struct State {
    pending: Vec<Candidate>,
    in_flight: bool,
}

/// Fila do interrogatório + drenagem.
pub struct DubAudit {
    state: Mutex<State>,
    config: DubAuditConfig,
    resolver: Arc<dyn PlayResolver>,
    writes: Arc<dyn AuditWrites>,
    ok_memory: proof::OkMemory,
}

impl DubAudit {
    pub fn new(
        config: DubAuditConfig,
        resolver: Arc<dyn PlayResolver>,
        writes: Arc<dyn AuditWrites>,
    ) -> Self {
        Self {
            state: Mutex::new(State::default()),
            config,
            resolver,
            writes,
            ok_memory: proof::OkMemory::default(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// Profundidade da fila (diagnóstico e teste).
    pub fn pending(&self) -> usize {
        self.lock().pending.len()
    }

    /// Enfileira candidatos. Dedupe por (conta, hash, S, E); já condenado nesta
    /// conta (`lie`) ou já provado errado para este episódio (`idx.miss`) não
    /// gasta consulta de novo.
    pub fn offer(&self, candidates: &[Candidate]) -> usize {
        if !self.config.enabled || self.config.tail_max == 0 {
            return 0;
        }
        let now = now_ms();
        let mut added = 0;
        let mut state = self.lock();
        for candidate in candidates {
            if self
                .writes
                .is_lie(&candidate.adapter, &candidate.api_key, &candidate.hash)
                || self.ok_memory.recent(candidate, now)
            {
                continue;
            }
            if let (Some(imdb), Some(season), Some(episode)) =
                (&candidate.imdb_id, candidate.season, candidate.episode)
            {
                if self
                    .writes
                    .is_missing(imdb, Some(season), Some(episode), &candidate.hash, now)
                {
                    continue;
                }
            }
            let repeat = state.pending.iter().any(|item| {
                item.adapter == candidate.adapter
                    && item.api_key == candidate.api_key
                    && item.hash == candidate.hash
                    && item.season == candidate.season
                    && item.episode == candidate.episode
            });
            if repeat {
                continue;
            }
            state.pending.push(candidate.clone());
            added += 1;
        }
        if state.pending.len() > PENDING_CAP {
            let excess = state.pending.len() - PENDING_CAP;
            state.pending.drain(..excess);
        }
        added
    }

    /// Drena até `tail_max` itens. Um drain por vez: ofertas em rajada não
    /// abrem N resolves concorrentes (o TS agendava um `setImmediate` por
    /// oferta).
    pub async fn drain(&self) -> usize {
        let batch: Vec<Candidate> = {
            let mut state = self.lock();
            if state.in_flight || state.pending.is_empty() {
                return 0;
            }
            state.in_flight = true;
            let take = self.config.tail_max.min(state.pending.len());
            state.pending.drain(..take).collect()
        };
        let mut audited = 0;
        for candidate in batch {
            self.audit(&candidate).await;
            audited += 1;
        }
        self.lock().in_flight = false;
        audited
    }

    async fn audit(&self, candidate: &Candidate) {
        let hint = PlayHint {
            season: candidate.season,
            episode: candidate.episode,
            work: candidate.work.clone(),
            dubbed: candidate.dubbed,
        };
        let outcome = self
            .resolver
            .resolve(
                &candidate.adapter,
                &candidate.api_key,
                &candidate.hash,
                &hint,
                false,
            )
            .await;
        match outcome {
            // Grava a prova e só invalida quando ela promove o claim (`proof`).
            Ok(outcome) => self.on_ok(candidate, &outcome),
            Err(err) => self.classify(candidate, &err.error),
        }
    }

    fn classify(&self, candidate: &Candidate, err: &DebridError) {
        let now = now_ms();
        let short = &candidate.hash[..candidate.hash.len().min(8)];
        match err.kind() {
            "dub_lie" => {
                self.writes
                    .mark_lie(&candidate.adapter, &candidate.api_key, &candidate.hash, now);
                self.writes
                    .unprotect(&candidate.adapter, &candidate.api_key, &candidate.hash);
                if let Some(imdb) = &candidate.imdb_id {
                    self.writes.mark_lied(
                        imdb,
                        candidate.season,
                        candidate.episode,
                        &candidate.hash,
                        now,
                    );
                    self.writes.invalidate_obra(imdb);
                }
                let group = err
                    .pick_parts()
                    .1
                    .and_then(|context| context.samples.first().cloned());
                match group {
                    Some(group) => eprintln!("[audit] tail provou mentira {short} ({group})"),
                    None => eprintln!("[audit] tail provou mentira {short}"),
                }
            }
            "episode_pick" => {
                let evidence = err.pick_parts().0;
                let Some(evidence) = evidence else {
                    // Ambiguidade: "não identifiquei" não é "é outro episódio".
                    eprintln!("[audit] tail: episódio não identificado em {short} (sem prova)");
                    return;
                };
                let (Some(imdb), Some(season), Some(episode)) =
                    (&candidate.imdb_id, candidate.season, candidate.episode)
                else {
                    return;
                };
                let whole_season = evidence.declared_episodes.is_empty();
                self.writes
                    .mark_missing(imdb, season, episode, &candidate.hash, whole_season, now);
                self.writes.invalidate_obra(imdb);
                eprintln!(
                    "[audit] tail provou episódio errado {short} (declara S{}E{})",
                    join_ids(&evidence.declared_seasons),
                    join_ids(&evidence.declared_episodes)
                );
            }
            _ => {}
        }
    }

    fn invalidate(&self, candidate: &Candidate) {
        if let Some(imdb) = &candidate.imdb_id {
            self.writes.invalidate_obra(imdb);
        }
    }
}

fn join_ids(ids: &[i64]) -> String {
    ids.iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// Payload do efeito `dub_audit` → `(adapter, api_key, candidatos)`. `None`
/// quando a forma não serve (o efeito é rejeitado, nunca vira varredura).
pub fn parse_effect(payload: &Map<String, Value>) -> Option<(String, String, Vec<Candidate>)> {
    let adapter = payload.get("adapter_id")?.as_str()?.to_string();
    let api_key = payload.get("api_key")?.as_str()?.to_string();
    if adapter.is_empty() || api_key.is_empty() {
        return None;
    }
    let raw = payload.get("candidates")?.as_array()?;
    let mut out = Vec::with_capacity(raw.len());
    for item in raw {
        let hash = item.get("hash")?.as_str()?.to_ascii_lowercase();
        if hash.len() != 40 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        out.push(Candidate {
            adapter: adapter.clone(),
            api_key: api_key.clone(),
            hash,
            season: item.get("season").and_then(Value::as_i64),
            episode: item.get("episode").and_then(Value::as_i64),
            imdb_id: item
                .get("imdbId")
                .and_then(Value::as_str)
                .map(str::to_string),
            work: parse_work(item.get("work")),
            dubbed: item.get("dubbed").and_then(Value::as_bool).unwrap_or(false),
            needs_promote: item
                .get("needsPromote")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    Some((adapter, api_key, out))
}

fn parse_work(raw: Option<&Value>) -> Option<WorkHint> {
    let value = raw?;
    if value.is_null() {
        return None;
    }
    let names: Vec<String> = value
        .get("names")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    if names.is_empty() {
        return None;
    }
    Some(WorkHint {
        names,
        year: value.get("year").and_then(Value::as_i64),
        pack: value.get("pack").and_then(Value::as_bool).unwrap_or(false),
    })
}

#[path = "dub_audit_proof.rs"]
mod proof;

#[cfg(test)]
#[path = "dub_audit_tests.rs"]
mod tests;
