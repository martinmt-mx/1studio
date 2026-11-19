// Entorno aislado para las pruebas: carpetas de trabajo dentro de .test_tmp (se borra al final)
const path = require('path');
const fs = require('fs');
const RAIZ = path.join(__dirname, '..', '.test_tmp');
process.env.CARPETA_HISTORIAS = '.test_tmp/Historias';
process.env.CARPETA_GAMING = '.test_tmp/Gaming';
const borrar = () => fs.rmSync(RAIZ, { recursive: true, force: true });
// app de Express falsa: los módulos registran rutas, aquí solo se ignoran
const appFalsa = new Proxy({}, { get: () => () => {} });
const expressFalso = { raw: () => (_req, _res, next) => next?.() };
module.exports = { RAIZ, borrar, appFalsa, expressFalso };
