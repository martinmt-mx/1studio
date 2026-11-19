const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { borrar } = require('./_entorno');
const { partirDescripcion, limpiarNombre, infoArchivo } = require('../lib/util');
const { validarRango } = require('../lib/descargas');
after(borrar);

test('partirDescripcion corta en la primera pregunta y se lleva los emojis pegados', () => {
  const r = partirDescripcion('¿Y si Roma nunca hubiera caído? 🏛️🔥 Un imperio hasta 2026. #Historia');
  assert.equal(r.titulo, '¿Y si Roma nunca hubiera caído? 🏛️🔥');
  assert.equal(r.descripcion, 'Un imperio hasta 2026. #Historia');
});

test('partirDescripcion usa el salto de línea cuando no hay "?" antes', () => {
  const r = partirDescripcion('Título sin pregunta\nDescripción larga');
  assert.deepEqual([r.titulo, r.descripcion], ['Título sin pregunta', 'Descripción larga']);
});

test('partirDescripcion sin corte devuelve todo como título', () => {
  assert.deepEqual(partirDescripcion('Solo una línea'), { completo: 'Solo una línea', titulo: 'Solo una línea', descripcion: '' });
});

test('limpiarNombre deja un nombre de archivo seguro', () => {
  assert.equal(limpiarNombre('@Mi Canal!! 🎮'), 'Mi_Canal');
  assert.equal(limpiarNombre('../../etc/passwd'), 'etc_passwd');
});

test('infoArchivo reconoce los nombres que genera el descargador', () => {
  const i = infoArchivo('creador_demo__20261118-055300.mp4');
  assert.equal(i.creador, '@creador_demo');
});

test('infoArchivo reconoce nombres de FetchV (X/Twitter)', () => {
  const i = infoArchivo('2 Usuario Ejemplo en X_ _Texto del post https___t.co_abc123_ _ X.mp4');
  assert.equal(i.plataforma, 'X');
  assert.equal(i.texto, 'Texto del post');
  assert.match(i.creador, /^@/);
});

test('validarRango acepta tramos válidos y los pasa al formato de yt-dlp', () => {
  assert.equal(validarRango(''), null);
  assert.equal(validarRango('10:43:50-10:44:30'), '*10:43:50-10:44:30');
  assert.equal(validarRango('02:15 - 02:45'), '*02:15-02:45');
});

test('validarRango rechaza fin antes del inicio y tramos de más de 15 min', () => {
  assert.throws(() => validarRango('10:44:01-01:44:51'), /después del inicio/);
  assert.throws(() => validarRango('00:00-20:00'), /15 minutos/);
  assert.throws(() => validarRango('hola'), /Rango inválido/);
});
