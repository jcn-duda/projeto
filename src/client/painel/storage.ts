// Persistência local do painel com fail-safe.
//
// `localStorage` pode existir e mesmo assim LANÇAR: navegador em modo privado,
// cookies/site-data bloqueados ou política corporativa jogam SecurityError no
// acesso. O painel lê o token no topo do módulo — sem esta guarda, uma exceção
// aqui derruba o IMPORT inteiro e a página não carrega nem para mostrar o
// formulário do token. Toda leitura/escrita passa por um try/catch: sem storage
// a preferência simplesmente não persiste, o painel continua funcional.

export function readStored(key: string, fallback: string): string {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const value = localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // Storage bloqueado/cheio: a preferência vive só em memória nesta sessão.
  }
}
