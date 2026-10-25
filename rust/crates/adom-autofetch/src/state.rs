//! Chaves, TTLs e registros do estado do Chupim.
//!
//! Namespace `autofetch:v1` na tabela `cache` do `data/cache.db` compartilhado
//! (`NativeKv`, T2-L2). A tabela de chaves é a da T3-L4 do plano de fechamento;
//! cada registro leva a IDENTIDADE (`imdb_id` + temporada/episódio) porque a
//! chave guarda só o digest — sem ela o painel não diria QUAL obra está
//! suprimida ou terminou.
//!
//! Nada aqui faz rede nem conhece debrid: é chave, TTL e formato.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Namespace inteiro (vira `RUST_OWNED_PREFIXES` na T3-L5).
pub const NAMESPACE: &str = "autofetch:v1";

/// Fila e registro de obra: uma rodada cabe em 7 dias.
pub const QUEUE_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
pub const OBRA_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
/// Lease do hash em voo: cobre a checagem de cache mais o aceite do debrid.
pub const HOLD_LEASE_MS: i64 = 15 * 60 * 1000;
/// TTL da linha do hold, contado do FIM do lease: a linha nunca vence antes do
/// lease (senão `is_held` de um lease vivo cairia no `None` da leitura).
pub const HOLD_TTL_SECONDS: i64 = 15 * 60;
/// Memória de aceite do hash: 30 dias.
pub const MARKER_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
/// Obra que desistiu: não reenfileira por 7 dias.
pub const SUPPRESSED_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
/// Obra/episódio terminal (morto/parado): 24 h.
pub const TERMINAL_TTL_SECONDS: i64 = 24 * 60 * 60;

/// Temporada e episódio de um item da fila; `None` = filme ou pack da obra.
pub type Episode = (i64, i64);

// ---------------------------------------------------------------------------
// Chaves
// ---------------------------------------------------------------------------

/// Fila ÚNICA da obra/episódio (não é por `searchKey` como a fila do Node).
pub fn queue_key() -> String {
    format!("{NAMESPACE}:q")
}

/// Registro de obra: quantas vezes entrou na fila, tentativas e terminal.
pub fn obra_key(imdb_id: &str) -> String {
    format!("{NAMESPACE}:obra:{imdb_id}")
}

/// Lease do hash em voo, por obra+hash.
pub fn hold_key(imdb_id: &str, hash: &str) -> String {
    format!(
        "{NAMESPACE}:hold:{}",
        digest(&[imdb_id, &hash.to_lowercase()])
    )
}

/// Aceite do hash (marker): a chave é o próprio infoHash.
pub fn marker_key(hash: &str) -> String {
    format!("{NAMESPACE}:marker:{}", hash.to_lowercase())
}

/// Obra/episódio que desistiu.
pub fn suppressed_key(imdb_id: &str, ep: Option<Episode>) -> String {
    format!(
        "{NAMESPACE}:suppressed:{}",
        digest(&identity_parts(imdb_id, ep))
    )
}

/// Obra/episódio terminal.
pub fn terminal_key(imdb_id: &str, ep: Option<Episode>) -> String {
    format!(
        "{NAMESPACE}:terminal:{}",
        digest(&identity_parts(imdb_id, ep))
    )
}

/// Prefixo da varredura de holds (status do painel).
pub fn hold_prefix() -> String {
    format!("{NAMESPACE}:hold:")
}

/// Prefixo da varredura de suprimidas.
pub fn suppressed_prefix() -> String {
    format!("{NAMESPACE}:suppressed:")
}

/// Prefixo da varredura de terminais.
pub fn terminal_prefix() -> String {
    format!("{NAMESPACE}:terminal:")
}

/// Identidade legível: `tt7` para filme, `tt7:1:2` para episódio.
pub fn identity(imdb_id: &str, ep: Option<Episode>) -> String {
    match ep {
        Some((season, episode)) => format!("{imdb_id}:{season}:{episode}"),
        None => imdb_id.to_string(),
    }
}

fn identity_parts(imdb_id: &str, ep: Option<Episode>) -> Vec<String> {
    match ep {
        Some((season, episode)) => {
            vec![imdb_id.to_string(), season.to_string(), episode.to_string()]
        }
        None => vec![imdb_id.to_string()],
    }
}

/// Digest hex do SHA-256 das partes unidas por `|`.
///
/// O separador é o que impede `("tt1", 12)` de colidir com `("tt11", 2)`; o
/// plano pedia SHA-1, mas não há crate de SHA-1 no workspace e hash não se
/// escreve à mão — o papel aqui é só encurtar a chave (o valor guarda a
/// identidade inteira), não autenticar nada.
fn digest<P: AsRef<str>>(parts: &[P]) -> String {
    let mut hasher = Sha256::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            hasher.update(b"|");
        }
        hasher.update(part.as_ref().as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// Registros
// ---------------------------------------------------------------------------

/// Item da fila: uma vez por obra+episódio.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueEntry {
    pub imdb_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    pub enqueued_at: i64,
    #[serde(default)]
    pub attempts: i64,
}

impl QueueEntry {
    pub fn new(imdb_id: &str, ep: Option<Episode>, enqueued_at: i64) -> Self {
        Self {
            imdb_id: imdb_id.to_string(),
            season: ep.map(|(season, _)| season),
            episode: ep.map(|(_, episode)| episode),
            enqueued_at,
            attempts: 0,
        }
    }

    /// Mesma obra e mesmo episódio (o dedupe do `enqueue`).
    pub fn matches(&self, imdb_id: &str, ep: Option<Episode>) -> bool {
        self.imdb_id == imdb_id
            && self.season == ep.map(|(s, _)| s)
            && self.episode == ep.map(|(_, e)| e)
    }

    pub fn identity(&self) -> String {
        match (self.season, self.episode) {
            (Some(season), Some(episode)) => format!("{}:{season}:{episode}", self.imdb_id),
            _ => self.imdb_id.clone(),
        }
    }

    pub fn episode_key(&self) -> Option<Episode> {
        match (self.season, self.episode) {
            (Some(season), Some(episode)) => Some((season, episode)),
            _ => None,
        }
    }
}

/// Registro de obra (teto/diagnóstico). `terminal` é ESPELHO: quem barra o
/// reenfileiramento é a chave `terminal:<digest>`, com TTL próprio.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObraRecord {
    #[serde(default)]
    pub queued: i64,
    #[serde(default)]
    pub attempts: i64,
    #[serde(default)]
    pub last_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
}

/// Aceite do hash. `source` diz QUEM aceitou (`autofetch`, `recheck`), para o
/// recheck não confundir a própria marca com a do enfileiramento.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkerRecord {
    pub at: i64,
    pub source: String,
}

/// Obra/episódio que desistiu (não reenfileira dentro do TTL).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuppressedRecord {
    pub imdb_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    pub reason: String,
    pub at: i64,
}

/// Obra/episódio terminal (morto/parado): barra o enqueue pelo TTL da chave.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalRecord {
    pub imdb_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<i64>,
    pub reason: String,
    pub at: i64,
}

impl SuppressedRecord {
    pub fn new(imdb_id: &str, ep: Option<Episode>, reason: &str, at: i64) -> Self {
        Self {
            imdb_id: imdb_id.to_string(),
            season: ep.map(|(season, _)| season),
            episode: ep.map(|(_, episode)| episode),
            reason: reason.to_string(),
            at,
        }
    }
}

impl TerminalRecord {
    pub fn new(imdb_id: &str, ep: Option<Episode>, reason: &str, at: i64) -> Self {
        Self {
            imdb_id: imdb_id.to_string(),
            season: ep.map(|(season, _)| season),
            episode: ep.map(|(_, episode)| episode),
            reason: reason.to_string(),
            at,
        }
    }
}
