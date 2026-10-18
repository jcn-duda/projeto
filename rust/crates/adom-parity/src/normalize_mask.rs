use super::NormalizeOptions;

/// Aplica as máscaras de URL. Pública para os testes e para o CLI.
pub fn mask_url(raw: &str, options: &NormalizeOptions) -> String {
    let mut text = raw.to_string();
    if let Some(base) = &options.base_url {
        text = replace_base(&text, base);
    }
    if options.mask_origin {
        text = mask_auto_origin(&text);
    }
    if let Some(segment) = &options.config_segment {
        text = mask_config_segment(&text, segment);
    }
    if options.mask_sig {
        text = mask_sig_param(&text);
    }
    text
}

fn replace_base(text: &str, base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.is_empty() {
        return text.to_string();
    }
    if text == base {
        return "{{base}}".to_string();
    }
    if let Some(rest) = text.strip_prefix(base) {
        if rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#') {
            return format!("{{{{base}}}}{rest}");
        }
    }
    text.to_string()
}

/// `url`/`externalUrl` só apontam para o addon por contrato; qualquer origem
/// http(s) nesses campos vira `{{base}}`. O corpus já grava `{{base}}`, então
/// a operação é idempotente.
fn mask_auto_origin(text: &str) -> String {
    let rest = if let Some(rest) = text.strip_prefix("http://") {
        rest
    } else if let Some(rest) = text.strip_prefix("https://") {
        rest
    } else {
        return text.to_string();
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if authority_end == 0 {
        return text.to_string();
    }
    let suffix = &rest[authority_end..];
    format!("{{{{base}}}}{suffix}")
}

fn mask_config_segment(text: &str, segment: &str) -> String {
    let segment = segment.trim_matches('/');
    if segment.is_empty() {
        return text.to_string();
    }
    text.replace(&format!("/{segment}/"), "/{{config}}/")
}

/// Mascara o valor de `sig` preservando os demais parâmetros da query.
fn mask_sig_param(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'?' | b'&' => {
                out.push(bytes[index] as char);
                index += 1;
                let name_start = index;
                while index < bytes.len() && !matches!(bytes[index], b'=' | b'&' | b'#') {
                    index += 1;
                }
                let name = &text[name_start..index];
                if name == "sig" && bytes.get(index) == Some(&b'=') {
                    out.push_str(name);
                    out.push('=');
                    index += 1;
                    while index < bytes.len() && !matches!(bytes[index], b'&' | b'#') {
                        index += 1;
                    }
                    out.push_str("{{sig}}");
                } else {
                    out.push_str(name);
                }
            }
            _ => {
                let start = index;
                while index < bytes.len() && !matches!(bytes[index], b'?' | b'&') {
                    index += 1;
                }
                out.push_str(&text[start..index]);
            }
        }
    }
    out
}
