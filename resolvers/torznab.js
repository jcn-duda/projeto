'use strict';

// Os três feeds usam as mesmas capacidades; só o nome exibido é do profile.
function capsXml(title) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="${title}" version="1.0"/>
  <limits max="100" default="100"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <tv-search available="yes" supportedParams="q,season,ep"/>
    <movie-search available="yes" supportedParams="q"/>
  </searching>
  <categories>
    <category id="2000" name="Movies"/>
    <category id="5000" name="TV"/>
  </categories>
</caps>`;
}

module.exports = { capsXml };
