'use strict';

const http = require('node:http');

function createServer(handler) {
  return http.createServer(handler);
}

function reply(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

module.exports = { createServer, reply };
