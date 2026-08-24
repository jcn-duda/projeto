'use strict';

const BASE_PROTECTOR_SUFFIXES = [
  'systemads1.com',
  'systemads.net',
  'videosad.net',
  'canalfutebol.com',
];

function hasAllowedHost(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function assertAllowedUrl(value, suffixes, blockedHostDetail = false) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  if (!hasAllowedHost(url.hostname, suffixes)) {
    throw new Error(blockedHostDetail ? `blocked_host:${url.hostname.toLowerCase()}` : 'blocked_host');
  }
  return url;
}

module.exports = { BASE_PROTECTOR_SUFFIXES, hasAllowedHost, assertAllowedUrl };
