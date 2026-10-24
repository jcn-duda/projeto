//! Estado do Jackett no VOLUME do container: de onde sai a lista de indexers
//! quando o `.env` não traz `JACKETT_INDEXERS`.
//!
//! É o "modo automático" do TS (`src/providers/jackett-catalog.ts::syncAutoIndexers`),
//! com uma diferença de mecanismo: o Node pergunta o catálogo vivo por HTTP (e
//! por isso espera o Jackett subir depois do addon); aqui o estado já está no
//! disco, então a leitura é local, no boot, sem rede e sem prazo.
//!
//! Shape real (imagem pinada do `Dockerfile`):
//! - `ServerConfig.json` guarda servidor/chave — **não** tem lista de indexer;
//! - `Indexers/<id>.json` = UM arquivo por indexer HABILITADO (o nome é o id,
//!   o conteúdo são os campos Cardigann: `[{id,type,name,value}]`);
//! - indexer desabilitado é movido para `Indexers-disabled/`, então a presença
//!   no diretório `Indexers/` é a própria flag de habilitação.
//!
//! O shape antigo (`{"Indexers":[{"Id":...,"Enabled":...}]}` dentro do
//! `ServerConfig.json`) continua aceito — instalação migrada não perde a lista.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Estado do Jackett no container. `./docker-data/jackett` no host vira
/// `/config` no compose e o app escreve em `/config/Jackett`.
pub const JACKETT_CONFIG_DIR_DEFAULT: &str = "/config/Jackett";

/// Override do diretório de estado (mesmo padrão de `CACHE_DB_PATH`).
pub const JACKETT_CONFIG_DIR_ENV: &str = "JACKETT_CONFIG_DIR";

/// Config do servidor (porta, chave, FlareSolverr…).
const SERVER_CONFIG_FILE: &str = "ServerConfig.json";
/// Um arquivo por indexer habilitado (nome = id).
const ENABLED_INDEXERS_DIR: &str = "Indexers";

/// Diretório de estado efetivo do processo: `JACKETT_CONFIG_DIR` ou o volume.
pub fn jackett_config_dir_from_env() -> PathBuf {
    std::env::var(JACKETT_CONFIG_DIR_ENV)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(JACKETT_CONFIG_DIR_DEFAULT))
}

/// Ids declarados DENTRO do `ServerConfig.json`.
///
/// Só o shape antigo traz a lista; no Jackett atual o arquivo existe e a lista
/// não, então o retorno é vazio (o caller cai no diretório `Indexers/`).
/// Ausente, JSON inválido, shape inesperado ou sem id válido → `[]`.
pub fn jackett_indexers_from_server_config(path: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(list) = value.get("Indexers").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::new();
    for entry in list {
        // Sem flag de habilitação o indexer CONTA (instalações antigas não
        // tinham `Enabled`); só `false` explícito fica de fora.
        if entry.get("Enabled").or_else(|| entry.get("enabled")) == Some(&Value::Bool(false)) {
            continue;
        }
        let Some(id) = indexer_id_of(entry) else {
            continue;
        };
        push_unique(&mut ids, id);
    }
    ids
}

/// Lista de indexers HABILITADOS do estado do Jackett.
///
/// `ServerConfig.json` primeiro (ordem do arquivo); se ele não traz lista, o
/// diretório irmão `Indexers/` (ordenado — `read_dir` não promete ordem e o
/// plano precisa ser estável). O `.json.bak` que o Jackett deixa ao gravar não
/// é indexer.
pub fn jackett_indexers_from_config_dir(dir: &Path) -> Vec<String> {
    let from_server_config = jackett_indexers_from_server_config(&dir.join(SERVER_CONFIG_FILE));
    if !from_server_config.is_empty() {
        return from_server_config;
    }
    enabled_indexer_files(&dir.join(ENABLED_INDEXERS_DIR))
}

/// Decisão única do modo automático: env preenchida VENCE (é o contrato do
/// `indexersAuto` do TS); vazia/ausente → volume; nada legível → `[]` (o
/// cliente Jackett cai no agregado `/all`, comportamento anterior).
///
/// O ramo da ENV passa pelo rename dos ids aposentados (`split_indexers`); o
/// ramo do VOLUME NÃO: ali o id é a verdade do card que existe no Jackett, e
/// renomeá-lo apontaria para um id que talvez não exista.
pub fn resolve_jackett_indexers(env_value: Option<&str>, config_dir: &Path) -> Vec<String> {
    let explicit = super::config::split_indexers(env_value.unwrap_or(""));
    if !explicit.is_empty() {
        return explicit;
    }
    jackett_indexers_from_config_dir(config_dir)
}

/// `Id`/`ID`/`id` do objeto. `Name` NÃO serve: o id é o slug da URL Torznab
/// (`/api/v2.0/indexers/<id>/…`), e o nome de exibição não resolve.
fn indexer_id_of(entry: &Value) -> Option<String> {
    ["Id", "ID", "id"]
        .iter()
        .find_map(|key| entry.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| is_safe_indexer_id(id))
        .map(str::to_string)
}

fn enabled_indexer_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_json_file(&path) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let id = stem.trim();
        if is_safe_indexer_id(id) {
            push_unique(&mut ids, id.to_string());
        }
    }
    // `read_dir` não promete ordem: o plano de busca precisa de lista estável.
    ids.sort();
    ids
}

fn is_json_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
}

/// Mesma régua do `SAFE_INDEXER_ID` do orquestrador (`index_source.rs`): o id
/// vai cru na URL Torznab, então nada de barra, ponto de travessia ou vazio.
fn is_safe_indexer_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .skip(1)
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn push_unique(ids: &mut Vec<String>, id: String) {
    if !ids.iter().any(|known| known == &id) {
        ids.push(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Diretório temporário por teste (o `tempfile` não é dev-dep daqui).
    fn fixture(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("adom-jackett-state-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("criar diretório de fixture");
        dir
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("criar diretório da fixture");
        }
        fs::write(path, body).expect("gravar fixture");
    }

    #[test]
    fn server_config_antigo_extrai_ids_na_ordem() {
        let dir = fixture("shape-antigo");
        write(
            &dir.join(SERVER_CONFIG_FILE),
            r#"{"Port":9117,"Indexers":[
                {"Id":"yts","Name":"YTS","Enabled":true},
                {"Id":"1337x","Name":"1337x"},
                {"id":"desligado","Enabled":false},
                {"ID":"yts","Name":"repetido"},
                {"Id":"  ", "Name":"sem id"},
                {"Id":"id/com/barra","Enabled":true},
                "texto solto"
            ]}"#,
        );
        assert_eq!(
            jackett_indexers_from_server_config(&dir.join(SERVER_CONFIG_FILE)),
            vec!["yts".to_string(), "1337x".to_string()]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_config_atual_sem_lista_usa_diretorio_indexers() {
        // Shape da imagem pinada: o ServerConfig existe e NÃO tem `Indexers`.
        let dir = fixture("volume-atual");
        write(
            &dir.join(SERVER_CONFIG_FILE),
            r#"{"Port":9117,"CacheMaxResultsPerIndexer":1000,"APIKey":"x"}"#,
        );
        for id in ["yts", "bludv-cardigann", "1337x"] {
            write(
                &dir.join(ENABLED_INDEXERS_DIR).join(format!("{id}.json")),
                "[]",
            );
        }
        // Restos do Jackett: backup da config e o desabilitado.
        write(&dir.join(ENABLED_INDEXERS_DIR).join("yts.json.bak"), "[]");
        write(&dir.join("Indexers-disabled").join("hdrtorrent.json"), "[]");
        assert_eq!(
            jackett_indexers_from_config_dir(&dir),
            vec![
                "1337x".to_string(),
                "bludv-cardigann".to_string(),
                "yts".to_string()
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_vazia_usa_o_volume() {
        let dir = fixture("env-vazia");
        write(&dir.join(ENABLED_INDEXERS_DIR).join("yts.json"), "[]");
        write(&dir.join(ENABLED_INDEXERS_DIR).join("torrent9.json"), "[]");
        for raw in [None, Some(""), Some("   ")] {
            assert_eq!(
                resolve_jackett_indexers(raw, &dir),
                vec!["torrent9".to_string(), "yts".to_string()]
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_preenchida_ignora_o_arquivo() {
        let dir = fixture("env-prechelida");
        write(
            &dir.join(SERVER_CONFIG_FILE),
            r#"{"Indexers":[{"Id":"do-arquivo","Enabled":true}]}"#,
        );
        assert_eq!(
            resolve_jackett_indexers(Some(" yts , 1337x "), &dir),
            vec!["yts".to_string(), "1337x".to_string()]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn volume_ilegivel_ou_ruim_devolve_vazio() {
        // Diretório inexistente: nada de pânico, nada de lista.
        let mut ausente = std::env::temp_dir();
        ausente.push(format!("adom-jackett-ausente-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ausente);
        assert!(resolve_jackett_indexers(None, &ausente).is_empty());

        // JSON inválido e shape inesperado (raiz é array): vazio.
        let dir = fixture("json-ruim");
        write(&dir.join(SERVER_CONFIG_FILE), "{ isso não é json");
        assert!(jackett_indexers_from_config_dir(&dir).is_empty());
        write(&dir.join(SERVER_CONFIG_FILE), r#"[{"Id":"yts"}]"#);
        assert!(jackett_indexers_from_config_dir(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
