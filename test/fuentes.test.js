const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ, borrar, appFalsa } = require('./_entorno');

// una fuente ya transcrita en la biblioteca
const dir = path.join(RAIZ, 'Gaming', 'fuentes', 'fuente-demo-0001');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'fuente.json'), JSON.stringify({ id: 'fuente-demo-0001', url: 'https://www.youtube.com/watch?v=demo', titulo: 'Directo de prueba', canal: 'Demo', estado: 'listo', creado: '1' }));
fs.writeFileSync(path.join(dir, 'transcripcion.json'), JSON.stringify({ segmentos: [
  { s: 0, e: 3, t: 'hola chat bienvenidos' },
  { s: 3, e: 6, t: 'vamos a manejar un rato' },
  { s: 6, e: 9, t: 'miren cómo se mueve el agua' },
  { s: 9, e: 12, t: 'las olas están increíbles' },
  { s: 60, e: 63, t: 'ahí viene la policía' },
] }));
const { buscar, parseJson3, parseVtt, elegirSubs } = require('../lib/fuentes')({ app: appFalsa });
after(borrar);

test('buscar encuentra el momento exacto aunque la frase esté repartida', () => {
  const hits = buscar(['cómo se mueve el agua'], null);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].t, 6);
  assert.match(hits[0].texto, /agua/);
});

test('buscar ignora acentos y mayúsculas', () => {
  assert.equal(buscar(['POLICIA'], null)[0].t, 60);
});

test('buscar no devuelve nada si no hay coincidencias', () => {
  assert.deepEqual(buscar(['helicóptero'], null), []);
});

test('parseJson3 convierte los subtítulos de YouTube a segmentos', () => {
  const segs = parseJson3(JSON.stringify({ events: [{ tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'hola ' }, { utf8: 'mundo' }] }, { tStartMs: 4000 }] }));
  assert.deepEqual(segs, [{ s: 1.5, e: 3.5, t: 'hola mundo' }]);
});

test('parseVtt lee WebVTT y quita duplicados consecutivos', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nhola <c>mundo</c>\n\n00:00:02.500 --> 00:00:03.000\nhola mundo\n\n01:00:00.000 --> 01:00:01.000\nadiós';
  const segs = parseVtt(vtt);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].s, 3600);
});

test('elegirSubs prefiere subtítulos manuales y luego los automáticos originales', () => {
  assert.deepEqual(elegirSubs({ language: 'es', subtitles: { es: [] }, automatic_captions: { 'en-orig': [] } }), { lang: 'es', auto: false });
  assert.deepEqual(elegirSubs({ automatic_captions: { 'es-orig': [], en: [] } }), { lang: 'es-orig', auto: true });
  assert.equal(elegirSubs({}), null);
});
