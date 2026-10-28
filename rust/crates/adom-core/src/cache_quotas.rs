//! Porte puro de `src/utils/cache-quotas.ts`: política de cotas do cache
//! multi-nível, sem estado.
//!
//! A regra que não pode voltar atrás: a repartição por namespace acontece
//! ANTES de qualquer despejo global. Reintroduzir o despejo global antes da
//! repartição foi bug real — um burst de `dlmag` desalojava `streams`.
//!
//! O L1 (o `Map`/LRU `store`) e os contadores por namespace pertencem ao motor
//! de cache (`src/utils/cache.ts`), que ainda não foi portado. Por isso ficam de
//! fora deste porte [`increment_namespace`], [`remove_from_store`] e
//! [`quota_overflow`] do fonte: elas recebem o `store` e os contadores como
//! parâmetro e só farão sentido quando o LRU existir em Rust. O que vive aqui é
//! o contrato NUMÉRICO e a aritmética do universo, que é o que quebrou em
//! produção.
//!
//! A conta que tem que fechar NÃO é a soma de [`QUOTAS`]: `quota_for` devolve
//! `__default` para todo nome sem entrada própria, então cada namespace
//! versionado sem cota nomeada soma mais 500. O universo real é a união dos dois
//! registros ([`QUOTAS`] + [`crate::cache_keys::NAMESPACE_VERSIONS`]) mais o
//! balde `__default` das chaves sem `:`. Hoje: 92.221 + 500 = 92.721 entradas
//! alcançáveis contra o teto de 93.000 — folga de 279, MENOS de um balde de 500:
//! o próximo namespace nomeado já encosta no teto (a folga era 779 antes do
//! `adhold`). Teto IGUAL OU ABAIXO da soma reintroduz o despejo global antes da
//! repartição por namespace. Foi a falta
//! dessa guarda que deixou `dinv`, `harvest`, `notify` e `seed` vivendo de
//! fallback até a soma real passar do teto em 1.051 (medido no container: todos
//! os namespaces dentro da própria cota, store parado em 91.000 com
//! `cache.evicted = 1051` e `streams` reduzido a 949 de 2.000).
//!
//! DÍVIDA CONHECIDA — não "uniformizar" sem ler `src/utils/cache-db.ts`:
//! `dlmag`, `tmdb`, `meta`, `indexer-status` e `tmdbc` têm cota mas NÃO estão em
//! `NAMESPACE_VERSIONS`, porque montam a chave sem segmento de versão (ex.:
//! `tmdbc:` em `src/utils/tmdb.ts`) e o `maintain()` do boot apaga todo `ns:%`
//! que não bata com `ns:<versão>:%`. Registrá-los na lista versionada sem migrar
//! as chaves primeiro custa o cache deles no próximo restart.

use crate::cache_keys::NAMESPACE_VERSIONS;

/// Balde dos nomes sem cota própria (e das chaves sem `:`).
pub const DEFAULT_NAMESPACE: &str = "__default";

/// Teto global do L1 (`MAX_ENTRIES` no fonte; chamado de "teto global" no plano).
/// Precisa ficar ESTRITAMENTE acima de [`universe_total`] — ver o cabeçalho.
pub const MAX_ENTRIES: usize = 93_000;

/// `(namespace, cota)` na ordem exata do objeto TS. Números são contrato: cada
/// um tem motivo de memória/população no fonte, e o golden prende os 28.
pub const QUOTAS: &[(&str, usize)] = &[
    // Lista pronta para o cliente: ~27 KB por entrada no teto de itens atual.
    ("streams", 2_000),
    // Tem cota alta mas a chave não é versionada (ver a dívida no cabeçalho).
    ("dlmag", 4_000),
    ("tmdb", 500),
    ("tmdbc", 500),
    ("meta", 500),
    // Resultado bruto por indexer: cada entrada pode chegar a ~100 KB, então é
    // o maior balde individual em bytes (pior caso ~79 MB).
    ("raw", 800),
    ("davail", 1_000),
    // Histórico durável por hash: entrada minúscula (~400 B), 50.000 ≈ 19 MB.
    ("mag", 50_000),
    // Um único agregado persistente do MagnetDB.
    ("mag_meta", 1),
    ("rdc", 14_000),
    // Fila do warmer: uma chave só carrega o array inteiro.
    ("rdq", 500),
    // Cache por título do Torrentio, TTL ~6h.
    ("rdt", 2_500),
    // Índice de releases (~14,7 KB por chave): 2.000 ≈ 29 MB. O plano prometeu
    // 4.000 e o código entregou 2.000 — não inventar 4.000 aqui.
    ("idx", 2_000),
    // Marcadores mortos + registros `sup:` + por OBRA (`o:<sha>`), dobrado na
    // Fase 2 para 4.000.
    ("autofetch", 4_000),
    ("indexer-status", 200),
    ("cfg", 50),
    ("adprot", 2_000),
    // Hold curto do Chupim (`adhold:v1`): um registro minúsculo por download em
    // voo, TTL de horas — dezenas de chaves, nunca o acervo.
    ("adhold", 500),
    ("adsub", 1_000),
    ("adrm", 500),
    ("fsz", 3_000),
    ("vres", 1_000),
    ("tsz", 1_000),
    // Estes quatro existiam versionados sem entrada própria e pagavam o fallback
    // de 500 cada — foi o buraco que estourou o teto. População medida no L2:
    // 0 / 0 / 2 / 2.
    ("dinv", 50),
    ("notify", 100),
    ("seed", 20),
    ("harvest", 500),
    // Fallback, contado por último no universo (ver [`universe`]).
    ("__default", 500),
];

/// Cota DECLARADA de um namespace (`None` quando não tem entrada própria) —
/// lookup cru, sem fallback, para o `__default` não ser duplicado aqui.
fn declared(namespace: &str) -> Option<usize> {
    QUOTAS
        .iter()
        .find(|(ns, _)| *ns == namespace)
        .map(|(_, cota)| *cota)
}

/// Cota do balde `__default`, lida da própria tabela. O número mora só em
/// [`QUOTAS`]: duplicá-lo é como o comentário do fonte ficou mentindo sozinho.
pub fn default_quota() -> usize {
    declared(DEFAULT_NAMESPACE).expect("`__default` precisa ter cota em QUOTAS")
}

/// Cota declarada de um namespace, ou o fallback `__default`.
///
/// Semântica do `??` do fonte, não do `||`: uma cota declarada `0` — escrita por
/// quem quer um namespace que NÃO retém nada — precisa valer 0, senão viraria
/// 500 em silêncio. Nome desconhecido continua no `__default`.
pub fn quota_for(namespace: &str) -> usize {
    declared(namespace).unwrap_or_else(default_quota)
}

/// Namespace de uma chave: tudo antes do primeiro `:`, ou `__default` quando a
/// chave não tem `:`. Não corta versão nem valida nada — igual ao fonte.
pub fn namespace_for(key: &str) -> &str {
    match key.find(':') {
        Some(indice) => &key[..indice],
        None => DEFAULT_NAMESPACE,
    }
}

/// Universo real de cotas: a união dos nomes de [`QUOTAS`] com os de
/// [`NAMESPACE_VERSIONS`], SEM o `__default` (contado à parte em
/// [`universe_total`]), em ordem lexicográfica para ser comparável.
pub fn universe() -> Vec<&'static str> {
    let mut nomes: Vec<&'static str> = QUOTAS
        .iter()
        .map(|(ns, _)| *ns)
        .chain(NAMESPACE_VERSIONS.iter().map(|(ns, _)| *ns))
        .filter(|ns| *ns != DEFAULT_NAMESPACE)
        .collect();
    nomes.sort_unstable();
    nomes.dedup();
    nomes
}

/// Nomes do universo sem cota explícita — cada um paga [`default_quota()`] e foi
/// assim que a conta real passou do teto sem nenhum teste reclamar.
pub fn namespaces_without_explicit_quota() -> Vec<&'static str> {
    universe()
        .into_iter()
        .filter(|ns| declared(ns).is_none())
        .collect()
}

/// Soma do universo mais o balde `__default`: o número que o teto tem que
/// deixar abaixo de si (ver o cabeçalho do módulo).
pub fn universe_total() -> usize {
    universe().iter().map(|ns| quota_for(ns)).sum::<usize>() + default_quota()
}

/// Quantos nomes o teto está protegendo (sem contar o `__default`).
pub fn universe_len() -> usize {
    universe().len()
}

/// Folga do teto: `MAX_ENTRIES - universe_total()`.
pub fn headroom() -> isize {
    MAX_ENTRIES as isize - universe_total() as isize
}

/// Guarda de consistência das cotas — os dois asserts do teste TS
/// `test/cache-namespaces.test.ts`:
/// 1. nenhum namespace versionado pode viver de fallback;
/// 2. a soma do universo tem que ficar ESTRITAMENTE abaixo do teto global.
///
/// A segunda com `<` e não com `<=` é intencional: teto igual à soma já
/// reintroduz o despejo global antes da repartição por namespace.
pub fn validate_quotas() -> bool {
    namespaces_without_explicit_quota().is_empty() && universe_total() < MAX_ENTRIES
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache_keys::prefix;

    #[test]
    fn teto_e_soma_do_universo_batem_com_o_producao() {
        assert_eq!(MAX_ENTRIES, 93_000);
        assert_eq!(universe_total(), 92_721);
        assert_eq!(headroom(), 279);
        assert_eq!(universe_len(), 27);
        assert!(validate_quotas());
    }

    #[test]
    fn nenhum_namespace_versionado_vive_de_fallback() {
        // Reintroduzir `dinv`/`notify`/`seed`/`harvest` sem cota nomeada era
        // exatamente este assert caindo.
        assert_eq!(namespaces_without_explicit_quota(), Vec::<&str>::new());
        for (ns, _) in NAMESPACE_VERSIONS {
            assert!(
                QUOTAS.iter().any(|(nome, _)| nome == ns),
                "namespace versionado sem cota explícita: {ns}"
            );
        }
    }

    #[test]
    fn quota_for_usa_fallback_so_para_nome_desconhecido() {
        assert_eq!(default_quota(), 500, "o balde padrão é o número do fonte");
        assert_eq!(quota_for("mag_meta"), 1);
        assert_ne!(
            quota_for("mag_meta"),
            default_quota(),
            "cota pequena não vira fallback"
        );
        assert_eq!(quota_for("inexistente"), default_quota());
        assert_eq!(quota_for(DEFAULT_NAMESPACE), default_quota());
        // `muri` foi aposentado: sai da tabela e cai no fallback.
        assert_eq!(quota_for("muri"), default_quota());
    }

    #[test]
    fn namespace_for_espelha_o_primeiro_dois_pontos() {
        assert_eq!(namespace_for("streams:v21:movie:tt0111111"), "streams");
        assert_eq!(namespace_for("sem-dos-pontos"), DEFAULT_NAMESPACE);
        assert_eq!(namespace_for(""), DEFAULT_NAMESPACE);
        // Dois-pontos na posição 0: namespace vazio (não é `__default`), e a
        // busca de cota cai no fallback — comportamento do `slice(0, 0)` do TS.
        assert_eq!(namespace_for(":x"), "");
        assert_eq!(quota_for(namespace_for(":x")), default_quota());
        assert_eq!(namespace_for("a:b:c"), "a");
    }

    #[test]
    fn toda_chave_de_prefixo_versionado_volta_ao_proprio_namespace() {
        // Propriedade estrutural: `cache_key(ns, ..)` lido por `namespace_for`
        // devolve `ns` — senão a cota do namespace nunca seria aplicada.
        for (ns, _) in NAMESPACE_VERSIONS {
            let chave = format!("{}parte:outra", prefix(ns));
            assert_eq!(
                namespace_for(&chave),
                *ns,
                "prefixo de {ns} não casa com o namespace"
            );
        }
    }
}
