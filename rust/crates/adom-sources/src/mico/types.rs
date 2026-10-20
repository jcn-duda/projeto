//! Tipos públicos do cliente Mico — alinhados a `src/providers/mico.ts`.

use serde::{Deserialize, Serialize};

/// Argumentos de busca (filme por IMDb; série por IMDb + S/E).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicoSearchArgs {
    pub media_type: MicoMediaType,
    pub imdb_id: String,
    pub season: Option<i32>,
    pub episode: Option<i32>,
    /// Ano de estreia (só metadado; a captura do banco fica fora desta fatia).
    pub year: Option<i32>,
}

/// Tipo de obra na rota `/stream/{movie|series}/…`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicoMediaType {
    Movie,
    Series,
}

impl MicoMediaType {
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

/// Item cru do addon Mico Leão Dublado.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicoRawItem {
    pub title: String,
    /// Hash 40-hex em minúsculas.
    pub info_hash: String,
    pub magnet: String,
    pub seeders: f64,
    /// Bytes quando o título informa 💾 com tamanho > 0.
    pub size: Option<f64>,
    /// Sempre `"mico"`.
    pub indexer: String,
    /// `looks_pt_br(title)` ou `(brazil` no título completo.
    pub is_br: bool,
}

/// Resultado do fetch puro (`fetch_streams`) — espelha `{ items, ok }` do TS.
#[derive(Debug, Clone, PartialEq)]
pub struct MicoFetchOutcome {
    pub items: Vec<MicoRawItem>,
    /// `true` só em HTTP 200 (reseta o breaker no `search`).
    pub ok: bool,
}

/// Opções de UMA consulta ao Mico (espelha `SearchOptions.readOnly` do TS).
///
/// O breaker é local e do PROCESSO: só o caminho vivo pode abrir/fechar o
/// circuito. A sombra de fonte é referência read-only — o estado global não
/// decide o que ela consulta e o resultado dela não pode alimentar o breaker.
/// `deadline_at` é o prazo ABSOLUTO do coletor: quando a consulta não termina
/// até ele, o Node a teria como `pending` (não falha), então o cliente devolve
/// [`MicoOutcome::Pending`] e NÃO conta falha no circuito.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MicoSearchOptions {
    pub read_only: bool,
    pub deadline_at: Option<i64>,
}

impl MicoSearchOptions {
    /// Caminho de resposta: respeita e alimenta o breaker.
    pub const LIVE: Self = Self {
        read_only: false,
        deadline_at: None,
    };
    /// Sombra read-only: consulta mesmo com o circuito aberto, sem tocá-lo.
    pub const SHADOW: Self = Self {
        read_only: true,
        deadline_at: None,
    };
}

/// Desfecho de UMA consulta ao Mico.
///
/// Separa resposta VÁLIDA (mesmo vazia) de configuração, de falha declarada e
/// de `pending` no prazo. O `search()` antigo continua fail-open devolvendo
/// `Vec`; este tipo é o caminho detalhado do coletor (`live`).
#[derive(Debug, Clone, PartialEq)]
pub enum MicoOutcome {
    /// 2xx com JSON (pode vir sem `streams`, como `Array.isArray(data?.streams)`).
    Ok(Vec<MicoRawItem>),
    /// `MICO_ENABLED=false`: o Node nem monta a tarefa; nada foi prometido.
    Disabled,
    /// Base barrada pela guarda SSRF: configuração inválida, não consulta.
    BlockedUrl,
    /// Args incompletos (filme sem IMDb / série sem S/E): sem rede, como o TS.
    NoEndpoint,
    /// Circuito local aberto (falhas seguidas recentes): pulada sem rede.
    BreakerOpen,
    /// Prazo absoluto vencido antes da resposta: no Node a consulta ainda
    /// estaria em voo (`pending`), que conta como indisponível — não falha.
    Pending,
    /// HTTP não-2xx. `429`/`5xx` alimentam o breaker; os demais 4xx pertencem à
    /// obra e o Node não os conta como falha do host.
    Http(u16),
    /// Corpo 2xx que não é JSON.
    InvalidJson,
    /// Falha de transporte (DNS/conexão/TLS).
    Network(String),
    /// Prazo da PRÓPRIA consulta (antes do deadline do coletor) vencido.
    Timeout,
}

impl MicoOutcome {
    /// Itens quando a resposta foi válida; qualquer outro desfecho é `[]`.
    pub fn into_items(self) -> Vec<MicoRawItem> {
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
            Self::Pending => "pending".to_string(),
            Self::Http(status) => format!("http-{status}"),
            Self::InvalidJson => "invalid-json".to_string(),
            Self::Network(_) => "network".to_string(),
            Self::Timeout => "timeout".to_string(),
        }
    }

    /// `true` quando a consulta foi TENTADA e o host não respondeu (429/5xx/
    /// rede/timeout/JSON inválido) — o que o Node trata como falha e o que
    /// alimenta o breaker no caminho vivo.
    pub fn is_host_failure(&self) -> bool {
        match self {
            Self::Http(status) => *status == 429 || *status >= 500,
            Self::InvalidJson | Self::Network(_) | Self::Timeout => true,
            _ => false,
        }
    }
}
