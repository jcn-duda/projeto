//! Utilidades compartilhadas pelos testes de integração.
//!
//! Cada binário de teste inclui este módulo inteiro; nem todo helper é usado
//! em todos eles.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use adom_parity::Corpus;

/// Raiz real do corpus versionado.
pub fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden/stream-e2e")
}

/// Corpus real carregado uma vez por processo de teste.
pub fn corpus() -> &'static Corpus {
    static CORPUS: OnceLock<Corpus> = OnceLock::new();
    CORPUS.get_or_init(|| Corpus::load(corpus_root()).expect("corpus real deve carregar"))
}

/// Diretório temporário descartável (sem dependência externa).
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path =
            std::env::temp_dir().join(format!("adom-parity-{}-{tag}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).expect("criar diretório temporário");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn write(&self, relative: &str, contents: &str) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("criar diretório do arquivo");
        }
        fs::write(&path, contents).expect("escrever arquivo de teste");
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn diagnostics_text<T: std::fmt::Display>(items: impl IntoIterator<Item = T>) -> String {
    items
        .into_iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>()
        .join("\n")
}
