//! Porte puro de `src/utils/cache-keys.ts`: fonte única de verdade da versão de
//! cada namespace versionado do cache.
//!
//! Mapeamento do fonte TS:
//! - `NAMESPACE_VERSIONS` (objeto congelado) vira a constante [`NAMESPACE_VERSIONS`],
//!   array de `(nome, versão)` na MESMA ordem de inserção — `Object.keys` de chave
//!   string não numérica devolve ordem de inserção, então o golden compara byte a
//!   byte e a ordem é parte do contrato.
//! - `prefix(ns)` vira [`prefix`], devolvendo `&'static str` montado em tempo de
//!   compilação por `concat!` (zero alocação, mesma assinatura do fonte).
//! - `${prefix('x')}resto` dos chamadores vira [`cache_key`].
//! - `magMetaCountsKey()` vira [`mag_meta_counts_key`].
//!
//! DIVERGÊNCIA DELIBERADA (única): para namespace ausente da tabela o TS monta
//! `ns:undefined:` — um prefixo fantasma que ocuparia o balde padrão do cache.
//! Aqui a string é VAZIA (`prefix` devolve `""`, `cache_key` devolve `String::new()`):
//! chamar função com namespace inexistente é erro de programação, e o vazio é o
//! único valor que nenhum namespace produz. O golden NÃO cobre namespace
//! ausente (não há o que paridade ter com um bug); a divergência é presa pelos
//! testes próprios de [`prefix`]/[`cache_key`] neste arquivo.
//!
//! Os comentários de história do fonte (por que cada `vN` existe) ficam no
//! `.ts`, que é ainda o runtime. Aqui só o que muda a leitura do número.

/// Tabela interna: declara `(namespace => versão)` e gera, em tempo de
/// compilação, tanto a tabela de versões quanto a de prefixos (`concat!` só
/// aceita literais — por isso é macro, não um `const` escrito à mão).
macro_rules! namespace_table {
    ($($ns:literal => $versao:literal),+ $(,)?) => {
        /// `(namespace, versão)` na ordem exata do objeto TS.
        pub const NAMESPACE_VERSIONS: &[(&str, &str)] = &[ $( ($ns, $versao) ),* ];

        /// `(namespace, prefixo)` com o prefixo já concatenado: `<ns>:<versão>:`.
        const PREFIXES: &[(&str, &str)] = &[ $( ($ns, concat!($ns, ":", $versao, ":")) ),* ];
    };
}

namespace_table! {
    // Lista de streams pronta para o cliente. Bumpa quando muda o que a lista
    // CONTÉM ou como ela é ROTULADA (classificador BR/dublado, corte, blobs no
    // título): o rótulo errado vive no TTL e não se corrige só com o reboot.
    // Histórico completo de v1..v21 no fonte TS.
    "streams"     => "v21",
    // Fila/estado do autofetch: v3 roteia a release pela temporada/episódio que
    // o título dela declara; v14 acompanha o classificador de áudio do idx.
    "autofetch"   => "v3",
    // Resultado bruto por indexer/scraper (era `raw1:`, formato sem versão).
    "raw"         => "v1",
    // Disponibilidade por adapter/conta.
    "dinv"        => "v1",
    // Disponibilidade 0/1 por hash.
    "davail"      => "v1",
    // Banco de magnets: histórico durável por hash.
    "mag"         => "v1",
    // Agregado O(1) do MagnetDB; única entrada, ver [`mag_meta_counts_key`].
    "mag_meta"    => "v1",
    // Ledger do Real-Debrid, SÓ por hash. Em v2 o cache por título do Torrentio
    // migrou para `rdt` e a fila do warmer para `rdq`: os três conviviam sob o
    // mesmo prefixo `rdc:v1:` competindo por cota.
    "rdc"         => "v2",
    // Cache por título da resposta do Torrentio (`rdt:v1:trt:<type>:<id>`).
    "rdt"         => "v1",
    // Fila persistente do rdWarmer (`rdq:v1:wq`): trabalho pendente, não histórico.
    "rdq"         => "v1",
    // Índice de releases por obra. Bumpa junto com o classificador persistido
    // (`dubbed`/`isBr`/qualidade), porque o merge do índice é OR-aderente: uma
    // vez marcado, sempre marcado — sem o bump o rótulo errado vive semanas.
    "idx"         => "v14",
    // Colheita: `harvest:v1:seen:<sha>` cresce por obra.
    "harvest"     => "v1",
    "notify"      => "v1",
    // Duas chaves fixas (`cohort`, `last`).
    "seed"        => "v1",
    "cfg"         => "v1",
    // Proteção durável dos BR no AllDebrid (`adprot:v1:<adapter>:<conta>:<hash>`).
    "adprot"      => "v1",
    // Posse dos uploads do próprio addon (`adsub:v1:<conta>:<hash>`).
    "adsub"       => "v1",
    // Anti-reenchimento do AllDebrid (`adrm:v1:<conta>:<hash>`).
    "adrm"        => "v1",
    // Arquivos de vídeo por hash (`fsz:v1:<hash>`).
    "fsz"         => "v1",
    // Tamanho TOTAL do torrent por hash (`tsz:v1:<hash>); separado do `fsz`
    // porque não é lista de arquivos.
    "tsz"         => "v1",
    // Resolução medida no cabeçalho do vídeo (`vres:v1:<hash>:<digest do caminho>`).
    "vres"        => "v1",
}

/// Prefixos de formatos aposentados, descartados numa passada idempotente no
/// boot. `raw1:`/`dinv1:` eram a versão colada no nome (sem `<ns>:<versão>:`).
/// `muri:` saiu do cache (a URI por hash passou a viver no banco permanente), e
/// `tsj:` era o julgamento do runtime Jev. Sair de [`NAMESPACE_VERSIONS`]
/// sozinho NÃO limpa o que já está no disco.
pub const LEGACY_PREFIXES: &[&str] = &["raw1:", "dinv1:", "muri:", "tsj:"];

/// Versão declarada de um namespace (`'v21'` em `streams: 'v21'`).
pub fn namespace_version(namespace: &str) -> Option<&'static str> {
    NAMESPACE_VERSIONS
        .iter()
        .find(|(ns, _)| *ns == namespace)
        .map(|(_, versao)| *versao)
}

/// Namespace que tem versão declarada (o inverso do balde `__default`).
pub fn is_versioned(namespace: &str) -> bool {
    namespace_version(namespace).is_some()
}

/// `<ns>:<versão>:` — inclusive o dois-pontos final, como no template do fonte.
/// Devolve `""` para namespace ausente da tabela (ver a divergência no cabeçalho).
pub fn prefix(namespace: &str) -> &'static str {
    PREFIXES
        .iter()
        .find(|(ns, _)| *ns == namespace)
        .map(|(_, p)| *p)
        .unwrap_or("")
}

/// Monta `<ns>:<versão>:<parte>:<parte>…`, a forma como os chamadores do TS
/// compunham a chave (`${prefix('autofetch')}dead:${adapter}:${conta}:${hash}`).
///
/// Não normaliza nada: `toLowerCase()` do infoHash e o recorte do título são do
/// chamador (ficam nos módulos que portam aqueles chamadores). Sem partes, devolve
/// só o prefixo — o TS fazia o mesmo. Devolve vazio se o namespace não existe.
pub fn cache_key(namespace: &str, parts: &[&str]) -> String {
    let head = prefix(namespace);
    if head.is_empty() {
        return String::new();
    }
    if parts.is_empty() {
        return head.to_string();
    }
    let mut key = String::with_capacity(head.len() + parts.len() * 16);
    key.push_str(head);
    for (i, parte) in parts.iter().enumerate() {
        if i > 0 {
            key.push(':');
        }
        key.push_str(parte);
    }
    key
}

/// Única entrada do namespace `mag_meta`: contagens O(1) do banco de magnets.
pub fn mag_meta_counts_key() -> String {
    cache_key("mag_meta", &["counts"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_inclui_o_dois_pontos_final() {
        assert_eq!(prefix("streams"), "streams:v21:");
        assert_eq!(prefix("idx"), "idx:v14:");
        assert_eq!(prefix("rdc"), "rdc:v2:");
        assert_eq!(namespace_version("rdc"), Some("v2"));
        assert_eq!(namespace_version("muri"), None);
    }

    #[test]
    fn namespace_inexistente_devolve_vazio_nao_um_prefixo_fantasma() {
        // Divergência deliberada documentada no cabeçalho: o TS montaria
        // `inexistente:undefined:`, que cairia no balde `__default` do cache.
        assert_eq!(prefix("inexistente"), "");
        assert_eq!(cache_key("inexistente", &["a", "b"]), "");
        assert!(!is_versioned("muri"));
    }

    #[test]
    fn cache_key_compoe_como_o_template_ts() {
        assert_eq!(
            cache_key("autofetch", &["dead", "jackett", "1", "aa4f"]),
            "autofetch:v3:dead:jackett:1:aa4f"
        );
        assert_eq!(
            cache_key("vres", &["hash", "digest"]),
            "vres:v1:hash:digest"
        );
        assert_eq!(
            cache_key("rdt", &["trt", "movie", "tt0111111"]),
            "rdt:v1:trt:movie:tt0111111"
        );
        // Sem partes: só o prefixo (o TS fazia `${prefix('x')}`).
        assert_eq!(cache_key("raw", &[]), "raw:v1:");
        assert_eq!(mag_meta_counts_key(), "mag_meta:v1:counts");
    }

    #[test]
    fn tabela_nao_duplica_namespace() {
        let mut nomes: Vec<&str> = NAMESPACE_VERSIONS.iter().map(|(ns, _)| *ns).collect();
        let total = nomes.len();
        nomes.sort_unstable();
        nomes.dedup();
        assert_eq!(nomes.len(), total, "namespace duplicado na tabela");
        // Os aposentados não podem voltar para a tabela versionada.
        for prefixado in LEGACY_PREFIXES {
            let nome = prefixado.trim_end_matches(':');
            assert!(
                !is_versioned(nome),
                "{nome} foi aposentado e não pode ter versão"
            );
        }
    }
}
