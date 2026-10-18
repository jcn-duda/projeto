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
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sha256_hex;

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

        let mut loader = Loader {
            root,
            options,
            manifest,
            cases: Vec::new(),
            diagnostics: Vec::new(),
            stats: CorpusStats::default(),
            seen_ids: BTreeSet::new(),
        };
        loader.run();
        let Loader {
            root,
            manifest,
            cases,
            diagnostics,
            stats,
            ..
        } = loader;
        Ok(Self {
            root,
            manifest,
            cases,
            diagnostics,
            stats,
        })
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

struct Loader {
    root: PathBuf,
    options: LoadOptions,
    manifest: Manifest,
    cases: Vec<Case>,
    diagnostics: Vec<Diagnostic>,
    stats: CorpusStats,
    seen_ids: BTreeSet<String>,
}

impl Loader {
    fn run(&mut self) {
        self.check_manifest();
        // Clona os metadados para não emprestar `self` inteiro dentro do laço.
        let metas = self.manifest.cases.clone();
        for meta in &metas {
            self.load_case(meta);
        }
        self.stats.manifest_cases = metas.len();
        self.stats.loaded_cases = self.cases.len();
        self.finish_stats();
    }

    fn warn(&mut self, case_id: Option<&str>, message: impl Into<String>) {
        self.diagnostics
            .push(Diagnostic::new(DiagnosticLevel::Warning, case_id, message));
    }

    fn info(&mut self, case_id: Option<&str>, message: impl Into<String>) {
        self.diagnostics
            .push(Diagnostic::new(DiagnosticLevel::Info, case_id, message));
    }

    fn error(&mut self, case_id: Option<&str>, message: impl Into<String>) {
        self.diagnostics
            .push(Diagnostic::new(DiagnosticLevel::Error, case_id, message));
    }

    fn check_manifest(&mut self) {
        if self.manifest.format != FORMAT {
            let found = if self.manifest.format.is_empty() {
                "<ausente>".to_string()
            } else {
                self.manifest.format.clone()
            };
            self.error(None, format!("manifest.format={found}; esperado {FORMAT}"));
        }
        if self.manifest.base.as_deref() != Some("{{base}}") {
            self.warn(
                None,
                format!(
                    "manifest.base={:?}; o corpus versionado deveria mascarar a origem como {{{{base}}}}",
                    self.manifest.base
                ),
            );
        }
        if self.manifest.captured_at.is_none() {
            self.info(None, "manifest sem capturedAt (proveniência ausente)");
        }
        if self.manifest.cases.is_empty() {
            self.error(None, "manifest sem cases");
        }
        if self.manifest.not_captured.is_empty() {
            self.info(None, "manifest sem notCaptured (lacunas não declaradas)");
        } else {
            self.info(
                None,
                format!(
                    "manifest declara {} lacuna(s) em notCaptured",
                    self.manifest.not_captured.len()
                ),
            );
        }
        if !self.manifest.extra.is_empty() {
            let fields: Vec<String> = self.manifest.extra.keys().cloned().collect();
            self.stats.manifest_extra_fields = fields.clone();
            self.info(
                None,
                format!(
                    "manifest traz campo(s) não modelado(s): {}",
                    fields.join(", ")
                ),
            );
        }
    }

    fn load_case(&mut self, meta: &CaseMeta) {
        let case_id = meta.id.as_str();
        if case_id.is_empty() {
            self.error(None, "case sem id no manifest");
            return;
        }
        if !self.seen_ids.insert(case_id.to_string()) {
            self.error(Some(case_id), "id duplicado no manifest");
            return;
        }
        if meta.kind.is_empty() {
            self.warn(Some(case_id), "case sem type no manifest");
        }
        if meta.stream_id.is_empty() {
            self.warn(Some(case_id), "case sem stream_id no manifest");
        }
        if meta.label.is_none() {
            self.stats.labels_missing += 1;
        }
        if !meta.extra.is_empty() {
            for key in meta.extra.keys() {
                self.stats
                    .cases_with_extra_fields
                    .push(format!("{case_id}:{key}"));
            }
        }

        let dir = match self.case_dir(meta) {
            Ok(dir) => dir,
            Err(message) => {
                self.error(Some(case_id), message);
                return;
            }
        };
        if !dir.is_dir() {
            self.error(
                Some(case_id),
                format!("diretório do caso não existe: {}", dir.display()),
            );
            return;
        }
        self.collect_file_stats(&dir);

        if let Err(message) = self.verify_files(meta, &dir) {
            // O erro de sha256 não impede a leitura: o caso ainda é útil para
            // o diff, mas o `--dump` reprova.
            self.error(Some(case_id), message);
        }

        let request_path = dir.join("request.json");
        let response_path = dir.join("response.json");
        let request: CaseRequest = match self.read_json(&request_path) {
            Ok(value) => value,
            Err(message) => {
                self.error(Some(case_id), message);
                return;
            }
        };
        let response: RecordedResponse = match self.read_json(&response_path) {
            Ok(value) => value,
            Err(message) => {
                self.error(Some(case_id), message);
                return;
            }
        };
        if !request.extra.is_empty() {
            for key in request.extra.keys() {
                self.stats
                    .cases_with_extra_fields
                    .push(format!("{case_id}:request.{key}"));
            }
        }
        if !response.extra.is_empty() {
            for key in response.extra.keys() {
                self.stats
                    .cases_with_extra_fields
                    .push(format!("{case_id}:response.{key}"));
            }
        }

        self.validate_case(meta, &request, &response);
        self.accumulate_stats(&request, &response);
        self.cases.push(Case {
            meta: meta.clone(),
            request,
            response,
        });
    }

    fn case_dir(&self, meta: &CaseMeta) -> Result<PathBuf, String> {
        let dir = if meta.dir.is_empty() {
            format!("cases/{}", meta.id)
        } else {
            meta.dir.clone()
        };
        let path = Path::new(&dir);
        if path.is_absolute()
            || path.components().any(|c| {
                matches!(
                    c,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(format!("manifest.dir não é relativo seguro: {dir}"));
        }
        Ok(self.root.join(path))
    }

    fn verify_files(&mut self, meta: &CaseMeta, dir: &Path) -> Result<(), String> {
        if meta.files.is_empty() {
            self.warn(
                Some(&meta.id),
                "manifest.files vazio: sha256 do caso não verificado",
            );
            return Ok(());
        }
        if !self.options.verify_sha256 {
            return Ok(());
        }
        for name in meta.files.keys() {
            let path = dir.join(name);
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    return Err(format!("não li {name}: {error}"));
                }
            };
            let Some(expected) = meta.file_sha256(name) else {
                self.warn(
                    Some(&meta.id),
                    format!("sha256 de {name} não é string/{{sha256}} — não verificado"),
                );
                continue;
            };
            let actual = sha256_hex(&bytes);
            if actual != expected {
                return Err(format!(
                    "sha256 de {name} diverge (manifest={expected}, arquivo={actual})"
                ));
            }
        }
        Ok(())
    }

    fn read_json<T: for<'de> Deserialize<'de>>(&mut self, path: &Path) -> Result<T, String> {
        let bytes =
            fs::read(path).map_err(|error| format!("não li {}: {error}", path.display()))?;
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("JSON inválido em {}: {error}", path.display()))
    }

    fn validate_case(
        &mut self,
        meta: &CaseMeta,
        request: &CaseRequest,
        response: &RecordedResponse,
    ) {
        let case_id = Some(meta.id.as_str());
        if request.method != "GET" {
            self.warn(
                case_id,
                format!("request.method={:?}; esperado GET", request.method),
            );
        }
        if request.path.is_empty() || !request.path.contains("/stream/") {
            self.error(
                case_id,
                format!("request.path sem /stream/: {:?}", request.path),
            );
        }
        if request.user_config_sha256.is_some()
            && self.manifest.user_config_sha256.is_some()
            && request.user_config_sha256 != self.manifest.user_config_sha256
        {
            self.warn(
                case_id,
                "request.user_config_sha256 difere do manifest (caso de outra instalação?)",
            );
        }

        if response.status.is_none() {
            self.warn(case_id, "response.status ausente");
        }
        if let (Some(expected), Some(actual)) = (meta.status, response.status) {
            if expected != actual {
                self.error(
                    case_id,
                    format!("response.status={actual} difere do manifest ({expected})"),
                );
            }
        }
        if let (Some(expected), Some(actual)) = (meta.cache_max_age, response.cache_max_age) {
            if expected != actual {
                self.error(
                    case_id,
                    format!("response.cacheMaxAge={actual} difere do manifest ({expected})"),
                );
            }
        }
        match (&response.body, &response.body_raw) {
            (None, None) => self.error(case_id, "response sem body nem body_raw"),
            (Some(_), Some(_)) => {
                self.warn(case_id, "response traz body e body_raw ao mesmo tempo")
            }
            _ => {}
        }
        if let Some(body) = &response.body {
            self.validate_body(meta, body);
        }
    }

    fn validate_body(&mut self, meta: &CaseMeta, body: &Value) {
        let case_id = Some(meta.id.as_str());
        let Some(object) = body.as_object() else {
            self.error(case_id, "body não é objeto JSON");
            return;
        };
        match object.get("streams") {
            None => self.warn(case_id, "body.streams ausente"),
            Some(Value::Array(_)) => {}
            Some(_) => self.error(case_id, "body.streams não é array"),
        }
        match object.get("cacheMaxAge") {
            None => self.warn(case_id, "body.cacheMaxAge ausente"),
            Some(Value::Number(number)) => {
                if number.as_u64().is_none() {
                    self.warn(case_id, "body.cacheMaxAge não é inteiro não-negativo");
                } else if let (Some(expected), Some(actual)) = (
                    meta.cache_max_age,
                    number.as_u64().and_then(|n| u32::try_from(n).ok()),
                ) {
                    if expected != actual {
                        self.error(
                            case_id,
                            format!("body.cacheMaxAge={actual} difere do manifest ({expected})"),
                        );
                    }
                }
            }
            Some(_) => self.error(case_id, "body.cacheMaxAge não é número"),
        }
    }

    fn accumulate_stats(&mut self, request: &CaseRequest, response: &RecordedResponse) {
        self.stats
            .request_headers
            .extend(request.headers.keys().cloned());
        if response.body.is_some() {
            self.stats.json_bodies += 1;
        }
        if response.body_raw.is_some() {
            self.stats.raw_bodies += 1;
        }
        if let Some(body) = &response.body {
            let streams = body
                .get("streams")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            self.stats.stream_items += streams.len();
            self.stats.max_streams = self.stats.max_streams.max(streams.len());
            if streams.is_empty() {
                self.stats.empty_lists += 1;
            }
            if streams.len() == 1 && streams[0].get("externalUrl").is_some() {
                self.stats.notice_cases += 1;
            }
            if streams.iter().any(|s| s.get("infoHash").is_some()) {
                self.stats.p2p_cases += 1;
            }
            if streams.iter().any(|s| s.get("url").is_some()) {
                self.stats.debrid_cases += 1;
            }
            for stream in streams {
                if let Some(object) = stream.as_object() {
                    self.stats.stream_fields.extend(object.keys().cloned());
                }
            }
        }
    }

    fn collect_file_stats(&mut self, dir: &Path) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            *self.stats.file_names.entry(name.clone()).or_insert(0) += 1;
            if name != "request.json" && name != "response.json" {
                self.stats.step_files += 1;
                self.stats.step_file_names.insert(name);
            }
        }
    }

    fn finish_stats(&mut self) {
        // Conta os tipos antes de mexer em `self.stats`/`self.diagnostics`:
        // `self.cases` fica emprestado só durante o laço.
        let mut movies = 0;
        let mut series = 0;
        let mut other_types = 0;
        for case in &self.cases {
            match case.meta.kind.as_str() {
                "movie" => movies += 1,
                "series" => series += 1,
                _ => other_types += 1,
            }
        }
        self.stats.movies = movies;
        self.stats.series = series;
        self.stats.other_types = other_types;

        if self.stats.step_files == 0 {
            self.info(
                None,
                "nenhum arquivo por etapa (trace/meta/raw/debrid) no corpus: \
                 a comparação cobre a FORMA da resposta final, não as decisões internas",
            );
        } else {
            let names: Vec<String> = self.stats.step_file_names.iter().cloned().collect();
            self.info(
                None,
                format!(
                    "corpus tem {} arquivo(s) por etapa: {}",
                    self.stats.step_files,
                    names.join(", ")
                ),
            );
        }
        self.stats.cases_with_extra_fields.sort();
        self.stats.cases_with_extra_fields.dedup();
    }
}
