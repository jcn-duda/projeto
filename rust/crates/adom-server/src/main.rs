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
    if let Err(err) = proxy::run(config).await {
        eprintln!("[gateway] {err}");
        std::process::exit(1);
    }
}
