//! Extrator de magnet contra o TS. Golden:
//! `node scripts/rust/resolver-golden/magnet-extract.mjs`

mod golden_support;

use adom_resolvers::common::magnet::{MagnetExtractor, BASIC, RICH, VACA};
use golden_support::{fixture, load};

#[test]
fn tres_variantes_iguais_ao_ts() {
    let golden = load("magnet-extract");
    let variants: [(&str, MagnetExtractor); 3] = [("basic", BASIC), ("rich", RICH), ("vaca", VACA)];
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["fixture"].as_str().unwrap();
        let html = match case["html"].as_str() {
            Some(h) => h.to_string(),
            None => fixture(name),
        };
        for (key, variant) in variants {
            let got = variant.extract(&html);
            if got.as_deref() != case[key].as_str() {
                failures.push(format!(
                    "{name} [{key}]\n  rust={got:?}\n  ts  ={}",
                    case[key]
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} divergência(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}
