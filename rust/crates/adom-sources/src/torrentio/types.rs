//! Tipos públicos do cliente Torrentio — alinhados a `src/providers/torrentio.ts`.

use serde::{Deserialize, Serialize};

/// Argumentos de busca (filme por IMDb; série por IMDb + S/E).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TorrentioSearchArgs {
    pub media_type: TorrentioMediaType,
    pub imdb_id: String,
    pub season: Option<i32>,
    pub episode: Option<i32>,
}

/// Tipo de obra na rota `/stream/{movie|series}/…`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TorrentioMediaType {
    Movie,
    Series,
}

impl TorrentioMediaType {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "movie" => Some(Self::Movie),
            "series" => Some(Self::Series),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }
}

/// Desfecho de UMA consulta ao pool (F2.3).
///
/// O coletor nativo precisa distinguir resposta VÁLIDA (mesmo vazia) de fonte
/// que não respondeu para montar o `live` sem inventar sucesso — e, como o
/// Node, NÃO pode tratar 4xx (salvo 429) como host fora. O `search()` antigo
/// continua fail-open devolvendo `Vec`; este tipo é o caminho detalhado.
#[derive(Debug, Clone, PartialEq)]
pub enum TorrentioOutcome {
    /// Resposta 2xx com JSON (pode vir sem `streams`, como no `data?.streams`).
    Ok(Vec<TorrentioRawItem>),
    /// `TORRENTIO_ENABLED=false`: o Node nem monta a tarefa; nada foi prometido.
    Disabled,
    /// Base barrada pela guarda SSRF: configuração inválida, não consulta.
    BlockedUrl,
    /// Args incompletos (filme sem IMDb / série sem S/E): sem rede, como o TS.
    NoEndpoint,
    /// Circuito local aberto (falhas seguidas recentes): a consulta foi
    /// PULADA pela política do breaker, sem rede.
    BreakerOpen,
    /// HTTP não-2xx. `429`/`5xx` alimentam o breaker; os demais 4xx pertencem à
    /// obra e o Node não os conta como falha do host.
    Http(u16),
    /// Corpo 2xx que não é JSON.
    InvalidJson,
    /// Falha de transporte (DNS/conexão/TLS).
    Network(String),
    /// Prazo da consulta vencido.
    Timeout,
}

impl TorrentioOutcome {
    /// Itens quando a resposta foi válida; qualquer outro desfecho é `[]`
    /// (fail-open — uma fonte fora nunca derruba a busca).
    pub fn into_items(self) -> Vec<TorrentioRawItem> {
        match self {
            Self::Ok(items) => items,
            _ => Vec::new(),
        }
    }

    /// Rótulo curto para log.
    pub fn label(&self) -> String {
        match self {
            Self::Ok(items) => format!("ok({})", items.len()),
            Self::Disabled => "disabled".to_string(),
            Self::BlockedUrl => "blocked-url".to_string(),
            Self::NoEndpoint => "no-endpoint".to_string(),
            Self::BreakerOpen => "breaker-open".to_string(),
            Self::Http(status) => format!("http-{status}"),
            Self::InvalidJson => "invalid-json".to_string(),
            Self::Network(_) => "network".to_string(),
            Self::Timeout => "timeout".to_string(),
        }
    }

    /// `true` quando a consulta foi TENTADA e o host não respondeu — é o que o
    /// Node trata como falha (429/5xx/rede/timeout/JSON inválido) e o que
    /// alimenta o breaker no caminho vivo.
    pub fn is_host_failure(&self) -> bool {
        match self {
            Self::Http(status) => *status == 429 || *status >= 500,
            Self::InvalidJson | Self::Network(_) | Self::Timeout => true,
            _ => false,
        }
    }
}

/// Item cru do pool público Torrentio.
///
/// `file_idx` atravessa o pipeline como no TS (preservado; não consumido no
/// play/HMAC nesta fase). `indexer` é sempre `"torrentio"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentioRawItem {
    pub title: String,
    /// Hash 40-hex em minúsculas.
    pub info_hash: String,
    pub seeders: f64,
    /// Bytes quando a linha de metadados informa tamanho > 0.
    pub size: Option<f64>,
    /// Rótulo depois do ⚙️ na linha de metadados.
    pub tracker: Option<String>,
    /// Sempre `"torrentio"` — identifica o agregador, não o tracker interno.
    pub indexer: String,
    /// `fileIdx` truncado se finito; ausente se NaN/null.
    pub file_idx: Option<i64>,
}
