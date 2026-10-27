//! Duplos do interrogatório de áudio (T3-L7a): resolver e escritas falsos.
//! Só `cfg(test)` — nada aqui entra no binário.

use std::collections::{BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::{EpisodeEvidence, PlayHint, WorkHint};
use adom_debrid::alldebrid::PlayError;
use adom_debrid::play::PlayOutcome;
use adom_debrid::DebridError;

use crate::dub_audit::{AuditWrites, Candidate, DubAudit, DubAuditConfig};
use crate::resolve_native::{PlayFuture, PlayResolver};

pub type Reply = Result<(), DebridError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub service: String,
    pub api_key: String,
    pub hash: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub dubbed: bool,
    pub held: bool,
}

/// Resolver falso: devolve a fila de respostas na ordem e registra as chamadas.
pub struct FakeResolver {
    replies: Mutex<VecDeque<Reply>>,
    calls: Mutex<Vec<Call>>,
    delay_ms: u64,
}

impl FakeResolver {
    pub fn new(replies: Vec<Reply>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            calls: Mutex::new(Vec::new()),
            delay_ms: 0,
        }
    }

    /// Atraso para o teste de concorrência: o segundo `drain` chega em voo.
    pub fn slow(mut self) -> Self {
        self.delay_ms = 5;
        self
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

impl PlayResolver for FakeResolver {
    fn resolve<'a>(
        &'a self,
        service: &'a str,
        api_key: &'a str,
        info_hash: &'a str,
        hint: &'a PlayHint,
        held: bool,
    ) -> PlayFuture<'a> {
        Box::pin(async move {
            if self.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            }
            self.calls.lock().unwrap().push(Call {
                service: service.to_string(),
                api_key: api_key.to_string(),
                hash: info_hash.to_string(),
                season: hint.season,
                episode: hint.episode,
                dubbed: hint.dubbed,
                held,
            });
            match self.replies.lock().unwrap().pop_front().unwrap_or(Ok(())) {
                Ok(()) => Ok(PlayOutcome::default()),
                Err(error) => Err(PlayError::from(error)),
            }
        })
    }
}

/// Escritas falsas: guardam as marcas e, principalmente, a ORDEM dos efeitos.
#[derive(Default)]
pub struct FakeWrites {
    lies: Mutex<BTreeSet<(String, String, String)>>,
    missing: Mutex<BTreeSet<(String, i64, i64, String)>>,
    log: Mutex<Vec<String>>,
}

impl FakeWrites {
    pub fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    /// Conta que já provou mentira neste hash.
    pub fn with_lie(adapter: &str, account: &str, hash: &str) -> Self {
        let writes = Self::default();
        writes.lies.lock().unwrap().insert((
            adapter.to_string(),
            account.to_string(),
            hash.to_string(),
        ));
        writes
    }

    /// Episódio que já foi provado errado para este hash.
    pub fn with_missing(&self, imdb_id: &str, season: i64, episode: i64, hash: &str) {
        self.missing.lock().unwrap().insert((
            imdb_id.to_string(),
            season,
            episode,
            hash.to_string(),
        ));
    }
}

impl AuditWrites for FakeWrites {
    fn is_lie(&self, adapter: &str, api_key: &str, hash: &str) -> bool {
        self.lies.lock().unwrap().contains(&(
            adapter.to_string(),
            api_key.to_string(),
            hash.to_string(),
        ))
    }

    fn is_missing(
        &self,
        imdb_id: &str,
        season: Option<i64>,
        episode: Option<i64>,
        hash: &str,
        _now_ms: i64,
    ) -> bool {
        let (Some(season), Some(episode)) = (season, episode) else {
            return false;
        };
        self.missing.lock().unwrap().contains(&(
            imdb_id.to_string(),
            season,
            episode,
            hash.to_string(),
        ))
    }

    fn mark_lie(&self, adapter: &str, api_key: &str, hash: &str, _now_ms: i64) {
        self.lies.lock().unwrap().insert((
            adapter.to_string(),
            api_key.to_string(),
            hash.to_string(),
        ));
        self.log
            .lock()
            .unwrap()
            .push(format!("mark_lie:{adapter}:{api_key}:{hash}"));
    }

    fn mark_lied(
        &self,
        imdb_id: &str,
        season: Option<i64>,
        episode: Option<i64>,
        hash: &str,
        _now_ms: i64,
    ) {
        self.log.lock().unwrap().push(format!(
            "mark_lied:{imdb_id}:{}:{}:{hash}",
            opt(season),
            opt(episode)
        ));
    }

    fn mark_missing(
        &self,
        imdb_id: &str,
        season: i64,
        episode: i64,
        hash: &str,
        whole_season: bool,
        _now_ms: i64,
    ) {
        self.missing.lock().unwrap().insert((
            imdb_id.to_string(),
            season,
            episode,
            hash.to_string(),
        ));
        self.log.lock().unwrap().push(format!(
            "mark_missing:{imdb_id}:{season}:{episode}:{hash}:{whole_season}"
        ));
    }

    fn unprotect(&self, adapter: &str, api_key: &str, hash: &str) {
        self.log
            .lock()
            .unwrap()
            .push(format!("unprotect:{adapter}:{api_key}:{hash}"));
    }

    fn invalidate_obra(&self, imdb_id: &str) {
        self.log
            .lock()
            .unwrap()
            .push(format!("invalidate:{imdb_id}"));
    }
}

pub fn opt(value: Option<i64>) -> String {
    value.map_or_else(|| "-".to_string(), |v| v.to_string())
}

pub fn hash_of(seed: u8) -> String {
    let byte = char::from(b'a' + seed % 6);
    std::iter::repeat_n(byte, 40).collect()
}

pub fn candidate(seed: u8, season: Option<i64>, episode: Option<i64>) -> Candidate {
    Candidate {
        adapter: "alldebrid".into(),
        api_key: "chave-a".into(),
        hash: hash_of(seed),
        season,
        episode,
        imdb_id: Some("tt123".into()),
        work: None,
        dubbed: true,
        needs_promote: false,
    }
}

pub fn audit(
    replies: Vec<Reply>,
    writes: Arc<FakeWrites>,
    tail_max: usize,
    delay: bool,
) -> (Arc<FakeResolver>, Arc<DubAudit>) {
    let resolver = Arc::new(if delay {
        FakeResolver::new(replies).slow()
    } else {
        FakeResolver::new(replies)
    });
    let config = DubAuditConfig {
        enabled: true,
        tail_max,
    };
    let dub = Arc::new(DubAudit::new(config, resolver.clone(), writes));
    (resolver, dub)
}

pub fn evidence(episodes: Vec<i64>) -> Box<EpisodeEvidence> {
    Box::new(EpisodeEvidence {
        wanted_season: 1,
        wanted_episode: 4,
        declared_seasons: vec![1],
        declared_episodes: episodes,
        sample: Some("serie.S01E07.mkv".into()),
    })
}

/// Construtor de teste para o trabalho (`WorkHint` não é `Default`).
pub fn work(names: &[&str], year: Option<i64>, pack: bool) -> Option<WorkHint> {
    Some(WorkHint {
        names: names.iter().map(|name| (*name).to_string()).collect(),
        year,
        pack,
    })
}
