//! `adom-debrid export` devolve os namespaces deste banco ao `cache.db`.
//! Só com o addon parado: os dois processos não escrevem o mesmo arquivo.

use std::path::PathBuf;
use std::process::ExitCode;

use adom_debrid::export_owned;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("[debrid] {err}");
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("export") {
        return Err(
            "uso: adom-debrid export --from data/debrid.db --into data/cache.db --yes".into(),
        );
    }
    let from = flag(&args, "--from")?;
    let into = flag(&args, "--into")?;
    if !args.iter().any(|arg| arg == "--yes") {
        return Err("recusado: passe --yes com o container parado".into());
    }
    let copied = export_owned(&PathBuf::from(from), &PathBuf::from(into))?;
    eprintln!("[debrid] export gravou {copied} chave(s) em {into}");
    Ok(())
}

fn flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
        .ok_or_else(|| format!("falta {name}"))
}
