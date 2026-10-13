//! Protetor do VacaTorrent contra o TS. Golden:
//! `DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/vacatorrent-protector.mjs`

mod golden_support;

use adom_crawl::profile_parsers::b64_data_link_is_http;
use adom_resolvers::common::magnet::VACA;
use adom_resolvers::sites::vacatorrent::protector::next_protected_url;
use golden_support::{fixture, load};

#[test]
fn proximo_salto_magnet_e_destino_nao_magnet() {
    let golden = load("vacatorrent-protector");
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["fixture"].as_str().unwrap();
        let html = match case["html"].as_str() {
            Some(h) => h.to_string(),
            None => fixture(name),
        };
        let base = case["base"].as_str().unwrap();
        let next = next_protected_url(&html, base);
        if next.as_deref() != case["next"].as_str() {
            failures.push(format!(
                "{name} @{base} next\n  rust={next:?}\n  ts  ={}",
                case["next"]
            ));
        }
        let magnet = VACA.extract(&html);
        if magnet.as_deref() != case["magnet"].as_str() {
            failures.push(format!(
                "{name} magnet\n  rust={magnet:?}\n  ts  ={}",
                case["magnet"]
            ));
        }
        let non_magnet = b64_data_link_is_http(&html);
        if Some(non_magnet) != case["non_magnet"].as_bool() {
            failures.push(format!(
                "{name} non_magnet rust={non_magnet} ts={}",
                case["non_magnet"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} divergência(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}
