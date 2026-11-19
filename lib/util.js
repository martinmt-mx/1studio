/** 1Studio · Utilidades: errores HTTP, rutas seguras, JSON atómico, procesos, nombres de archivo, descripción → título, papelera. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const { ES_WIN, resolveDir, DIRS, METRICAS } = require('./config');

// ───────────────────────── Utilidades ─────────────────────────
function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

function canalValido(c) {
  if (!DIRS[c]) throw httpError(404, 'Canal desconocido');
  return c;
}

/** Devuelve la ruta absoluta de un archivo dentro de `dir`, sin permitir ../ */
function archivoSeguro(dir, name, debeExistir = true) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || base.startsWith('.')) throw httpError(400, 'Nombre de archivo inválido');
  const full = path.join(dir, base);
  if (debeExistir && !fs.existsSync(full)) throw httpError(404, `No existe: ${base}`);
  return full;
}

// Nombres ya asignados a trabajos en cola (aún no existen en disco)
const reservados = new Set();
function rutaUnica(dir, nombre) {
  const { name, ext } = path.parse(nombre);
  let candidato = path.join(dir, nombre);
  let i = 2;
  while (fs.existsSync(candidato) || reservados.has(candidato.toLowerCase())) candidato = path.join(dir, `${name} (${i++})${ext}`);
  return candidato;
}
function reservar(dir, nombre) { const r = rutaUnica(dir, nombre); reservados.add(r.toLowerCase()); return r; }
const liberar = r => reservados.delete(String(r).toLowerCase());

async function listar(dir, exts) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    if (exts && !exts.includes(path.extname(e.name).toLowerCase())) continue;
    try {
      const st = await fsp.stat(path.join(dir, e.name));
      out.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
    } catch { /* archivo movido mientras listábamos */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const rutaMeta = (dir, video) => path.join(dir, path.parse(video).name + '.json');
const META_VACIA = () => ({ completo: '', titulo: '', descripcion: '' });

async function leerMeta(dir, video) {
  try {
    const data = JSON.parse(await fsp.readFile(rutaMeta(dir, video), 'utf8'));
    const meta = { completo: data.completo || '', titulo: data.titulo || '', descripcion: data.descripcion || '' };
    if (data.creador) meta.creador = data.creador;
    return meta;
  } catch { return null; }
}

async function escribirJSON(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * Parte la descripción completa en título + descripción.
 * Corta en el primer "?" (arrastrando los emojis / signos pegados a esa pregunta)
 * o en el primer salto de línea, lo que ocurra primero.
 */
const COLA_PREGUNTA = /^(?:[ \t]*(?:[?!¡]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣))*/u;
function partirDescripcion(texto) {
  const t = String(texto || '').replace(/\r\n?/g, '\n').trim();
  const q = t.indexOf('?');
  const nl = t.indexOf('\n');
  let corte = -1;
  if (q !== -1 && (nl === -1 || q < nl)) {
    corte = q + 1;
    corte += t.slice(corte).match(COLA_PREGUNTA)[0].length;
  } else if (nl !== -1) {
    corte = nl;
  }
  if (corte === -1) return { completo: t, titulo: t, descripcion: '' };
  return { completo: t, titulo: t.slice(0, corte).trim(), descripcion: t.slice(corte).trim() };
}

async function leerMetricas() {
  try { return JSON.parse(await fsp.readFile(METRICAS, 'utf8')); } catch { return []; }
}

// Manda un archivo a la Papelera de reciclaje (Windows). En otros sistemas lo mueve a ./_papelera
function aLaPapelera(file) {
  return new Promise((resolve, reject) => {
    if (ES_WIN) {
      // sirve para archivos y carpetas (los proyectos de video largo son carpetas)
      const metodo = fs.statSync(file).isDirectory() ? 'DeleteDirectory' : 'DeleteFile';
      const script = "Add-Type -AssemblyName Microsoft.VisualBasic; " +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::${metodo}($env:TRASH_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { env: { ...process.env, TRASH_TARGET: file }, windowsHide: true },
        (err, _out, stderr) => {
          if (err) return reject(new Error((stderr || err.message).trim()));
          if (fs.existsSync(file)) return reject(new Error('El archivo sigue en su carpeta (¿está abierto en otro programa?)'));
          resolve('Papelera de reciclaje');
        });
    } else {
      const dest = resolveDir('_papelera');
      fs.rename(file, rutaUnica(dest, path.basename(file)), e => (e ? reject(e) : resolve('_papelera/')));
    }
  });
}

/** Ejecuta un programa y junta su salida. Nunca lanza: code = -1 si no se pudo iniciar. */
function ejecutar(cmd, args, opts = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, ...opts });
    } catch (e) { return resolve({ code: -1, stdout, stderr: e.message }); }
    p.stdout.on('data', d => (stdout += d));
    p.stderr.on('data', d => (stderr = (stderr + d).slice(-20000)));
    p.on('error', e => resolve({ code: -1, stdout, stderr: e.message }));
    p.on('close', code => resolve({ code, stdout, stderr }));
  });
}
const ultimasLineas = (txt, n = 6) => String(txt || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(Boolean).slice(-n).join('\n');

function sello(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const limpiarNombre = s => String(s || '').normalize('NFC').replace(/^@+/, '')
  .replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/_{2,}/g, '_').replace(/^[_.-]+|[_.-]+$/g, '').slice(0, 40);
/**
 * Saca creador / texto del nombre del archivo. Formatos reconocidos:
 *  · yt-dlp (este tablero):  "rata__20261118-055300.mp4"
 *  · FetchV (X/Twitter):     "2 Usuario Ejemplo en X_ _Texto del post https___t.co_abc_ _ X.mp4"
 * En X el nombre del archivo trae el nombre visible, no el @usuario: se convierte a un @ aproximado.
 */
const PLATAFORMAS = 'X|Twitter|TikTok|Instagram|YouTube|Facebook|Threads|Reddit|Kick|Twitch';
const RE_FETCHV = new RegExp(`^\\d*\\s*(.+?)\\s+en\\s+(${PLATAFORMAS})_\\s*_\\s*(.*)$`, 'i');
const SIN_EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200D\uFE0F\u20E3]/gu;
function aHandle(visible) {
  // Solo letras latinas/acentos, números y _: así el texto quemado nunca sale con cuadritos.
  const h = String(visible || '').replace(SIN_EMOJI, '').replace(/[^A-Za-z0-9_À-ÖØ-öø-ÿ]/g, '').replace(/^_+|_+$/g, '').slice(0, 30);
  return /[A-Za-z0-9]/.test(h) ? '@' + h : '';
}
function infoArchivo(nombre) {
  const base = path.parse(String(nombre || '')).name.normalize('NFC');
  const yt = base.match(/^(.+?)__\d{8}-\d{6}/);
  if (yt) return { creador: '@' + yt[1], visible: yt[1], plataforma: null, texto: '' };
  const m = base.match(RE_FETCHV);
  if (!m) return { creador: '', visible: '', plataforma: null, texto: '' };
  const texto = m[3]
    .replace(/https?_{3}t\.co_[A-Za-z0-9]+/gi, ' ')   // links t.co
    .replace(/[\s_]+X\s*$/i, '')                    // cola " _ _ X" del título de la pestaña
    .replace(/_ _/g, ' ')
    .replace(/_{2,}/g, '?')                           // FetchV cambia "?" por "_"
    .replace(/\s+/g, ' ').trim();
  return { creador: aHandle(m[1]), visible: m[1].trim(), plataforma: m[2], texto };
}
const creadorDeArchivo = nombre => infoArchivo(nombre).creador;

/** Envuelve un handler async de Express: cualquier error sale como JSON { error } con su status. */
const ruta = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  res.status(e.status || 500).json({ error: e.message || 'Error' });
});

module.exports = { ruta, httpError, canalValido, archivoSeguro, reservados, rutaUnica, reservar, liberar, listar, rutaMeta, META_VACIA, leerMeta, escribirJSON, COLA_PREGUNTA, partirDescripcion, leerMetricas, aLaPapelera, ejecutar, ultimasLineas, sello, limpiarNombre, PLATAFORMAS, RE_FETCHV, SIN_EMOJI, aHandle, infoArchivo, creadorDeArchivo };
