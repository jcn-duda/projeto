'use strict';

function createFlareSessions() {
  const sessions = new Map();
  return {
    get(hostname) {
      const hit = sessions.get(hostname);
      return hit && hit.expiresAt > Date.now() ? hit : null;
    },
    set(hostname, session) { sessions.set(hostname, session); },
    clear() { sessions.clear(); },
    sessions,
  };
}

module.exports = { createFlareSessions };
