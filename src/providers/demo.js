/**
 * Provedor demo: Big Buck Bunny (filme livre) para validar o addon sem Jackett.
 * infoHash público do torrent de demonstração.
 */
async function search({ type, imdbId }) {
  // Big Buck Bunny — IMDb tt1254207
  if (type === 'movie' && imdbId === 'tt1254207') {
    return [
      {
        title: 'Big Buck Bunny 1080p DEMO',
        infoHash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c',
        seeders: 50,
        size: 276134019,
        tracker: 'demo',
      },
    ];
  }
  return [];
}

module.exports = { search, name: 'demo' };
