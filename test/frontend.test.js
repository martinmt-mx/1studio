// Funciones del navegador que no dependen del DOM: se extraen del archivo y se prueban con node:vm
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extraer(archivo, nombre) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', archivo), 'utf8');
  const i = src.indexOf(`function ${nombre}(`);
  const j = src.indexOf('\n}\n', i);
  const ctx = {};
  vm.runInNewContext(src.slice(i, j + 2) + `;this.${nombre} = ${nombre};`, ctx);
  return ctx[nombre];
}

test('formatearRango acomoda ":" y "-" mientras escribes solo números', () => {
  const f = extraer('app.js', 'formatearRango');
  const teclear = s => [...s].reduce((v, ch) => f(v + ch), '');
  assert.equal(teclear('000215'), '00:02:15');
  assert.equal(teclear('104350104430'), '10:43:50-10:44:30');
  assert.equal(teclear('0215-0245'), '02:15-02:45');
  assert.equal(f('1:05-1:35'), '1:05-1:35');
});

test('textoParaVoz aplica la pronunciación y escribe los números en palabras', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'largo.js'), 'utf8');
  assert.match(src, /function textoParaVoz\(/);
  assert.match(src, /function enPalabras\(/);
});
