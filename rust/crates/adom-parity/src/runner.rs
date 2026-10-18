//! Runner de paridade: a fonte Rust entra por injeção e o Node vem do corpus.
//!
//! ## Ponto de costura com o orquestrador
//!
//! A API pública é `adom_search::orchestrator::Orchestrator::handle`. O adapter
//! vive em [`crate::orchestrator_source`]:
//!
//! 1. troca `{{config}}` por um segmento concreto (`NormalizeOptions::config_segment`);
//! 2. chama `handle` com UA/origin/`now_ms` fixo;
//! 3. devolve `{streams, cacheMaxAge}` como [`serde_json::Value`].
//!
//! [`ReplaySource`] continua no `--replay` (corpus contra ele mesmo). Closures
//! `Fn(&Case) -> Result<Value, SourceError>` também são fonte (testes fabricados).
//! Casos sem fixture (`meta.json`+`raw.json`) devem devolver
//! [`ProduceOutcome::Skip`] — nunca inventar lista contra o golden.

use std::fmt;

use serde::Serialize;
use serde_json::Value;

use crate::corpus::{Case, Corpus};
use crate::diff::Diff;
use crate::normalize::{normalize_body, NormalizeError, NormalizeOptions, NormalizedResponse};

/// Falha da fonte Rust. Não é divergência: o contrato separa `timeout`/`error`
/// de `divergence` (§9.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceError {
    pub message: String,
}

impl SourceError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SourceError {}

impl From<NormalizeError> for SourceError {
    fn from(error: NormalizeError) -> Self {
        Self::new(error.to_string())
    }
}

/// Resultado da fonte: corpo comparável ou skip honesto (sem dados para remontar).
#[derive(Debug, Clone, PartialEq)]
pub enum ProduceOutcome {
    Body(Value),
    Skip { reason: String },
}

/// Fonte do corpo do `/stream` no lado Rust.
pub trait StreamSource {
    fn produce(&self, case: &Case) -> Result<ProduceOutcome, SourceError>;
}

impl<F> StreamSource for F
where
    F: Fn(&Case) -> Result<Value, SourceError>,
{
    fn produce(&self, case: &Case) -> Result<ProduceOutcome, SourceError> {
        Ok(ProduceOutcome::Body((self)(case)?))
    }
}

/// Fonte de replay: devolve a resposta gravada no corpus. Serve para provar o
/// normalizador/diff de ponta a ponta sem orquestrador.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReplaySource;

impl StreamSource for ReplaySource {
    fn produce(&self, case: &Case) -> Result<ProduceOutcome, SourceError> {
        let body = case.response.body.clone().ok_or_else(|| {
            SourceError::new(format!(
                "caso {} não tem corpo JSON (body_raw)",
                case.meta.id
            ))
        })?;
        Ok(ProduceOutcome::Body(body))
    }
}

/// Resultado de um caso.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum CaseStatus {
    Match {
        streams: usize,
        fingerprint: String,
    },
    Diverged {
        diff: Diff,
        expected_fingerprint: String,
        actual_fingerprint: String,
    },
    /// O corpus não tem corpo comparável (ex.: `body_raw`).
    Skipped {
        reason: String,
    },
    /// O próprio Node gravado é inválido — defeito do corpus, não do Rust.
    CorpusError {
        message: String,
    },
    /// A fonte Rust falhou (erro/timeout). Nunca conta como divergência.
    SourceError {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaseReport {
    pub case_id: String,
    pub status: CaseStatus,
}

/// Resultado da execução do corpus inteiro.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ParityReport {
    pub cases: Vec<CaseReport>,
}

impl ParityReport {
    pub fn compared(&self) -> usize {
        self.cases
            .iter()
            .filter(|case| {
                matches!(
                    case.status,
                    CaseStatus::Match { .. } | CaseStatus::Diverged { .. }
                )
            })
            .count()
    }

    pub fn matched(&self) -> usize {
        self.cases
            .iter()
            .filter(|case| matches!(case.status, CaseStatus::Match { .. }))
            .count()
    }

    pub fn diverged(&self) -> usize {
        self.cases
            .iter()
            .filter(|case| matches!(case.status, CaseStatus::Diverged { .. }))
            .count()
    }

    pub fn skipped(&self) -> usize {
        self.cases
            .iter()
            .filter(|case| matches!(case.status, CaseStatus::Skipped { .. }))
            .count()
    }

    pub fn corpus_errors(&self) -> usize {
        self.cases
            .iter()
            .filter(|case| matches!(case.status, CaseStatus::CorpusError { .. }))
            .count()
    }

    pub fn source_errors(&self) -> usize {
        self.cases
            .iter()
            .filter(|case| matches!(case.status, CaseStatus::SourceError { .. }))
            .count()
    }

    /// Critério de corte: todo caso com corpo JSON foi comparado e bateu.
    pub fn is_perfect(&self) -> bool {
        self.compared() > 0
            && self.diverged() == 0
            && self.skipped() == 0
            && self.corpus_errors() == 0
            && self.source_errors() == 0
    }
}

impl fmt::Display for ParityReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            f,
            "paridade stream-e2e: {} comparado(s), {} igual(ais), {} divergente(s), \
             {} pulado(s), {} erro(s) de corpus, {} erro(s) de fonte",
            self.compared(),
            self.matched(),
            self.diverged(),
            self.skipped(),
            self.corpus_errors(),
            self.source_errors()
        )?;
        for case in &self.cases {
            match &case.status {
                CaseStatus::Match { streams, .. } => {
                    let _ = writeln!(f, "  ok {} ({streams} stream(s))", case.case_id);
                }
                CaseStatus::Diverged {
                    diff,
                    expected_fingerprint,
                    actual_fingerprint,
                } => {
                    let _ = writeln!(
                        f,
                        "  DIVERGE {} (node={expected_fingerprint}, rust={actual_fingerprint})",
                        case.case_id
                    );
                    for line in diff.to_string().lines() {
                        let _ = writeln!(f, "    {line}");
                    }
                }
                CaseStatus::Skipped { reason } => {
                    let _ = writeln!(f, "  pulado {}: {reason}", case.case_id);
                }
                CaseStatus::CorpusError { message } => {
                    let _ = writeln!(f, "  corpus inválido {}: {message}", case.case_id);
                }
                CaseStatus::SourceError { message } => {
                    let _ = writeln!(f, "  fonte falhou {}: {message}", case.case_id);
                }
            }
        }
        Ok(())
    }
}

/// Roda o corpus inteiro contra uma fonte, normalizando os dois lados com as
/// mesmas opções. Nunca entra em panic por caso parcial: erros viram status.
pub fn run_corpus(
    corpus: &Corpus,
    source: &dyn StreamSource,
    options: &NormalizeOptions,
) -> ParityReport {
    let mut cases = Vec::with_capacity(corpus.cases.len());
    for case in &corpus.cases {
        cases.push(run_case(case, source, options));
    }
    ParityReport { cases }
}

fn run_case(case: &Case, source: &dyn StreamSource, options: &NormalizeOptions) -> CaseReport {
    let case_id = case.meta.id.clone();
    let Some(body) = &case.response.body else {
        return CaseReport {
            case_id,
            status: CaseStatus::Skipped {
                reason: if case.response.body_raw.is_some() {
                    "resposta sem corpo JSON (body_raw)".to_string()
                } else {
                    "resposta sem corpo".to_string()
                },
            },
        };
    };

    let expected = match normalize_body(body, options) {
        Ok(normalized) => normalized,
        Err(error) => {
            return CaseReport {
                case_id,
                status: CaseStatus::CorpusError {
                    message: error.to_string(),
                },
            }
        }
    };
    let produced = match source.produce(case) {
        Ok(ProduceOutcome::Body(value)) => value,
        Ok(ProduceOutcome::Skip { reason }) => {
            return CaseReport {
                case_id,
                status: CaseStatus::Skipped { reason },
            }
        }
        Err(error) => {
            return CaseReport {
                case_id,
                status: CaseStatus::SourceError {
                    message: error.to_string(),
                },
            }
        }
    };
    let actual = match normalize_body(&produced, options) {
        Ok(normalized) => normalized,
        Err(error) => {
            return CaseReport {
                case_id,
                status: CaseStatus::SourceError {
                    message: format!("corpo da fonte inválido: {error}"),
                },
            }
        }
    };
    compare_normalized(case_id, &expected, &actual)
}

fn compare_normalized(
    case_id: String,
    expected: &NormalizedResponse,
    actual: &NormalizedResponse,
) -> CaseReport {
    let diff = Diff::compare(expected, actual);
    if diff.is_empty() {
        CaseReport {
            case_id,
            status: CaseStatus::Match {
                streams: expected.stream_count(),
                fingerprint: expected.fingerprint(),
            },
        }
    } else {
        CaseReport {
            case_id,
            status: CaseStatus::Diverged {
                diff,
                expected_fingerprint: expected.fingerprint(),
                actual_fingerprint: actual.fingerprint(),
            },
        }
    }
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
