//! Tipos públicos do cliente Prowlarr — alinhados ao `map` de
//! `src/providers/prowlarr.ts`.

use serde::{Deserialize, Serialize};

/// Item cru devolvido por [`crate::prowlarr::ProwlarrClient::search`].
///
/// Campos batem com o objeto que o TS monta: title, magnet, infoHash, seeders,
/// size, tracker. O `tracker` é `indexer || indexerId` do payload e é a ÚNICA
/// identidade do Prowlarr — o Node não preenche `indexer`, então o `_indexer`
/// do stream nasce do `tracker` (ver `search-names.ts:250`). Consumido por
/// `adom-search::ProwlarrCollector`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProwlarrRawItem {
    pub title: String,
    /// `magnetUrl` || `guid` || `downloadUrl`.
    pub magnet: Option<String>,
    pub info_hash: Option<String>,
    pub seeders: Option<f64>,
    pub size: Option<f64>,
    /// `indexer` || `indexerId` do payload (ex.: "yts", "9").
    pub tracker: Option<String>,
}

/// Desfecho de UMA consulta ao `/api/v1/search` (F2.2).
///
/// O collector nativo precisa distinguir resposta VÁLIDA (mesmo vazia) de
/// fonte que não respondeu para montar o `live` sem inventar sucesso: HTTP
/// 429/5xx, rede, timeout e JSON fora do contrato são falha declarada. O
/// `search()` antigo continua devolvendo só os itens (fail-open) — este tipo
/// é o caminho detalhado do coletor.
#[derive(Debug, Clone, PartialEq)]
pub enum ProwlarrOutcome {
    /// Resposta válida do Prowlarr (array; pode vir vazio).
    Ok(Vec<ProwlarrRawItem>),
    /// Sem `PROWLARR_API_KEY`: nenhuma consulta é feita (mesmo contrato do TS).
    Disabled,
    /// Base barrada pela guarda SSRF: não é consulta, é configuração inválida.
    BlockedUrl,
    /// HTTP não-2xx (`u16` para 429/5xx/4xx aparecerem no log/métrica).
    Http(u16),
    /// Corpo 2xx que não é o array do Prowlarr.
    InvalidJson,
    /// Falha de transporte (DNS/conexão/TLS). O texto já vem sem a URL.
    Network(String),
    /// Prazo da consulta vencido (timeout do cliente ou do envelope).
    Timeout,
}

impl ProwlarrOutcome {
    /// Itens quando a resposta foi válida; qualquer outro desfecho é `[]`
    /// (fail-open — uma fonte fora nunca derruba a busca).
    pub fn into_items(self) -> Vec<ProwlarrRawItem> {
        match self {
            Self::Ok(items) => items,
            _ => Vec::new(),
        }
    }

    /// Rótulo curto para log; nunca carrega a API key (a URL não entra).
    pub fn label(&self) -> String {
        match self {
            Self::Ok(items) => format!("ok({})", items.len()),
            Self::Disabled => "disabled".to_string(),
            Self::BlockedUrl => "blocked-url".to_string(),
            Self::Http(status) => format!("http-{status}"),
            Self::InvalidJson => "invalid-json".to_string(),
            Self::Network(_) => "network".to_string(),
            Self::Timeout => "timeout".to_string(),
        }
    }

    /// `true` quando a consulta foi TENTADA e não devolveu resposta válida.
    /// `Disabled`/`BlockedUrl` são configuração: a fonte nem foi consultada e
    /// não podem virar falha viva (nada foi prometido).
    pub fn is_consult_failure(&self) -> bool {
        matches!(
            self,
            Self::Http(_) | Self::InvalidJson | Self::Network(_) | Self::Timeout
        )
    }
}
