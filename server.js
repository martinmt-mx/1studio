/**
 * 1Studio · Servidor: API HTTP + arranque.
 * La lógica vive en lib/ (ffmpeg, trabajos, descargas, analizador, proyectos de video largo, buscador en fuentes).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { ROOT, PORT, FFMPEG, VIDEO_EXT, DIRS, CANALES, METRICAS, CACHE } = require('./lib/config');
const { ruta, httpError, canalValido, archivoSeguro, rutaUnica, listar, rutaMeta, META_VACIA, leerMeta, escribirJSON, partirDescripcion, leerMetricas, aLaPapelera, ejecutar, ultimasLineas, sello, limpiarNombre, infoArchivo, creadorDeArchivo } = require('./lib/util');
const { herramientas } = require('./lib/herramientas');
const { clientes, avisar, vigilarCarpetas } = require('./lib/eventos');
const { detectarEncoder, buscarFuente, duracion, disenoVertical, disenoLista, dimensiones } = require('./lib/ffmpeg');
const { jobs, nombreVertical, procesarClip, parsearJSONClaude, revisarLote, procesarLote } = require('./lib/trabajos');
const { validarRango, descargarClip } = require('./lib/descargas');
const { analisis, construirPrompt, analizarRaw } = require('./lib/analizador');

// ───────────────────────── API ─────────────────────────
const app = express();
app.use(express.json({ limit: '80mb' }));   // las capas de texto (PNG) viajan en el lote
app.use(express.static(path.join(ROOT, 'public')));


async function listos(canal) {
  const dir = DIRS[canal].listos;
  const vids = await listar(dir, VIDEO_EXT);
  return Promise.all(vids.map(async v => ({ ...v, meta: (await leerMeta(dir, v.name)) || META_VACIA() })));
}

app.get('/api/estado', ruta(async (_req, res) => {
  const [guiones, ucListos, raw, gtListos, enc, herr] = await Promise.all([
    listar(DIRS.ucronia.guiones), listos('ucronia'), listar(DIRS.gtavi.raw, VIDEO_EXT), listos('gtavi'), detectarEncoder(), herramientas(),
  ]);
  const { prompt, ...analisisResumen } = analisis;
  res.json({
    encoder: enc,
    herramientas: {
      ytdlp: { ok: herr.ytdlp.ok, version: herr.ytdlp.version },
      python: { ok: herr.python.ok, version: herr.python.version, whisper: herr.python.whisper },
    },
    analisis: analisisResumen,
    canales: {
      ucronia: { nombre: CANALES.ucronia, guiones, listos: ucListos },
      gtavi: { nombre: CANALES.gtavi, raw: raw.map(r => ({ ...r, info: infoArchivo(r.name) })), listos: gtListos },
    },
    jobs: [...jobs.values()]
      .filter(j => j.estado === 'procesando' || j.estado === 'en cola' || Date.now() - (j.fin || 0) < 10 * 60_000)
      .sort((a, b) => Number(b.id) - Number(a.id)),
  });
}));

app.get('/api/eventos', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clientes.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); clientes.delete(res); });
});

// Guardar / partir descripción (conserva el @creador si el .json ya lo tenía)
app.post('/api/meta/:canal/:video', ruta(async (req, res) => {
  const canal = canalValido(req.params.canal);
  const dir = DIRS[canal].listos;
  archivoSeguro(dir, req.params.video);
  const { modo, completo, titulo, descripcion } = req.body || {};
  const previo = await leerMeta(dir, req.params.video);
  const meta = modo === 'partir'
    ? partirDescripcion(completo)
    : { completo: String(completo ?? ''), titulo: String(titulo ?? ''), descripcion: String(descripcion ?? '') };
  if (previo?.creador) meta.creador = previo.creador;
  // respaldo de la versión anterior (por si se borra sin querer): .cache/respaldos_meta/<canal>/
  if (previo && (previo.titulo || previo.completo)) {
    const rd = path.join(CACHE, 'respaldos_meta', canal);
    await fsp.mkdir(rd, { recursive: true }).catch(() => {});
    await fsp.writeFile(path.join(rd, `${path.parse(req.params.video).name}__${sello()}.json`), JSON.stringify(previo, null, 2), 'utf8').catch(() => {});
  }
  await escribirJSON(rutaMeta(dir, req.params.video), meta);
  avisar();
  res.json({ ok: true, meta });
}));

// Descarga directa (fuerza "guardar como" en el celular)
app.get('/api/descargar/:canal/:video', ruta(async (req, res) => {
  const canal = canalValido(req.params.canal);
  const file = archivoSeguro(DIRS[canal].listos, req.params.video);
  res.download(file, req.params.video);
}));

// Vista previa (soporta Range para que el <video> pueda adelantar)
app.get('/media/:canal/:carpeta/:video', ruta(async (req, res) => {
  const canal = canalValido(req.params.canal);
  const dir = DIRS[canal][req.params.carpeta];
  if (!dir || req.params.carpeta === 'publicados') throw httpError(404, 'Carpeta no válida');
  res.sendFile(archivoSeguro(dir, req.params.video));
}));

// Abrir un guion HTML del canal de historias
app.get('/guion/:name', ruta(async (req, res) => {
  res.sendFile(archivoSeguro(DIRS.ucronia.guiones, req.params.name));
}));

// Procesar clip de GTA VI (modo manual)
app.post('/api/procesar', ruta(async (req, res) => {
  const { video, hook, creador, fondo } = req.body || {};
  if (!video) throw httpError(400, 'Elige un video de Gaming/Raw');
  res.json(await procesarClip({ video, hook, creador, fondo }));
}));
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  return job ? res.json(job) : res.status(404).json({ error: 'Trabajo no encontrado' });
});

// Lote con el JSON de Claude: modo "individual" (A) o "top" (B)
app.post('/api/lote/validar', ruta(async (req, res) => {
  res.json({ items: await revisarLote(req.body?.json) });
}));
app.post('/api/lote', ruta(async (req, res) => {
  const { json, modo, orientacion, ajustes, fondo, estilo, titulo, extra } = req.body || {};
  res.json(await procesarLote({ json, modo, orientacion, ajustes, fondo, estilo, titulo, extra }));
}));

// Tira de miniaturas (12 cuadros) de un clip de Raw para el editor
const MINIS = path.join(CACHE, 'miniaturas');
fs.mkdirSync(MINIS, { recursive: true });
const minisEnCurso = new Map();
app.get('/api/miniaturas/:archivo', ruta(async (req, res) => {
  const file = archivoSeguro(DIRS.gtavi.raw, req.params.archivo);
  const st = await fsp.stat(file);
  const clave = crypto.createHash('md5').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex');
  const out = path.join(MINIS, clave + '.jpg');
  if (!fs.existsSync(out)) {
    if (!minisEnCurso.has(clave)) {
      minisEnCurso.set(clave, (async () => {
        const d = (await duracion(file)) || 1;
        const r = await ejecutar(FFMPEG, ['-hide_banner', '-y', ...(d > 30 ? ['-skip_frame', 'nokey'] : []), '-i', file, '-an',
          '-vf', `fps=${(12 / d).toFixed(5)},scale=-2:90,tile=12x1`, '-frames:v', '1', '-q:v', '5', out]);
        if (r.code !== 0 || !fs.existsSync(out)) throw new Error('No pude generar miniaturas: ' + ultimasLineas(r.stderr, 2));
      })().finally(() => minisEnCurso.delete(clave)));
    }
    await minisEnCurso.get(clave);
  }
  res.set('Cache-Control', 'max-age=86400');
  res.sendFile(out);
}));

// Descargador de clips → Gaming/Raw
app.post('/api/clips/descargar', ruta(async (req, res) => {
  res.json(await descargarClip(req.body || {}));
}));

// Analizador de Gaming/Raw para Claude
app.post('/api/analizar', ruta(async (req, res) => {
  await analizarRaw({ modelo: req.body?.modelo });
  res.json({ ok: true });
}));
app.get('/api/analisis', (_req, res) => res.json(analisis));

// Marcar como publicado → métricas + MP4 a la papelera + JSON a Publicados
app.post('/api/publicar/:canal/:video', ruta(async (req, res) => {
  const canal = canalValido(req.params.canal);
  const dir = DIRS[canal].listos;
  const video = req.params.video;
  const file = archivoSeguro(dir, video);
  const meta = (await leerMeta(dir, video)) || META_VACIA();

  const destino = await aLaPapelera(file);

  const metricas = await leerMetricas();
  const registro = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    video,
    canal: CANALES[canal],
    canalId: canal,
    fechaPublicacion: new Date().toISOString(),
    titulo: meta.titulo,
    vistas24h: null,
    vistas72h: null,
  };
  metricas.unshift(registro);
  await escribirJSON(METRICAS, metricas);

  const metaFile = rutaMeta(dir, video);
  if (fs.existsSync(metaFile)) {
    await fsp.rename(metaFile, rutaUnica(DIRS[canal].publicados, path.basename(metaFile))).catch(() => {});
  }
  avisar();
  res.json({ ok: true, destino, registro });
}));

app.get('/api/metricas', ruta(async (_req, res) => res.json(await leerMetricas())));

app.patch('/api/metricas/:id', ruta(async (req, res) => {
  const metricas = await leerMetricas();
  const reg = metricas.find(m => m.id === req.params.id);
  if (!reg) throw httpError(404, 'Registro no encontrado');
  for (const campo of ['vistas24h', 'vistas72h']) {
    if (campo in (req.body || {})) {
      const v = req.body[campo];
      reg[campo] = v === '' || v === null ? null : Math.max(0, Math.round(Number(String(v).replace(/[^\d.]/g, '')) || 0));
    }
  }
  await escribirJSON(METRICAS, metricas);
  res.json(reg);
}));

// ───────────────────────── Video largo (proyectos armados en torno a la voz) ─────────────────────────
require('./lib/proyectos')({ app, express });
require('./lib/fuentes')({ app });

// ───────────────────────── Arranque ─────────────────────────
function ipsLocales() {
  const puntaje = n => (/wi-?fi|wlan|wireless|inal[aá]mbrica/i.test(n) ? 2 : /vethernet|virtual|vmware|vbox|wsl|docker|hyper-v|loopback|tailscale|zerotier/i.test(n) ? -1 : 0);
  const out = [];
  for (const [nombre, arr] of Object.entries(os.networkInterfaces())) {
    for (const a of arr || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ nombre, ip: a.address, p: puntaje(nombre) });
    }
  }
  return out.sort((a, b) => b.p - a.p);
}

module.exports = { app, disenoLista, disenoVertical, dimensiones, infoArchivo, nombreVertical, revisarLote, partirDescripcion, parsearJSONClaude, construirPrompt, validarRango, limpiarNombre, creadorDeArchivo };

if (require.main === module) {
  vigilarCarpetas();
  app.listen(PORT, '0.0.0.0', async () => {
    const ips = ipsLocales();
    const wifi = ips.find(i => i.p === 2) || ips.find(i => i.p >= 0);
    const [enc, herr] = await Promise.all([detectarEncoder(), herramientas(true)]);
    const linea = '─'.repeat(58);
    console.log(`\n${linea}\n  1Studio · Tablero de Control`);
    console.log(linea);
    console.log(`  PC:       http://localhost:${PORT}`);
    if (wifi) console.log(`  Celular:  http://${wifi.ip}:${PORT}   ← (${wifi.nombre})`);
    for (const i of ips.filter(i => i !== wifi)) console.log(`            http://${i.ip}:${PORT}   (${i.nombre})`);
    console.log(linea);
    console.log(`  FFmpeg:   ${enc.ffmpeg ? enc.etiqueta : 'NO ENCONTRADO (el procesador de clips no funcionará)'}`);
    console.log(`  Fuente:   ${buscarFuente() || 'ninguna encontrada (pon un .ttf en ./fonts)'}`);
    console.log(`  yt-dlp:   ${herr.ytdlp.ok ? `${herr.ytdlp.version} (${herr.ytdlp.ruta})` : 'no encontrado → el descargador queda desactivado'}`);
    console.log(`  Python:   ${herr.python.ok
      ? `${herr.python.version} · faster-whisper ${herr.python.whisper ? 'OK' : 'NO instalado (solo duración y picos)'}`
      : 'no encontrado → el analizador queda desactivado'}`);
    console.log(`${linea}\n`);
  });
}
