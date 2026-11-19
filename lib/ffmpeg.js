/** 1Studio · FFmpeg: detección de NVENC, layouts vertical / lista, render de clips y unión sin cuadros negros. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, ES_WIN, FFMPEG, FFPROBE, TMP } = require('./config');
const { httpError, ejecutar, ultimasLineas } = require('./util');

// ───────────────────────── FFmpeg ─────────────────────────
let encoderPromise = null;
function detectarEncoder() {
  if (!encoderPromise) {
    encoderPromise = new Promise(resolve => {
      const cpu = { codec: 'libx264', gpu: false, etiqueta: 'CPU (libx264)' };
      let p;
      try {
        p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.2',
          '-c:v', 'h264_nvenc', '-f', 'null', '-'], { windowsHide: true });
      } catch { return resolve({ ...cpu, ffmpeg: false }); }
      p.on('error', () => resolve({ ...cpu, ffmpeg: false }));
      p.on('close', code => resolve(code === 0
        ? { codec: 'h264_nvenc', gpu: true, etiqueta: 'GPU NVIDIA (NVENC)', ffmpeg: true }
        : { ...cpu, ffmpeg: true }));
    });
  }
  return encoderPromise;
}

function buscarFuente() {
  const locales = fs.existsSync(path.join(ROOT, 'fonts'))
    ? fs.readdirSync(path.join(ROOT, 'fonts')).filter(f => /\.(ttf|otf)$/i.test(f)).map(f => path.join(ROOT, 'fonts', f))
    : [];
  const sistema = ES_WIN
    ? ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arial.ttf']
    : ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial Bold.ttf',
       '/System/Library/Fonts/Supplemental/Arial Bold.ttf'];
  return [process.env.FONT_PATH, ...locales, ...sistema].filter(Boolean).find(f => fs.existsSync(f)) || null;
}

// Rutas dentro del filtergraph de FFmpeg: C:/x → 'C\:/x'
const escFiltro = p => `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
const sinEmojis = s => s.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200D\uFE0F\u20E3]/gu, '').replace(/[ \t]+/g, ' ').trim();

function envolver(texto, max) {
  const lineas = [];
  for (const parrafo of texto.split('\n')) {
    let actual = '';
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      if (!actual) actual = palabra;
      else if ((actual + ' ' + palabra).length <= max) actual += ' ' + palabra;
      else { lineas.push(actual); actual = palabra; }
    }
    if (actual) lineas.push(actual);
  }
  return lineas;
}

async function duracion(file) {
  const r = await ejecutar(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return parseFloat(r.stdout) || 0;
}
async function tieneAudio(file) {
  const r = await ejecutar(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
  return r.stdout.trim().length > 0;
}

/**
 * Capas de texto (cada línea en su propio archivo → se centra individualmente y sin problemas de escapado).
 * Sin insignia, el diseño vertical es idéntico al del procesador manual original.
 */
/**
 * Dónde va cada texto en el lienzo vertical 1080×1920, según la forma del clip.
 * Horizontal o cuadrado → quedan franjas libres arriba y abajo: la insignia y el gancho se centran en la
 * franja de arriba (achicando la letra si hace falta) y el crédito va justo debajo del video.
 * Clip vertical (sin franjas) → los textos van encima del video como antes.
 * (public/editor.js tiene una copia de esta función para la vista previa.)
 */
const TAMANOS_HOOK = [[72, 22], [64, 25], [56, 28], [48, 33]];
function disenoVertical({ srcW, srcH, hook, badge, credito }) {
  const W = 1080, H = 1920;
  const fgH = srcW && srcH ? Math.min(H, Math.round((W * srcH) / srcW)) : H;
  const banda = Math.max(0, Math.floor((H - fgH) / 2));
  const badgeH = badge ? 150 : 0;
  let lineas = [], size = 72, lh = 92, enBanda = false;
  if (hook) {
    for (const [s, m] of TAMANOS_HOOK) {
      const l = envolver(hook, m), h = Math.round(s * 1.28);
      if (badgeH + l.length * h + 60 <= banda) { lineas = l; size = s; lh = h; enBanda = true; break; }
    }
    if (!enBanda) {
      size = 72; lineas = envolver(hook, 22);
      if (lineas.length > 3) { size = 58; lineas = envolver(hook, 28); }
      lh = Math.round(size * 1.28);
    }
  } else enBanda = badgeH + 60 <= banda;
  const bloque = badgeH + lineas.length * lh;
  let badgeY, hookY;
  // centrado en la franja, pero sin pegarse arriba (ahí van los botones de TikTok/Reels) si sobra espacio
  if (enBanda) { badgeY = Math.round(Math.max((banda - bloque) / 2, Math.min(70, banda - bloque - 20))); hookY = badgeY + badgeH; }
  else { badgeY = 90; hookY = Math.max(80, Math.round((badge ? 470 : 420) - (lineas.length * lh) / 2)); }
  const creditoY = credito ? (banda >= 110 ? banda + fgH + Math.min(60, Math.round((banda - 66) / 2)) : 1500) : null;
  return { banda, fgH, badgeY, hookY, size, lh, lineas, creditoY };
}

/**
 * Estilo "lista que se descubre" (solo vertical): título fijo arriba y una lista numerada abajo.
 * Renglones ya vistos en blanco, el actual en amarillo y los que faltan como "????".
 * (public/editor.js tiene una copia para la vista previa.)
 */
function disenoLista({ srcW, srcH, titulo, total }) {
  const W = 1080, H = 1920;
  const t = disenoVertical({ srcW, srcH, hook: titulo, badge: '', credito: '' });
  const { banda, fgH } = t;
  let size, lh, y0, conCaja = false;
  if (banda >= 200) {                                   // la lista va en la franja de abajo
    size = Math.max(28, Math.min(56, Math.floor((banda - 50) / total / 1.3)));
    lh = Math.round(size * 1.3);
    y0 = banda + fgH + Math.max(25, Math.round((banda - total * lh) / 2));
  } else {                                              // clip vertical: encima del video, con caja
    size = Math.max(28, Math.min(48, Math.floor(620 / total / 1.3)));
    lh = Math.round(size * 1.3);
    y0 = H - 300 - total * lh;
    conCaja = true;
  }
  const maxChars = Math.floor((W - 140) / (size * 0.56));
  const creditoY = banda >= 200 ? banda + fgH - 84 : y0 - 90;   // crédito sobre la orilla de abajo del video
  return { titulo: t, size, lh, y0, maxChars, conCaja, creditoY };
}
const recortar = (t, max) => (t.length > max ? t.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : t);

function capasTexto(tag, { hook, credito, badge, vertical = true, srcW, srcH, lista }) {
  const fuente = buscarFuente();
  const fontArg = fuente ? `fontfile=${escFiltro(fuente)}:` : '';
  const temporales = [];
  const dibujos = [];
  const txt = (nombre, texto) => {
    const f = `${tag}_${nombre}.txt`;
    fs.writeFileSync(path.join(TMP, f), texto, 'utf8');
    temporales.push(f);
    return escFiltro(f);
  };
  const dt = (tf, size, color) => `drawtext=${fontArg}textfile=${tf}:expansion=none:fontsize=${size}:fontcolor=${color}:`;
  const hookLimpio = sinEmojis(String(hook || ''));
  // El crédito se quema tal cual lo escribiste (@usuario, nombre o texto libre).
  const cr = sinEmojis(String(credito || '')).slice(0, 60);

  if (lista) {
    // lista = { titulo, textos: [...], actual: índice que se está viendo, total: renglones (incluye el extra) }
    const d = disenoLista({ srcW, srcH, titulo: sinEmojis(String(lista.titulo || '')), total: lista.total });
    d.titulo.lineas.forEach((ln, i) => dibujos.push(`${dt(txt('titulo' + i, ln), d.titulo.size, 'white')}` +
      `borderw=7:bordercolor=black:shadowx=0:shadowy=4:shadowcolor=black@0.6:x=(w-text_w)/2:y=${d.titulo.hookY + i * d.titulo.lh}`));
    for (let j = 0; j < lista.total; j++) {
      const visto = j <= lista.actual && j < lista.textos.length;
      const completo = `${j + 1}. ${visto ? sinEmojis(lista.textos[j] || '') || '…' : '????'}`;
      // renglón largo: primero se achica la letra (hasta 70 %), y solo si no cabe se corta con "…"
      const size = completo.length > d.maxChars ? Math.max(Math.round(d.size * 0.7), Math.floor(d.size * d.maxChars / completo.length)) : d.size;
      const texto = recortar(completo, Math.floor(d.maxChars * d.size / size));
      const color = j === lista.actual ? '0xFFD400' : visto ? 'white' : '0xD4D4D8';
      const caja = d.conCaja ? 'box=1:boxcolor=black@0.45:boxborderw=10:' : '';
      dibujos.push(`${dt(txt('lista' + j, texto), size, color)}${caja}borderw=${Math.max(3, Math.round(size / 10))}:bordercolor=black:` +
        `shadowx=0:shadowy=3:shadowcolor=black@0.6:x=70:y=${d.y0 + j * d.lh + Math.round((d.size - size) / 2)}`);
    }
    if (cr) dibujos.push(`${dt(txt('credito', cr), 40, 'white')}borderw=4:bordercolor=black:box=1:boxcolor=black@0.45:boxborderw=12:x=(w-text_w)/2:y=${d.creditoY}`);
    return { dibujos, temporales };
  }

  if (vertical) {
    const d = disenoVertical({ srcW, srcH, hook: hookLimpio, badge, credito: cr });
    if (badge) dibujos.push(`${dt(txt('badge', badge), 130, '0xFFD400')}borderw=9:bordercolor=black:shadowx=0:shadowy=6:shadowcolor=black@0.6:x=(w-text_w)/2:y=${d.badgeY}`);
    d.lineas.forEach((ln, i) => dibujos.push(`${dt(txt('hook' + i, ln), d.size, 'white')}` +
      `borderw=7:bordercolor=black:shadowx=0:shadowy=4:shadowcolor=black@0.6:x=(w-text_w)/2:y=${d.hookY + i * d.lh}`));
    if (cr) dibujos.push(`${dt(txt('credito', cr), 48, 'white')}borderw=5:bordercolor=black:box=1:boxcolor=black@0.35:boxborderw=14:x=(w-text_w)/2:y=${d.creditoY}`);
    return { dibujos, temporales };
  }

  // Horizontal 1920×1080
  if (badge) dibujos.push(`${dt(txt('badge', badge), 120, '0xFFD400')}borderw=8:bordercolor=black:shadowx=0:shadowy=5:shadowcolor=black@0.6:x=60:y=40`);
  if (hookLimpio) {
    let size = 60, lineas = envolver(hookLimpio, 38);
    if (lineas.length > 2) { size = 48; lineas = envolver(hookLimpio, 50); }
    const lh = Math.round(size * 1.28);
    lineas.forEach((ln, i) => dibujos.push(`${dt(txt('hook' + i, ln), size, 'white')}` +
      `borderw=6:bordercolor=black:shadowx=0:shadowy=4:shadowcolor=black@0.6:x=(w-text_w)/2:y=${50 + i * lh}`));
  }
  if (cr) dibujos.push(`${dt(txt('credito', cr), 40, 'white')}borderw=5:bordercolor=black:box=1:boxcolor=black@0.35:boxborderw=14:x=(w-text_w)/2:y=h-110`);
  return { dibujos, temporales };
}

/** Tamaño de imagen como se ve (aplica rotación del celular y pixel no cuadrado). */
async function dimensiones(file) {
  // -show_streams completo: el nombre de la sección de rotación cambia entre versiones de ffprobe
  const r = await ejecutar(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file]);
  try {
    const st = JSON.parse(r.stdout).streams[0];
    let w = st.width, h = st.height;
    const [sn, sd] = String(st.sample_aspect_ratio || '1:1').split(':').map(Number);
    if (sn > 0 && sd > 0) w = Math.round((w * sn) / sd);
    const rot = Math.abs(Number(st.side_data_list?.find(x => 'rotation' in x)?.rotation ?? st.tags?.rotate ?? 0)) % 180;
    return rot === 90 ? { w: h, h: w } : { w, h };
  } catch { return { w: 0, h: 0 }; }
}

/** Fondo: 'difuminado' (por defecto), 'negro' o un color '#rrggbb'. */
function normalizarFondo(f) {
  const v = String(f || '').trim().toLowerCase();
  if (v === 'negro') return '#000000';
  return /^#[0-9a-f]{6}$/.test(v) ? v : 'difuminado';
}

/**
 * Render de un clip: fondo difuminado + video centrado + textos.
 * normalizar=true (Top): 60 fps, audio 48 kHz estéreo con loudnorm (o silencio si el clip no tiene audio).
 */
async function renderClip({ entrada, salida, hook, credito, badge, lista = null, capa = null, secciones = null, intermedio = false, fondo = 'difuminado', orient = 'vertical', normalizar = false, tag, onProgreso }) {
  const enc = await detectarEncoder();
  if (!enc.ffmpeg) throw httpError(500, 'No encontré FFmpeg. Instálalo y agrégalo al PATH (o define FFMPEG_PATH).');
  const vertical = orient !== 'horizontal';
  const W = vertical ? 1080 : 1920, H = vertical ? 1920 : 1080;
  const [durOriginal, conAudio, dims] = await Promise.all([duracion(entrada), tieneAudio(entrada), dimensiones(entrada)]);
  // capa = PNG transparente con todos los textos, dibujado por el navegador (así los emojis salen a color).
  // Sin capa, los textos los escribe FFmpeg (drawtext, sin emojis).
  let dibujos = [], temporales = [], capaPng = null;
  if (capa) {
    capaPng = `${tag}_capa.png`;
    fs.writeFileSync(path.join(TMP, capaPng), capa);
    temporales.push(capaPng);
  } else ({ dibujos, temporales } = capasTexto(tag, { hook, credito, badge, lista, vertical, srcW: dims.w, srcH: dims.h }));
  const colorFondo = normalizarFondo(fondo);
  // Secciones del clip (segundos).
  //  · 1 sección: -ss/-t antes de -i (búsqueda rápida y exacta porque se recodifica)
  //  · varias:    trim/atrim de cada parte + concat dentro del mismo filtro
  const secs = Array.isArray(secciones) && secciones.length ? secciones : null;
  const varias = secs && secs.length > 1;
  let corte = [], total = durOriginal, vIn = '[0:v]', aIn = '[0:a]';
  const previos = [];
  if (secs && !varias) {
    const { a, b } = secs[0];
    corte = [...(a > 0 ? ['-ss', a.toFixed(3)] : []), ...(b ? ['-t', (b - a).toFixed(3)] : [])];
    total = b ? b - a : Math.max(0.1, durOriginal - a);
  } else if (varias) {
    secs.forEach(({ a, b }, i) => {
      previos.push(`[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      if (conAudio) previos.push(`[0:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    });
    previos.push(`${secs.map((_, i) => `[v${i}]${conAudio ? `[a${i}]` : ''}`).join('')}concat=n=${secs.length}:v=1:a=${conAudio ? 1 : 0}[vsrc]${conAudio ? '[asrc]' : ''}`);
    vIn = '[vsrc]'; aIn = '[asrc]';
    total = secs.reduce((t, x) => t + (x.b - x.a), 0);
  }

  const idxCapa = normalizar && !conAudio ? 2 : 1;   // la imagen va después del video (y del silencio, si hay)
  const cadena = capaPng
    ? `${normalizar ? 'fps=60,' : ''}null[pre];[pre][${idxCapa}:v]overlay=0:0:format=auto,format=yuv420p`
    : [normalizar ? 'fps=60' : null, ...(dibujos.length ? dibujos : ['null']), 'format=yuv420p'].filter(Boolean).join(',');
  const filtro = [
    ...previos,
    `${vIn}split=2[a][b]`,
    colorFondo === 'difuminado'
      ? `[a]scale=${W / 2}:${H / 2}:force_original_aspect_ratio=increase,crop=${W / 2}:${H / 2},boxblur=20:3,eq=brightness=-0.08,scale=${W}:${H},setsar=1[bg]`
      : `[a]scale=${W}:${H},setsar=1,drawbox=x=0:y=0:w=iw:h=ih:color=0x${colorFondo.slice(1)}@1:t=fill[bg]`,
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[base]',
    `[base]${cadena}[out]`,
  ];
  const entradas = [...corte, '-i', entrada];
  let audio;
  if (!normalizar) audio = varias ? (conAudio ? ['-map', '[asrc]'] : []) : ['-map', '0:a?'];
  else if (conAudio) {
    filtro.push(`${aIn}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
    audio = ['-map', '[aout]'];
  } else {
    entradas.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    audio = ['-map', '1:a', '-shortest'];
  }
  if (capaPng) entradas.push('-i', capaPng);

  // los pedazos intermedios del Top van a calidad más alta: después se vuelven a codificar al unirlos
  const codec = codecVideo(enc, intermedio ? 'alta' : 'normal');
  const extra = normalizar ? ['-r', '60', '-ar', '48000', '-ac', '2', '-video_track_timescale', '15360'] : [];

  const args = ['-hide_banner', '-y', ...entradas, '-filter_complex', filtro.join(';'), '-map', '[out]', ...audio,
    ...codec, '-c:a', 'aac', '-b:a', '192k', ...extra, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', salida];

  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { cwd: TMP, windowsHide: true });
    let errLog = '';
    p.stderr.on('data', d => { errLog = (errLog + d).slice(-4000); });
    p.stdout.on('data', d => {
      const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
      if (m && total && onProgreso) {
        const us = Number(m[m.length - 1].split('=')[1]);
        onProgreso(Math.min(99, Math.round((us / 1e6 / total) * 100)));
      }
    });
    p.on('error', e => reject(e));
    p.on('close', code => {
      for (const tf of temporales) fsp.unlink(path.join(TMP, tf)).catch(() => {});
      if (code === 0) return resolve(salida);
      fsp.unlink(salida).catch(() => {});
      reject(new Error(ultimasLineas(errLog) || `FFmpeg terminó con código ${code}`));
    });
  });
}

function codecVideo(enc, calidad = 'normal') {
  const alta = calidad === 'alta';
  return enc.gpu
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', alta ? '16' : '21', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', alta ? '15' : '20'];
}

/**
 * Une los pedazos del Top recodificando con el filtro concat (no con "-c copy"):
 * la línea de tiempo queda continua desde 0, sin cuadros negros al inicio ni huecos entre clips.
 */
async function unirSegmentos(segmentos, salida, onProgreso) {
  const enc = await detectarEncoder();
  const total = (await Promise.all(segmentos.map(sg => duracion(path.join(TMP, sg))))).reduce((a, b) => a + b, 0);
  const args = ['-hide_banner', '-y', ...segmentos.flatMap(sg => ['-i', sg]),
    '-filter_complex', `${segmentos.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('')}concat=n=${segmentos.length}:v=1:a=1[v][a]`,
    '-map', '[v]', '-map', '[a]', ...codecVideo(enc), '-r', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', salida];
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { cwd: TMP, windowsHide: true });
    let errLog = '';
    p.stderr.on('data', d => { errLog = (errLog + d).slice(-4000); });
    p.stdout.on('data', d => {
      const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
      if (m && total && onProgreso) onProgreso(Math.min(99, Math.round((Number(m[m.length - 1].split('=')[1]) / 1e6 / total) * 100)));
    });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) return resolve();
      fsp.unlink(salida).catch(() => {});
      reject(new Error('Falló la unión: ' + ultimasLineas(errLog)));
    });
  });
}

module.exports = { encoderPromise, detectarEncoder, buscarFuente, escFiltro, sinEmojis, envolver, duracion, tieneAudio, TAMANOS_HOOK, disenoVertical, disenoLista, recortar, capasTexto, dimensiones, normalizarFondo, renderClip, codecVideo, unirSegmentos };
