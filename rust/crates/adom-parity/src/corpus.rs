//! Leitor do corpus `stream-e2e`, com diagnóstico em vez de falha silenciosa.
//!
//! O corpus real (capturado em `2026-10-18T01:58:21.378Z`, Node v22.23.2) tem
//! **51 casos** e, por caso, somente `request.json` + `response.json`. Não há
//! `meta.json`/`raw.json`/`debrid.json` nem trace por etapa — o `README.md` do
//! corpus documenta as lacunas e o manifest repete a lista em `notCaptured`.
//! Por isso o leitor:
//!
//! - trata todo campo do manifest/caso como opcional (esquema ausente não
//!   aborta a carga: vira [`Diagnostic`]);
//! - confere sha256 de **todos** os arquivos listados em `files`, inclusive um
//!   futuro `trace.json`/`meta.json` que o manifest passe a versionar;
//! - separa erro (integridade/contrato) de aviso (proveniência/estatística);
//! - produz [`CorpusStats`], que é o retrato do que existe de fato — é o que o
//!   `--dump` imprime e o que os testes usam como tripwire de regeneração.
//!
//! `body_raw` (resposta não-JSON) é aceito: o caso carrega, mas o runner o
//! marca como pulado por não haver corpo comparável.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[path = "corpus_loader.rs"]
mod corpus_loader;
use corpus_loader::Loader;

/// Formato do manifest que este harness entende.
pub const FORMAT: &str = "adom-stream-e2e/1";

/// Uma entrada do manifest. Todos os campos são opcionais na leitura.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CaseMeta {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub stream_id: String,
    /// Caminho relativo do caso (ex.: `cases/movie-matrix`).
    #[serde(default)]
    pub dir: String,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(rename = "cacheMaxAge", default)]
    pub cache_max_age: Option<u32>,
    /// `{"request.json": "<sha256>", ...}` — o valor pode ser string ou objeto
    /// `{"sha256": "..."}` para tolerar uma futura evolução do gerador.
    #[serde(default)]
    pub files: BTreeMap<String, Value>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl CaseMeta {
    /// sha256 declarado para um arquivo, nos dois formatos aceitos.
    pub fn file_sha256(&self, name: &str) -> Option<&str> {
        let value = self.files.get(name)?;
        value
            .as_str()
            .or_else(|| value.get("sha256").and_then(Value::as_str))
    }
}

/// `request.json` — a entrada gravada.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CaseRequest {
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub user_config_sha256: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// `response.json` — a saída do Node, com envelope HTTP e corpo JSON (ou cru).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecordedResponse {
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(rename = "cacheMaxAge", default)]
    pub cache_max_age: Option<u32>,
    /// Corpo JSON do `/stream` (`{streams, cacheMaxAge, ...}`), quando houve.
    #[serde(default)]
    pub body: Option<Value>,
    /// Corpo não-JSON (HTML de proxy, texto de erro), quando houve.
    #[serde(default)]
    pub body_raw: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Um caso carregado do disco.
#[derive(Debug, Clone)]
pub struct Case {
    pub meta: CaseMeta,
    pub request: CaseRequest,
    pub response: RecordedResponse,
}

/// Manifest completo; campos desconhecidos ficam em `extra` em vez de quebrar.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub format: String,
    #[serde(rename = "capturedAt", default)]
    pub captured_at: Option<String>,
    #[serde(default)]
    pub node: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub user_config_sha256: Option<String>,
    #[serde(default)]
    pub cases_file: Option<String>,
    #[serde(default)]
    pub cases: Vec<CaseMeta>,
    #[serde(rename = "notCaptured", default)]
    pub not_captured: Vec<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Nível do diagnóstico. `Error` reprova o `--dump`; `Warning` só com
/// `--strict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

/// Um achado da carga, com o caso a que pertence (quando aplicável).
#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub level: DiagnosticLevel,
    pub case_id: Option<String>,
    pub message: String,
}

impl Diagnostic {
    fn new(level: DiagnosticLevel, case_id: Option<&str>, message: impl Into<String>) -> Self {
        Self {
            level,
            case_id: case_id.map(str::to_owned),
            message: message.into(),
        }
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let level = match self.level {
            DiagnosticLevel::Info => "info",
            DiagnosticLevel::Warning => "aviso",
            DiagnosticLevel::Error => "erro",
        };
        match &self.case_id {
            Some(id) => write!(f, "[{level}] {id}: {}", self.message),
            None => write!(f, "[{level}] {}", self.message),
        }
    }
}

/// Retrato do corpus carregado. Campos ausentes no esquema viram zero/vazio.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CorpusStats {
    pub manifest_cases: usize,
    pub loaded_cases: usize,
    pub movies: usize,
    pub series: usize,
    pub other_types: usize,
    pub json_bodies: usize,
    pub raw_bodies: usize,
    pub empty_lists: usize,
    pub notice_cases: usize,
    pub p2p_cases: usize,
    pub debrid_cases: usize,
    pub stream_items: usize,
    pub max_streams: usize,
    pub step_files: usize,
    pub file_names: BTreeMap<String, usize>,
    pub step_file_names: BTreeSet<String>,
    pub stream_fields: BTreeSet<String>,
    pub request_headers: BTreeSet<String>,
    pub manifest_extra_fields: Vec<String>,
    pub cases_with_extra_fields: Vec<String>,
    pub labels_missing: usize,
}

/// Opções de carga. O default confere sha256 e não exige arquivos extras.
#[derive(Debug, Clone, Copy)]
pub struct LoadOptions {
    pub verify_sha256: bool,
}

impl Default for LoadOptions {
    fn default() -> Self {
        Self {
            verify_sha256: true,
        }
    }
}

/// Falha fatal (manifest ausente/ilegível). Erros por caso viram diagnóstico e
/// o caso é omitido — o corpus inteiro não cai por um arquivo corrompido.
#[derive(Debug)]
pub enum CorpusError {
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
}

impl fmt::Display for CorpusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "não li {}: {source}", path.display()),
            Self::Json { path, source } => {
                write!(f, "JSON inválido em {}: {source}", path.display())
            }
        }
    }
}

impl std::error::Error for CorpusError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Json { source, .. } => Some(source),
        }
    }
}

/// Corpus carregado + diagnóstico.
#[derive(Debug, Clone)]
pub struct Corpus {
    pub root: PathBuf,
    pub manifest: Manifest,
    pub cases: Vec<Case>,
    pub diagnostics: Vec<Diagnostic>,
    pub stats: CorpusStats,
}

impl Corpus {
    /// Carga com verificação de sha256.
    pub fn load(root: impl AsRef<Path>) -> Result<Self, CorpusError> {
        Self::load_with(root, LoadOptions::default())
    }

    /// Carga tolerante: campos ausentes viram diagnóstico, não erro fatal.
    pub fn load_with(root: impl AsRef<Path>, options: LoadOptions) -> Result<Self, CorpusError> {
        let root = root.as_ref().to_path_buf();
        let manifest_path = root.join("manifest.json");
        let manifest_bytes = fs::read(&manifest_path).map_err(|source| CorpusError::Io {
            path: manifest_path.clone(),
            source,
        })?;
        let manifest: Manifest =
            serde_json::from_slice(&manifest_bytes).map_err(|source| CorpusError::Json {
                path: manifest_path,
                source,
            })?;

        let loader = Loader::new(root, options, manifest);
        Ok(loader.into_corpus())
    }

    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error)
    }

    pub fn count(&self, level: DiagnosticLevel) -> usize {
        self.diagnostics.iter().filter(|d| d.level == level).count()
    }

    pub fn case(&self, id: &str) -> Option<&Case> {
        self.cases.iter().find(|c| c.meta.id == id)
    }
}
