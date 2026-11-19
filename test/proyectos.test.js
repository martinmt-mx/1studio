const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { borrar, appFalsa, expressFalso } = require('./_entorno');
const { parsearGuion, grupos, srt } = require('../lib/proyectos')({ app: appFalsa, express: expressFalso });
after(borrar);

const guion = {
  titulo: 'Juego A vs Juego B',
  miniatura: '10 AÑOS DESPUÉS',
  secciones: [
    { id: 1, titulo: 'Intro', narracion: 'Hola, esto es una prueba.', tomas: [{ etiqueta: 'B', busqueda: ['look at this'] }] },
    { id: 2, titulo: 'El agua', narracion: 'El agua cambió mucho.', plantilla: 'comparacion', tomas: [{ etiqueta: 'A' }, { etiqueta: 'B' }] },
  ],
  shorts: [{ seccion: 2, gancho: 'El agua ya no es plana' }],
};

test('parsearGuion acepta el JSON aunque venga dentro de un bloque ```json', () => {
  const p = parsearGuion('```json\n' + JSON.stringify(guion) + '\n```');
  assert.equal(p.titulo, 'Juego A vs Juego B');
  assert.equal(p.secciones.length, 2);
  assert.equal(p.secciones[0].plantilla, 'clip');
  assert.equal(p.secciones[1].plantilla, 'comparacion');
  assert.equal(p.secciones[1].tomas.length, 2);
  assert.equal(p.secciones[1].shortInfo.gancho, 'El agua ya no es plana');
});

test('parsearGuion detecta que pegaste la plantilla del prompt en vez del guion', () => {
  const plantilla = { titulo: 'x', secciones: [{ narracion: 'Texto exacto que voy a narrar' }] };
  assert.throws(() => parsearGuion(JSON.stringify(plantilla)), /plantilla/);
});

test('parsearGuion rechaza JSON sin secciones', () => {
  assert.throws(() => parsearGuion('{"titulo":"x"}'), /secciones/);
});

const palabras = 'Esto es una prueba de subtítulos, con varias palabras para cortar bien.'.split(' ')
  .map((w, i) => ({ w, s: 10 + i * 0.4, e: 10 + i * 0.4 + 0.35 }));

test('grupos arma subtítulos cortos con tiempos relativos a la sección', () => {
  const g = grupos(palabras, 10, 6);
  assert.ok(g.length >= 4);
  assert.equal(g[0].a, 0);
  for (const x of g) {
    assert.ok(x.texto.split(' ').length <= 3, x.texto);
    assert.ok(x.b > x.a);
    assert.ok(x.b <= 6.0001);
  }
  // corta después de la coma
  assert.ok(g.some(x => x.texto.endsWith(',')));
});

test('srt genera bloques numerados con el formato correcto', () => {
  const s = srt(palabras);
  assert.match(s, /^1\n00:00:10,000 --> 00:00:\d\d,\d{3}\n/);
  assert.ok(!/\n\n\n/.test(s));
});
