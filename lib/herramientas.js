/** 1Studio · Detección de herramientas externas: yt-dlp y Python (+ faster-whisper). */
const fs = require('fs');
const path = require('path');
const { ROOT, ES_WIN } = require('./config');
const { ejecutar } = require('./util');

// ───────────────────────── Herramientas externas ─────────────────────────
const rutaYtdlp = () => process.env.YTDLP_PATH
  || [path.join(ROOT, 'yt-dlp.exe'), path.join(ROOT, 'yt-dlp')].find(f => fs.existsSync(f))
  || 'yt-dlp';

async function detectarPython() {
  const candidatos = process.env.STUDIO_PYTHON
    ? [process.env.STUDIO_PYTHON.trim().split(/\s+/)]
    : ES_WIN ? [['python'], ['py', '-3']] : [['python3'], ['python']];
  for (const [cmd, ...pre] of candidatos) {
    const r = await ejecutar(cmd, [...pre, '-c', 'import sys; print(sys.version.split()[0])']);
    if (r.code === 0 && /^\d/.test(r.stdout.trim())) {
      const w = await ejecutar(cmd, [...pre, '-c', 'import faster_whisper']);
      return { ok: true, cmd, pre, version: r.stdout.trim(), whisper: w.code === 0 };
    }
  }
  return { ok: false, whisper: false };
}

let herrCache = null, herrFecha = 0;
async function herramientas(forzar = false) {
  const ttl = herrCache && herrCache.ytdlp.ok && herrCache.python.ok ? 300_000 : 30_000;
  if (!forzar && herrCache && Date.now() - herrFecha < ttl) return herrCache;
  const [yt, python] = await Promise.all([ejecutar(rutaYtdlp(), ['--version']), detectarPython()]);
  herrCache = { ytdlp: { ok: yt.code === 0, version: yt.code === 0 ? yt.stdout.trim() : null, ruta: rutaYtdlp() }, python };
  herrFecha = Date.now();
  return herrCache;
}

module.exports = { rutaYtdlp, detectarPython, herrCache, herramientas };
