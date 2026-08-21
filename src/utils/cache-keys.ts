// Fonte única de verdade para a versão de cada namespace versionado do cache.
// Módulo puro, sem require: quem monta chave pode importá-lo sem arrastar o
// `cache.js` (que abre SQLite e agenda timer no require).
//
// Namespaces cuja chave é `<ns>:<versão>:<resto>`. Bumpar AQUI é o que invalida
// o formato antigo: o loadFromDisk apaga do disco tudo que não bate, em vez de
// deixar a versão morta ocupando cota até expirar. Antes a versão vivia em dois
// lugares e a do descarte ficou parada na v3 enquanto a chave já ia na v5.
// streams v6: a guarda de ano pelo dn= do magnet (remake ≠ clássico) muda o
// resultado do filtro — listas antigas com obra errada não podem sobreviver
// ao TTL. idx v2: as releases gravadas sem essa prova morrem no boot e são
// regravadas já filtradas.
const NAMESPACE_VERSIONS = Object.freeze({
  streams: 'v6',
  autofetch: 'v3',
  raw: 'v1',
  dinv: 'v1',
  davail: 'v1',
  mag: 'v1',
  idx: 'v2',
  harvest: 'v1',
});

// Prefixos de formatos aposentados, apagados uma vez no boot. `raw1:` e
// `dinv1:` eram a versão colada no nome (sem `<ns>:<versão>:`); ao migrar para
// `raw:v1:` / `dinv:v1:` os antigos virariam namespaces órfãos ocupando a cota
// padrão para sempre.
const LEGACY_PREFIXES = Object.freeze(['raw1:', 'dinv1:']);

const prefix = (ns: keyof typeof NAMESPACE_VERSIONS) => `${ns}:${NAMESPACE_VERSIONS[ns]}:`;

export { NAMESPACE_VERSIONS, LEGACY_PREFIXES, prefix };
