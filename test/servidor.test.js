// Prueba de humo: el servidor arranca, sirve la página y responde la API principal
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { borrar } = require('./_entorno');
const { app } = require('../server');

let srv, base;
after(() => { srv?.close(); borrar(); });

test('arranca y sirve el tablero', async () => {
  await new Promise(r => { srv = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /1Studio/);
});

test('GET /api/estado trae los dos canales y la cola de trabajos', async () => {
  const e = await (await fetch(base + '/api/estado')).json();
  assert.ok(e.canales.ucronia && e.canales.gtavi);
  assert.ok(Array.isArray(e.jobs));
});

test('GET /api/fuentes y /api/proyectos responden listas', async () => {
  assert.ok(Array.isArray(await (await fetch(base + '/api/fuentes')).json()));
  assert.ok(Array.isArray(await (await fetch(base + '/api/proyectos')).json()));
});

test('las rutas validan entradas y responden errores en JSON', async () => {
  const r = await fetch(base + '/api/clips/descargar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'no-es-url' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /URL/);
});
