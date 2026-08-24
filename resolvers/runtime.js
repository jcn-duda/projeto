'use strict';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

function envNumber(name, fallback) {
  return Number(process.env[name] || fallback);
}

function trimUrl(value) {
  return String(value || '').replace(/\/$/, '');
}

function parseHost(urlString) {
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function parseExtraProtectors(envVal) {
  if (!envVal || !String(envVal).trim()) return [];
  return String(envVal).split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
}

module.exports = { USER_AGENT, envNumber, trimUrl, parseHost, parseExtraProtectors };
