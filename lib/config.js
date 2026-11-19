/** 1Studio · Rutas, carpetas y constantes globales (configurables por variables de entorno). */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// .env opcional (sin dependencias): KEY=valor por línea; lo que ya esté definido en el sistema tiene prioridad
try {
  for (const linea of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* sin .env */ }
const PORT = Number(process.env.PORT) || 3000;
const ES_WIN = process.platform === 'win32';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi'];

// ───────────────────────── Carpetas ─────────────────────────
// Encuentra cada subcarpeta sin importar mayúsculas (Guiones / guiones) y la crea si falta.
function resolveDir(...parts) {
  let cur = ROOT;
  for (const p of parts) {
    let name = p;
    try {
      const hit = fs.readdirSync(cur, { withFileTypes: true })
        .find(d => d.isDirectory() && d.name.toLowerCase() === p.toLowerCase());
      if (hit) name = hit.name;
    } catch { /* aún no existe */ }
    cur = path.join(cur, name);
  }
  fs.mkdirSync(cur, { recursive: true });
  return cur;
}

// Dos canales: "historias" (animaciones HTML narradas) y "gaming" (clips + videos largos armados en torno a la voz).
// Nombres visibles y carpetas se cambian con variables de entorno (ver .env.example).
const CANALES = {
  ucronia: process.env.CANAL_HISTORIAS || 'Historias alternativas',
  gtavi: process.env.CANAL_GAMING || 'Gaming clips',
};
const CARPETAS = {
  ucronia: process.env.CARPETA_HISTORIAS || 'Historias',
  gtavi: process.env.CARPETA_GAMING || 'Gaming',
};

const DIRS = {
  ucronia: {
    guiones: resolveDir(CARPETAS.ucronia, 'guiones'),
    listos: resolveDir(CARPETAS.ucronia, 'listos'),
    publicados: resolveDir(CARPETAS.ucronia, 'publicados'),
  },
  gtavi: {
    raw: resolveDir(CARPETAS.gtavi, 'raw'),
    listos: resolveDir(CARPETAS.gtavi, 'listos'),
    publicados: resolveDir(CARPETAS.gtavi, 'publicados'),
  },
};
const METRICAS = path.join(ROOT, 'metricas.json');
const TMP = path.join(ROOT, '.tmp_ffmpeg');
const CACHE = path.join(ROOT, '.cache');
const SCRIPT_ANALISIS = path.join(ROOT, 'python', 'analizar_raw.py');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });
for (const f of fs.readdirSync(TMP)) { try { fs.rmSync(path.join(TMP, f), { recursive: true, force: true }); } catch { /* en uso */ } }
const ANALISIS_FILE = path.join(CACHE, 'analisis_raw.json');

module.exports = { CARPETAS, ROOT, PORT, ES_WIN, FFMPEG, FFPROBE, VIDEO_EXT, resolveDir, DIRS, CANALES, METRICAS, TMP, CACHE, SCRIPT_ANALISIS, ANALISIS_FILE };
