//! Helpers dos goldens de CONTRATO dos passos do worker do Chupim.
//!
//! Os quatro passos novos (`probe_step`, `season_step`, `suppressed_step` e
//! `evict_step`) moram no BINÁRIO `adom-server`: não existe alvo `lib`, então
//! eles não são alcançáveis de `crates/adom-core/tests/` nem do `common` de lá.
//! Estes módulos repetem o MESMO formato de fixture do golden do `adom-core`
//! (`{id,input,expected}` por linha + manifest com sha256), com uma diferença
//! DECLARADA: o `expected` é de CONTRATO — a decisão esperada foi escrita a
//! partir do contrato documentado no módulo e no TS de `../adom-esm`, não
//! medida de um oráculo. O manifest carrega `"kind": "contract"` e
//! `"oracle": null`, e nenhum teste aqui afirma paridade com o TypeScript.
//!
//! O gerador é `scripts/golden/contract-autofetch-steps.mjs` (manual): ele
//! serializa a tabela de contrato e prende o hash. Quem roda no CI são os
//! testes Rust.
#![allow(dead_code)]

use adom_autofetch::v3::sha256_hex;
use serde::Deserialize;
use serde_json::Value;

/// Formato do manifest — o mesmo dos goldens de `adom-core`.
pub const MANIFEST_FORMAT: &str = "adom-golden-manifest/1";

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub kind: String,
    pub registry: Vec<String>,
    pub output: OutputRef,
}

#[derive(Debug, Deserialize)]
pub struct OutputRef {
    pub path: String,
    pub sha256: String,
    pub lines: usize,
}

/// Um caso do golden: id estável, entrada JSON e a decisão esperada (string).
pub struct Case {
    pub id: String,
    pub input: Value,
    pub expected: String,
}

/// Normalização declarada no manifest (`sourceHashLineEndings: "LF"`): checkout
/// com CRLF não muda o hash nem a contagem.
pub fn normalize_lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

pub fn parse_cases(jsonl: &str) -> Vec<Case> {
    let text = normalize_lf(jsonl);
    let body = text.trim_end_matches('\n');
    assert!(
        !body.is_empty(),
        "golden vazio: nunca aceitar fixture sem casos"
    );
    body.split('\n')
        .map(|line| {
            let row: Value = serde_json::from_str(line).expect("linha do golden é JSON válido");
            let input_text = row["input"]
                .as_str()
                .expect("input precisa ser string JSON");
            Case {
                id: row["id"].as_str().expect("id string").to_string(),
                input: serde_json::from_str(input_text).expect("input precisa ser JSON"),
                expected: row["expected"]
                    .as_str()
                    .expect("expected precisa ser string")
                    .to_string(),
            }
        })
        .collect()
}

/// Integridade do fixture: formato, tipo (contrato), registry, hash e contagem.
/// Devolve os casos prontos para o teste de decisão.
pub fn load(jsonl: &str, manifest_text: &str, path: &str, registry: &str) -> Vec<Case> {
    let manifest: Manifest =
        serde_json::from_str(manifest_text).expect("manifest do golden é JSON válido");
    assert_eq!(manifest.format, MANIFEST_FORMAT);
    assert_eq!(
        manifest.kind, "contract",
        "este golden é de CONTRATO: paridade com o TS tem outro dono"
    );
    assert_eq!(manifest.registry, vec![registry.to_string()]);
    assert_eq!(manifest.output.path, path);
    let cases = parse_cases(jsonl);
    assert_eq!(
        manifest.output.sha256,
        sha256_hex(&normalize_lf(jsonl)),
        "fixture alterada fora do gerador: rode scripts/golden/contract-autofetch-steps.mjs"
    );
    assert_eq!(
        manifest.output.lines,
        cases.len(),
        "manifest declara outra contagem de casos"
    );
    let mut ids = std::collections::HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    cases
}
