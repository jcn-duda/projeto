//! Runner de paridade: a fonte Rust entra por injeção e o Node vem do corpus.
//!
//! ## Ponto de costura com o orquestrador
//!
//! TODO(paridade F1): o `adom_search::orchestrator` **ainda não existe** — hoje
//! o `adom-search` expõe `request`, `contract`, `list_builder`, `cache`,
//! `collect_window` e `debrid_seam`, mas não uma API de `/stream` pronta. Quando
//! o agente do `adom-search` fechar o nome e a assinatura (confirmar
//! `orchestrator` × outro nome), implementar [`StreamSource`] para ele:
//!
//! 1. decodificar o segmento de config do path do caso (hoje `{{config}}`;
//!    o replay deve injetar um segmento concreto via
//!    [`crate::NormalizeOptions::config_segment`]);
//! 2. chamar a orquestração com o `deadline` derivado do User-Agent do
//!    `request.headers` e com a origem do addon;
//! 3. devolver o corpo JSON (`{streams, cacheMaxAge}`) como [`serde_json::Value`].
//!
//! **Não** adicione `adom-search` como dependência deste crate antes desse
//! ponto: a trait é a fronteira que mantém o harness compilando e testável.
//! Enquanto a API não existe, [`ReplaySource`] devolve a resposta gravada no
//! próprio corpus — o teste `runner_replay_*` prova o normalizador de ponta a
//! ponta, e o `--dump` valida só o corpus.
//!
//! Uma closure também é uma fonte: `Fn(&Case) -> Result<Value, SourceError>`.
//! É o caminho para testes fabricados e para adaptar um pipeline em construção
//! sem tocar no runner.

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

/// Fonte do corpo do `/stream` no lado Rust. Implementações reais virão do
/// orquestrador; ver o TODO no topo do módulo.
pub trait StreamSource {
    fn produce(&self, case: &Case) -> Result<Value, SourceError>;
}

impl<F> StreamSource for F
where
    F: Fn(&Case) -> Result<Value, SourceError>,
{
    fn produce(&self, case: &Case) -> Result<Value, SourceError> {
        (self)(case)
    }
}

/// Fonte de replay: devolve a resposta gravada no corpus. Serve para provar o
/// normalizador/diff de ponta a ponta sem orquestrador.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReplaySource;

impl StreamSource for ReplaySource {
    fn produce(&self, case: &Case) -> Result<Value, SourceError> {
        case.response.body.clone().ok_or_else(|| {
            SourceError::new(format!(
                "caso {} não tem corpo JSON (body_raw)",
                case.meta.id
            ))
        })
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
        Ok(value) => value,
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
mod tests {
    use super::*;
    use crate::corpus::{CaseMeta, CaseRequest, RecordedResponse};
    use serde_json::json;

    fn fake_case(id: &str, body: Value) -> Case {
        Case {
            meta: CaseMeta {
                id: id.to_string(),
                ..CaseMeta::default()
            },
            request: CaseRequest {
                method: "GET".to_string(),
                path: "/{{config}}/stream/movie/tt1.json".to_string(),
                ..CaseRequest::default()
            },
            response: RecordedResponse {
                body: Some(body),
                ..RecordedResponse::default()
            },
        }
    }

    #[test]
    fn replay_de_um_caso_bate() {
        let case = fake_case(
            "x",
            json!({"streams": [{"infoHash": "aa", "title": "A"}], "cacheMaxAge": 0}),
        );
        let report = run_corpus(
            &Corpus {
                root: Default::default(),
                manifest: Default::default(),
                cases: vec![case],
                diagnostics: Vec::new(),
                stats: Default::default(),
            },
            &ReplaySource,
            &NormalizeOptions::default(),
        );
        assert!(report.is_perfect(), "{report}");
        assert_eq!(report.compared(), 1);
    }

    #[test]
    fn fonte_com_titulo_diferente_diverge_sem_panic() {
        let case = fake_case(
            "x",
            json!({"streams": [{"infoHash": "aa", "title": "A"}], "cacheMaxAge": 0}),
        );
        let source = |_case: &Case| {
            Ok(json!({"streams": [{"infoHash": "aa", "title": "B"}], "cacheMaxAge": 0}))
        };
        let report = run_corpus(
            &Corpus {
                root: Default::default(),
                manifest: Default::default(),
                cases: vec![case],
                diagnostics: Vec::new(),
                stats: Default::default(),
            },
            &source,
            &NormalizeOptions::default(),
        );
        assert_eq!(report.diverged(), 1, "{report}");
        assert!(report.to_string().contains("streams[0].title"), "{report}");
    }

    #[test]
    fn body_raw_e_pulado() {
        let mut case = fake_case("x", Value::Null);
        case.response.body = None;
        case.response.body_raw = Some("<html>".to_string());
        let report = run_corpus(
            &Corpus {
                root: Default::default(),
                manifest: Default::default(),
                cases: vec![case],
                diagnostics: Vec::new(),
                stats: Default::default(),
            },
            &ReplaySource,
            &NormalizeOptions::default(),
        );
        assert_eq!(report.skipped(), 1, "{report}");
        assert!(!report.is_perfect());
    }
}
