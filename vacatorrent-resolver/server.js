// Shim de compatibilidade: consumidores e o carregador embutido mantêm o caminho histórico.
// O profile lê as envs no boot. Recarregá-lo quando este shim for recarregado
// preserva o contrato histórico para processos que aplicam a configuração antes
// de iniciar cada resolvedor, sem reabrir porta nem afrouxar a allowlist.
const profilePath = require.resolve('../resolvers/profiles/vacatorrent');
delete require.cache[profilePath];
const resolver = require(profilePath);

if (require.main === module) {
  resolver.createServer().listen(Number(process.env.PORT || 8704), '0.0.0.0', () => {
    console.log(`vacatorrent-resolver :${process.env.PORT || 8704} — torznab em /api, fonte ${resolver.siteSelector.url()} (failover: ${resolver.siteSelector.hosts().join(', ')})`);
  });
}

module.exports = resolver;