use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::sha256_hex;

use super::{
    Case, CaseMeta, CaseRequest, Corpus, CorpusStats, Diagnostic, DiagnosticLevel, LoadOptions,
    Manifest, RecordedResponse, FORMAT,
};

#[path = "corpus_validate.rs"]
mod corpus_validate;
use corpus_validate::validate_case;

pub(crate) struct Loader {
    root: PathBuf,
    options: LoadOptions,
    manifest: Manifest,
    cases: Vec<Case>,
    diagnostics: Vec<Diagnostic>,
    stats: CorpusStats,
    seen_ids: BTreeSet<String>,
}

impl Loader {
    pub(crate) fn new(root: PathBuf, options: LoadOptions, manifest: Manifest) -> Self {
        Self {
            root,
            options,
            manifest,
            cases: Vec::new(),
            diagnostics: Vec::new(),
            stats: CorpusStats::default(),
            seen_ids: BTreeSet::new(),
        }
    }

    pub(crate) fn into_corpus(mut self) -> Corpus {
        self.run();
        Corpus {
            root: self.root,
            manifest: self.manifest,
            cases: self.cases,
            diagnostics: self.diagnostics,
            stats: self.stats,
        }
    }

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

        validate_case(
            meta,
            &request,
            &response,
            &self.manifest,
            &mut self.diagnostics,
        );
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
