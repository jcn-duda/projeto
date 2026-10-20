mod canary;
mod config;
mod proxy;
mod resolve;
mod shadow;
mod store_admin;
mod stream;

#[cfg(test)]
mod tests;

/// `GATEWAY=on` ocupa a 7000. Qualquer outro valor serve só a API interna
/// do debrid e não chama o proxy.
fn gateway_on(value: &str) -> bool {
    value == "on"
}

#[tokio::main]
async fn main() {
    let gateway = std::env::var("GATEWAY").unwrap_or_default();
    if gateway_on(&gateway) {
        run_gateway().await;
    } else {
        run_debrid_api().await;
    }
}

async fn run_gateway() {
    let config = match config::Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("[gateway] {err}");
            std::process::exit(1);
        }
    };
    // Falha da API não derruba a 7000: painel, /stream e play seguem no Node.
    match adom_debrid::api::config_from_env() {
        Ok(internal) => {
            tokio::spawn(async move {
                if let Err(err) = adom_debrid::api::serve(internal).await {
                    eprintln!("[debrid] {err}");
                }
            });
        }
        Err(err) => eprintln!("[debrid] API interna não sobe: {err}"),
    }
    if let Err(err) = proxy::run(config).await {
        eprintln!("[gateway] {err}");
        std::process::exit(1);
    }
}

/// Sem o gateway este processo é só a 8710. Config ou serve que falham
/// encerram o processo; o proxy da 7000 não entra neste caminho.
async fn run_debrid_api() {
    let internal = match adom_debrid::api::config_from_env() {
        Ok(internal) => internal,
        Err(err) => {
            eprintln!("[debrid] {err}");
            std::process::exit(1);
        }
    };
    if let Err(err) = adom_debrid::api::serve(internal).await {
        eprintln!("[debrid] {err}");
        std::process::exit(1);
    }
}
