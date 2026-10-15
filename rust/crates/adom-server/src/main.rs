mod config;
mod proxy;

#[cfg(test)]
mod tests;

#[tokio::main]
async fn main() {
    let config = match config::Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("[gateway] {err}");
            std::process::exit(1);
        }
    };
    // A API interna nasce com o gateway. Falha aqui não derruba a 7000:
    // painel, /stream e play continuam no Node.
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
