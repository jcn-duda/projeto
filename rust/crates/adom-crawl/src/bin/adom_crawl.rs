//! Binário CLI do raspador Rust do Adom.
//!
//! Fornece subcomandos para sondagem e diagnóstico de sites,
//! equivalente ao `scripts/crawl-site-probe.ts` do motor TS.
//!
//! Uso:
//!   adom-crawl probe --site=vacatorrent --url=https://vaqueirofilmes1.com/movie-links/12345/

mod probe;

use std::env;
use std::process;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Uso: adom-crawl <comando> [args]");
        eprintln!("Comandos: probe");
        process::exit(1);
    }
    match args[1].as_str() {
        "probe" => {
            if let Err(e) = probe::run(&args[2..]).await {
                eprintln!("Erro: {}", e);
                process::exit(1);
            }
        }
        outro => {
            eprintln!("Comando desconhecido: {}", outro);
            eprintln!("Comandos disponíveis: probe");
            process::exit(1);
        }
    }
}
