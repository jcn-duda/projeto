// Build script do napi-rs: emite as variáveis de ambiente que o crate `napi`
// precisa para linkar contra a ABI correta do Node. Sem isso o .node não
// carrega (símbolo faltando ou versão de ABI errada).
extern crate napi_build;

fn main() {
    napi_build::setup();
}
