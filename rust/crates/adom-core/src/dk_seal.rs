//! Selo AES da `dk` (debrid key): porte de `src/utils/secret-box.ts`.
//!
//! Registrado no crate como `mod dk_seal;` (o `lib.rs` fica a cargo do
//! operador). `config_encoding` reexporta esta superfície, então chamar
//! `config_encoding::seal_dk`/`unseal_dk` continua sendo o caminho público.
//!
//! ## Dependências novas (o `Cargo.toml` é cuidado pelo operador)
//! ```toml
//! aes-gcm = "0.11.1"   # AES-256-GCM (trait `Aead`: saída ct||tag)
//! scrypt  = "0.12.0"   # derivação da chave a partir do RESOLVE_SECRET
//! ```
//!
//! ## Diferença em relação ao Node (assumida, não escondida)
//! O Node faz isso com `crypto.scryptSync` + `crypto.createCipheriv('aes-256-gcm')`,
//! que são primitivas de algorithm standard — portáveis. O que NÃO é portável é
//! a origem do IV: o `seal` do Node usa `randomBytes(12)` de dentro da função.
//! Aqui o nonce é PARÂMETRO, para a função continuar pura e o golden ser
//! determinístico; a camada que chama (NAPI/Node) fornece os 12 bytes aleatórios.
//! O layout do blob é o do TS: `iv(12) || tag(16) || ct`, base64url sem padding,
//! prefixo `enc.v1.`. O trait `Aead` do Rust devolve `ct || tag`, então a tag é
//! realocada para o meio — é o único detalhe de byte order que diferencia os dois.
//! O `log.warn` do `open` (segredo ausente) fica com quem chama: aqui o sinal é
//! `""`, igual ao TS.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use scrypt::Params as ScryptParams;

use crate::js_text::{b64url_decode, b64url_encode};

pub const SEALED_PREFIX: &str = "enc.v1.";
pub const IV_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;
/// Tetos do `runtime.ts`: o `dk` selado é cortado antes de abrir.
pub const DK_MAX_CHARS: usize = 400;
/// Salt fixo: separa domínio, não varia por usuário (não há onde guardá-lo num
/// esquema sem estado). A entropia vem do `RESOLVE_SECRET` do operador.
pub const SECRET_SALT: &[u8] = b"stremio-adom/dk/v1";
/// Padrões do `crypto.scryptSync` do Node (N=2^14, r=8, p=1). O golden ancora o
/// hex da chave derivada, então qualquer mudança aqui quebra na hora.
pub const SCRYPT_LOG_N: u8 = 14;
pub const SCRYPT_R: u32 = 8;
pub const SCRYPT_P: u32 = 1;

pub fn is_sealed(value: &str) -> bool {
    value.starts_with(SEALED_PREFIX)
}

/// `crypto.scryptSync(secret, SALT, 32)` — caro de propósito: o RESOLVE_SECRET
/// costuma ser senha escolhida a dedo, não 32 bytes aleatórios. O Node cacheia o
/// resultado por segredo; aqui a derivação é a cada chamada (o chamador decide o
/// cache — é I/O de CPU, não de rede, e continua sendo função pura).
pub fn derive_dk_key(resolve_secret: &str) -> [u8; 32] {
    let params =
        ScryptParams::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, 32).expect("parametros do Node sao validos");
    let mut key = [0u8; 32];
    scrypt::scrypt(resolve_secret.as_bytes(), SECRET_SALT, &params, &mut key)
        .expect("saida de 32 bytes e compativel com os parametros");
    key
}

/// `seal` do secret-box com nonce EXPLÍCITO (o TS usa `randomBytes(12)`).
/// Sem segredo, sem texto, ou já selado: devolve o próprio valor, como no TS.
pub fn seal_dk(plaintext: &str, resolve_secret: &str, nonce: &[u8; IV_BYTES]) -> String {
    if resolve_secret.is_empty() || plaintext.is_empty() || is_sealed(plaintext) {
        return plaintext.to_string();
    }
    let cipher = Aes256Gcm::new_from_slice(&derive_dk_key(resolve_secret))
        .expect("chave derivada tem 256 bits");
    // `Aead::encrypt` devolve ct||tag; o blob do TS é iv||tag||ct.
    let selado = cipher
        .encrypt(Nonce::from_slice(nonce), plaintext.as_bytes())
        .expect("cifra local com buffer valido nao falha");
    let (ct, tag) = selado.split_at(selado.len() - TAG_BYTES);
    let mut blob = Vec::with_capacity(IV_BYTES + selado.len());
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(tag);
    blob.extend_from_slice(ct);
    format!("{SEALED_PREFIX}{}", b64url_encode(&blob))
}

/// `open` do secret-box. Texto puro passa direto (install URL antigo continua
/// valendo — é o que permite ligar o RESOLVE_SECRET sem quebrar quem já
/// instalou). Falha ao abrir devolve `""`, nunca o blob cru: sem isso um selo
/// corrompido ou de outro segredo viraria uma "API key" literal mandada ao
/// serviço de debrid a cada busca.
pub fn unseal_dk(value: &str, resolve_secret: &str) -> String {
    if !is_sealed(value) {
        return value.to_string();
    }
    if resolve_secret.is_empty() {
        return String::new(); // o TS loga o aviso; quem chama decide logar
    }
    let raw = b64url_decode(&value[SEALED_PREFIX.len()..]);
    if raw.len() <= IV_BYTES + TAG_BYTES {
        return String::new(); // 'blob curto demais'
    }
    let (nonce, resto) = raw.split_at(IV_BYTES);
    let (tag, ct) = resto.split_at(TAG_BYTES);
    let Ok(cipher) = Aes256Gcm::new_from_slice(&derive_dk_key(resolve_secret)) else {
        return String::new();
    };
    let mut payload = ct.to_vec();
    payload.extend_from_slice(tag); // remontar ct||tag para o trait `Aead`
    match cipher.decrypt(Nonce::from_slice(nonce), payload.as_slice()) {
        // O `update(..., 'utf8')` do Node substitui bytes inválidos; lossy é o
        // equivalente honesto em Rust.
        Ok(claro) => String::from_utf8_lossy(&claro).into_owned(),
        Err(_) => String::new(), // tag GCM confere => segredo/blob adulterado
    }
}
