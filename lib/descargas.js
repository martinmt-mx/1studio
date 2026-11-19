/** 1Studio · Descargador con yt-dlp (tramos parciales, progreso en vivo). */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { FFMPEG, VIDEO_EXT, DIRS, TMP } = require('./config');
const { httpError, reservar, liberar, ejecutar, ultimasLineas, sello, limpiarNombre } = require('./util');
const { rutaYtdlp, herramientas } = require('./herramientas');
const { avisar } = require('./eventos');
const { nuevoJob, terminar } = require('./trabajos');

// ───────────────────────── Descargador (yt-dlp) ─────────────────────────
function validarRango(r) {
  const t = String(r || '').trim();
  if (!t) return null;
  const T = '(\\d+(?::\\d{1,2}){0,2}(?:\\.\\d+)?)';
  const m = t.match(new RegExp(`^${T}\\s*-\\s*${T}$`));
  if (!m) throw httpError(400, 'Rango inválido. Usa el formato 01:12:30-01:13:05');
  const seg = x => x.split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
  const ini = seg(m[1]), fin = seg(m[2]);
  if (fin <= ini) throw httpError(400, `El fin (${m[2]}) tiene que ser después del inicio (${m[1]}). ¿Te faltó un dígito?`);
  if (fin - ini > 15 * 60) throw httpError(400, 'Ese tramo dura más de 15 minutos. Pide solo el pedazo que necesitas.');
  return `*${m[1]}-${m[2]}`;
}

async function descargarClip({ url, creador, rango }) {
  url = String(url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) throw httpError(400, 'Pega una URL válida (https://…)');
  const seccion = validarRango(rango);
  const h = await herramientas(true);
  if (!h.ytdlp.ok) throw httpError(503, 'yt-dlp no está disponible. Ejecuta INICIAR.bat para descargarlo (yt-dlp.exe).');
  const ytdlp = rutaYtdlp();
  const job = nuevoJob('descarga', url, { url, rango: seccion ? String(rango).trim() : null });

  let reservado = null;
  (async () => {
    job.estado = 'procesando'; job.mensaje = 'Leyendo datos del clip…'; avisar();
    let nombre = limpiarNombre(creador);
    if (!nombre) {
      const r = await ejecutar(ytdlp, ['--no-playlist', '--skip-download', '--no-warnings', '--encoding', 'utf-8',
        '--print', '%(channel,uploader,uploader_id,creator)s', url]);
      const v = r.stdout.split(/\r?\n/).map(s => s.trim()).find(s => s && s !== 'NA');
      if (r.code !== 0 && !v) throw new Error(ultimasLineas(r.stderr, 3) || 'yt-dlp no pudo leer la URL');
      nombre = limpiarNombre(v);
    }
    nombre ||= 'clip';
    reservado = reservar(DIRS.gtavi.raw, `${nombre}__${sello()}.mp4`);
    const base = path.parse(reservado).name;
    job.archivo = base + '.mp4'; job.titulo = job.archivo;
    const tmpDl = path.join(TMP, `dl_${job.id}`);
    fs.mkdirSync(tmpDl, { recursive: true });

    const args = ['--no-playlist', '--newline', '--no-warnings', '--no-colors', '--encoding', 'utf-8',
      '-S', 'res:1080,fps,vcodec:h264,acodec:aac', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '--remux-video', 'mp4',
      '-P', `home:${DIRS.gtavi.raw}`, '-P', `temp:${tmpDl}`, '-o', `${base}.%(ext)s`,
      '--progress-template', 'download:[dl]%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s'];
    if (process.env.FFMPEG_PATH) args.push('--ffmpeg-location', FFMPEG);
    if (seccion) args.push('--download-sections', seccion, '--force-keyframes-at-cuts');
    args.push(url);

    job.mensaje = seccion ? `Descargando tramo ${job.rango}…` : 'Descargando…'; avisar();
    let parte = 0, ultimoPct = 0, errLog = '';
    await new Promise((resolve, reject) => {
      const p = spawn(ytdlp, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let buf = '';
      const linea = l => {
        l = l.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (!l) return;
        if (l.startsWith('[dl]')) {
          const [pct, vel, eta] = l.slice(4).split('|').map(s => s.trim());
          const n = parseFloat(pct);
          if (isNaN(n)) return;
          if (n + 5 < ultimoPct) parte++;            // empezó el segundo stream (audio)
          ultimoPct = n;
          job.progreso = Math.min(97, Math.round(parte ? 85 + n * 0.12 : n * 0.85));
          const ok = s => s && !/^(NA|Unknown|N\/A)/i.test(s);
          job.mensaje = `${parte ? 'Audio' : 'Video'} ${n.toFixed(0)}%${ok(vel) ? ' · ' + vel : ''}${ok(eta) ? ' · faltan ' + eta : ''}`;
        } else if (/^\[(Merger|VideoRemuxer|FixupM3u8|FixupM4a|VideoConvertor)\]/.test(l)) {
          job.mensaje = 'Uniendo audio y video…'; job.progreso = Math.max(job.progreso, 97);
        }
      };
      p.stdout.on('data', d => { buf += d; const ls = buf.split(/\r?\n|\r/); buf = ls.pop(); ls.forEach(linea); });
      p.stderr.on('data', d => { errLog = (errLog + d).slice(-6000); });
      p.on('error', reject);
      p.on('close', code => {
        if (buf) linea(buf);
        code === 0 ? resolve() : reject(new Error(ultimasLineas(errLog, 4) || `yt-dlp terminó con código ${code}`));
      });
    }).finally(() => fsp.rm(tmpDl, { recursive: true, force: true }).catch(() => {}));

    // Si yt-dlp no pudo dejarlo en .mp4, usa el archivo que haya generado.
    if (!fs.existsSync(reservado)) {
      const otro = (await fsp.readdir(DIRS.gtavi.raw)).find(f => f.startsWith(base + '.') && VIDEO_EXT.includes(path.extname(f).toLowerCase()));
      if (!otro) throw new Error('yt-dlp terminó pero no encontré el archivo descargado.');
      job.archivo = otro; job.titulo = otro;
    }
    job.mensaje = 'Guardado en Gaming/Raw';
  })().then(() => terminar(job), e => terminar(job, e)).finally(() => reservado && liberar(reservado));
  return job;
}

module.exports = { validarRango, descargarClip };
