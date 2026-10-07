#!/usr/bin/env node
/* Servidor estático mínimo, sin dependencias, para abrir el juego por HTTP.
   Abrir el HTML con doble clic (file://) también funciona; esto solo hace falta
   si tu navegador bloquea algo por el origen `file://`.

   Uso:  node tools/serve.js [puerto]      ->  http://localhost:8080 */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = +(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/pokemon-scale-guesser.html';

  /* nunca servir fuera de ROOT */
  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('403');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    }).end(buf);
  });
}).listen(PORT, () => {
  console.log('sirviendo ' + ROOT);
  console.log('-> http://localhost:' + PORT + '/');
});
