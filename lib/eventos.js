/** 1Studio · Tiempo real: Server-Sent Events + fs.watch sobre las carpetas de trabajo. */
const fs = require('fs');
const { DIRS } = require('./config');

const clientes = new Set();   // respuestas SSE abiertas
let avisoTimer = null;

/** Avisa a todos los navegadores que algo cambió (agrupa avisos seguidos en uno solo). */
function avisar() {
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { for (const res of clientes) res.write('event: cambio\ndata: {}\n\n'); }, 350);
  avisoTimer.unref?.();
}

/** Vigila las carpetas de trabajo: si sueltas un archivo a mano, el tablero se actualiza solo. */
function vigilarCarpetas() {
  for (const canal of Object.values(DIRS)) {
    for (const dir of Object.values(canal)) {
      try { fs.watch(dir, () => avisar()); } catch { /* sin watch: el cliente también hace polling */ }
    }
  }
}

module.exports = { clientes, avisar, vigilarCarpetas };
