/** 1Studio · Analizador de Raw (Python + Whisper) y armado del prompt para el modelo de IA. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { CANALES, ROOT, FFMPEG, FFPROBE, VIDEO_EXT, DIRS, CACHE, SCRIPT_ANALISIS, ANALISIS_FILE } = require('./config');
const { httpError, listar, escribirJSON, ultimasLineas, infoArchivo } = require('./util');
const { herramientas } = require('./herramientas');
const { avisar } = require('./eventos');

// ───────────────────────── Analizador para Claude ─────────────────────────
const PROMPT_FILE = path.join(CACHE, 'prompt_claude.json');
const analisis = { estado: 'inactivo', progreso: 0, mensaje: '', error: null, avisos: [], fecha: null, n: 0, prompt: '', dispositivo: null, modelo: null };
try { Object.assign(analisis, JSON.parse(fs.readFileSync(PROMPT_FILE, 'utf8')), { estado: 'listo' }); } catch { /* sin análisis previo */ }

const mmss = s => {
  s = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
const db = v => (v === null || v === undefined || !isFinite(v) ? '—' : Number(v).toFixed(1));

function construirPrompt(res) {
  const clips = res.clips || [];
  const n = clips.length;
  const bloques = clips.map((c, i) => {
    const info = infoArchivo(c.archivo);
    const cr = info.creador;
    const picos = (c.picos || []).map(p => `${mmss(p.t)} (${db(p.db)} dB)`).join(', ');
    let trans = (c.segmentos || []).map(s => `[${mmss(s.ini)}] ${s.texto}`).join('\n');
    if (trans.length > 2200) trans = trans.slice(0, 2200) + '\n[…transcripción recortada…]';
    if (!trans) trans = c.transcripcion_error ? `(no disponible: ${c.transcripcion_error})` : '(sin voz detectada)';
    return [
      `### Clip ${i + 1}`,
      `id: ${i + 1}`,
      `archivo: ${c.archivo}`,
      `creador: ${cr || '(desconocido → usa "")'}`,
      info.plataforma ? `fuente: ${info.plataforma} · publicado por "${info.visible}"` : null,
      info.texto ? `texto original del post: "${info.texto}"` : null,
      `duración: ${mmss(c.duracion)}`,
      c.pico_db === null || c.pico_db === undefined
        ? 'audio: el clip no tiene pista de audio'
        : `audio: pico ${db(c.pico_db)} dBFS · promedio ${db(c.medio_db)} dB${picos ? ` · momentos más fuertes: ${picos}` : ''}`,
      c.idioma ? `idioma detectado: ${c.idioma}` : null,
      'transcripción:',
      trans,
    ].filter(Boolean).join('\n');
  });

  return `Eres el editor de "${CANALES.gtavi}", un canal de Shorts/TikTok/Reels con los mejores momentos de streamers jugando GTA VI.

Te paso ${n} clip${n === 1 ? '' : 's'} de mi carpeta Gaming/Raw con su duración, sus picos de volumen y su transcripción automática. Los picos cercanos a 0 dBFS suelen ser gritos, risas, choques o explosiones: úsalos como pista de dónde está la acción.

TU TAREA: ordena los clips por potencial viral y escribe el copy de cada uno.

Responde ÚNICAMENTE con un JSON válido (sin texto antes ni después y sin bloque de código), con esta estructura exacta:

[
  {
    "ranking": ${n},
    "id": 1,
    "archivo": "nombre_exacto.mp4",
    "creador": "@creador",
    "gancho": "Frase corta sin emojis",
    "titulo_post": "Título para redes con emojis 🔥",
    "descripcion_post": "Una o dos frases. #GTA6 #GTAVI #Gaming #Clips #Viral"
  }
]

REGLAS:
- Incluye los ${n} clips, cada uno una sola vez.
- "ranking": número del 1 al ${n}. El 1 es el clip con MÁS impacto y el ${n} el de MENOS. Ordena el arreglo de menor a mayor impacto: el primer elemento es el ranking ${n} y el último es el ranking 1.
- "id": el número de id del clip que aparece abajo.
- "archivo": copia el nombre EXACTO que aparece abajo, con extensión.
- "creador": copia el @creador que aparece abajo en cada clip (si dice desconocido, deja "").
- "gancho": máximo 8 palabras, en español, SIN emojis ni hashtags. Es el texto que se quema arriba del video: debe dar ganas de verlo hasta el final.
- "titulo_post": máximo 90 caracteres, en español, con 1 a 3 emojis.
- "descripcion_post": 1 o 2 frases en español que terminen con exactamente 5 hashtags (incluye #GTA6).
- Cuando haya "texto original del post", úsalo como contexto de qué pasa en el clip (puede estar en inglés, portugués u otro idioma, o venir cortado), pero escribe todo en español.
- Si una transcripción está vacía o no tiene sentido, guíate por el texto del post, la duración y los picos de volumen.

CLIPS:

${bloques.join('\n\n')}
`;
}

async function analizarRaw({ modelo }) {
  if (analisis.estado === 'procesando') throw httpError(409, 'Ya hay un análisis en curso.');
  if (!fs.existsSync(SCRIPT_ANALISIS)) throw httpError(500, 'Falta analizar_raw.py en la carpeta del proyecto.');
  const h = await herramientas(true);
  if (!h.python.ok) throw httpError(503, 'Python no está instalado (o no está en el PATH). Instálalo y vuelve a abrir INICIAR.bat.');
  const raws = await listar(DIRS.gtavi.raw, VIDEO_EXT);
  if (!raws.length) throw httpError(400, 'Gaming/Raw está vacío.');
  const mod = ['base', 'small'].includes(modelo) ? modelo : 'auto';

  Object.assign(analisis, { estado: 'procesando', progreso: 1, mensaje: 'Iniciando…', error: null, avisos: [] });
  avisar();

  const args = [...h.python.pre, SCRIPT_ANALISIS, '--raw', DIRS.gtavi.raw, '--out', ANALISIS_FILE,
    '--cache', path.join(CACHE, 'transcripciones.json'), '--modelo', mod, '--ffmpeg', FFMPEG, '--ffprobe', FFPROBE];
  let p;
  try {
    p = spawn(h.python.cmd, args, { windowsHide: true, cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  } catch (e) { Object.assign(analisis, { estado: 'error', error: e.message }); throw httpError(500, e.message); }
  let buf = '', errLog = '';
  p.stdout.on('data', d => {
    buf += d;
    const ls = buf.split(/\r?\n/); buf = ls.pop();
    for (const l of ls) {
      let ev; try { ev = JSON.parse(l); } catch { continue; }
      if (ev.tipo === 'progreso') {
        const frac = ev.fase === 'transcribiendo' ? 0.3 : ev.fase === 'listo' ? 1 : 0;
        analisis.progreso = Math.max(1, Math.min(99, Math.round(((ev.i - 1 + frac) / ev.n) * 100)));
        analisis.mensaje = `${ev.i}/${ev.n} · ${ev.fase} · ${ev.archivo}`;
      } else if (ev.tipo === 'modelo') {
        analisis.mensaje = `Cargando Whisper "${ev.modelo}" en ${String(ev.dispositivo).toUpperCase()}…`;
        analisis.dispositivo = ev.dispositivo; analisis.modelo = ev.modelo;
      } else if (ev.tipo === 'aviso') {
        analisis.avisos.push(ev.mensaje); avisar();
      }
    }
  });
  p.stderr.on('data', d => { errLog = (errLog + d).slice(-8000); });
  p.on('error', e => { Object.assign(analisis, { estado: 'error', error: e.message }); avisar(); });
  p.on('close', async code => {
    try {
      if (code !== 0) throw new Error(ultimasLineas(errLog, 8) || `analizar_raw.py terminó con código ${code}`);
      const res = JSON.parse(await fsp.readFile(ANALISIS_FILE, 'utf8'));
      Object.assign(analisis, {
        estado: 'listo', progreso: 100, mensaje: '', fecha: new Date().toISOString(), n: (res.clips || []).length,
        prompt: construirPrompt(res), dispositivo: res.dispositivo, modelo: res.modelo,
      });
      await escribirJSON(PROMPT_FILE, { fecha: analisis.fecha, n: analisis.n, prompt: analisis.prompt,
        dispositivo: analisis.dispositivo, modelo: analisis.modelo, avisos: analisis.avisos });
    } catch (e) {
      Object.assign(analisis, { estado: 'error', error: e.message, progreso: 0 });
    }
    avisar();
  });
}

module.exports = { PROMPT_FILE, analisis, mmss, db, construirPrompt, analizarRaw };
