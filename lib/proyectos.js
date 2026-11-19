/**
 * 1Studio · Video largo (proyectos armados en torno a la voz)
 *
 * Flujo: guion JSON (Gemini) → una sola voz (AI Studio) → alinear_voz.py marca dónde empieza cada sección
 * → asignas clips de Gaming/Raw a cada toma → se exporta el video largo 16:9 (+ .srt y capítulos)
 * y un Short vertical por sección, con subtítulos palabra por palabra.
 * Cada sección dura exactamente lo que dura su parte de la voz.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, TMP, DIRS, FFMPEG, FFPROBE, resolveDir, CARPETAS } = require('./config');
const { httpError, ruta, archivoSeguro, escribirJSON, ultimasLineas, sello, reservar, liberar, rutaMeta, aLaPapelera } = require('./util');
const { jobs, slug, nuevoJob, terminar, encolar } = require('./trabajos');
const { sinEmojis, escFiltro, buscarFuente, duracion, tieneAudio, detectarEncoder, codecVideo, unirSegmentos } = require('./ffmpeg');
const { avisar } = require('./eventos');
const { herramientas } = require('./herramientas');

module.exports = function montarProyectos(ctx) {
  const { app, express } = ctx;

  const PROY = resolveDir(CARPETAS.gtavi, 'proyectos');
  const SCRIPT = path.join(ROOT, 'python', 'alinear_voz.py');
  const FPS = 60;
  const AUDIO_EXT = ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.webm', '.opus'];

  // ───────── almacenamiento ─────────
  const dirProyecto = id => {
    if (!/^[\w-]{3,80}$/.test(String(id))) throw httpError(400, 'Proyecto inválido');
    const d = path.join(PROY, id);
    if (!fs.existsSync(path.join(d, 'proyecto.json'))) throw httpError(404, 'No existe ese proyecto');
    return d;
  };
  const leer = async id => JSON.parse(await fsp.readFile(path.join(dirProyecto(id), 'proyecto.json'), 'utf8'));
  const guardar = (p) => escribirJSON(path.join(PROY, p.id, 'proyecto.json'), p);
  async function leerAlineacion(id) {
    try { return JSON.parse(await fsp.readFile(path.join(dirProyecto(id), 'alineacion.json'), 'utf8')); } catch { return null; }
  }
  const rutaVoz = p => (p.voz ? path.join(PROY, p.id, p.voz) : null);

  // ───────── crear desde el JSON de Gemini ─────────
  function parsearGuion(texto) {
    const t = String(texto || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let d;
    try { d = JSON.parse(t); } catch {
      const a = t.indexOf('{'), b = t.lastIndexOf('}');
      try { d = JSON.parse(t.slice(a, b + 1)); } catch (e) { throw httpError(400, 'El JSON del guion no es válido: ' + e.message); }
    }
    const secs = Array.isArray(d?.secciones) ? d.secciones : null;
    if (!secs?.length) throw httpError(400, 'El guion debe traer "secciones" con su "narracion".');
    // ¿pegaron la plantilla del prompt en vez de la respuesta de Gemini?
    const PLANTILLA = /texto exacto que voy a narrar|título para youtube|título corto que se verá en pantalla|qué se debe ver en pantalla/i;
    if (secs.some(s => PLANTILLA.test(String(s?.narracion || ''))) || PLANTILLA.test(String(d.titulo || ''))) {
      throw httpError(400, 'Eso es la plantilla de ejemplo del prompt, no el guion. Pega la RESPUESTA de Gemini (el JSON con tu guion ya escrito). '
        + 'Si Gemini te devolvió la plantilla tal cual, pídele: "Ahora llena esa estructura con el guion completo del tema".');
    }
    const shorts = new Map((Array.isArray(d.shorts) ? d.shorts : []).map(s => [Number(s.seccion), s]));
    return {
      titulo: String(d.titulo || 'Video sin título').trim(),
      miniatura: String(d.miniatura || '').trim(),
      secciones: secs.map((s, i) => {
        const id = Number(s.id) || i + 1;
        const tomas = (Array.isArray(s.tomas) && s.tomas.length ? s.tomas : [{}]).slice(0, 2).map((tm, j) => ({
          etiqueta: String(tm.etiqueta || (j ? 'GTA VI' : '')).trim(),
          fuente: String(tm.fuente || '').trim(),
          busqueda: Array.isArray(tm.busqueda) ? tm.busqueda.map(String) : [],
          descripcion: String(tm.descripcion || '').trim(),
          clips: [],
        }));
        const plantilla = s.plantilla === 'comparacion' || tomas.length === 2 ? 'comparacion' : 'clip';
        const sh = shorts.get(id);
        return {
          id, titulo: String(s.titulo || '').trim(), narracion: String(s.narracion || '').trim(), plantilla,
          tomas: plantilla === 'comparacion' ? [tomas[0], tomas[1] || { etiqueta: 'GTA VI', fuente: '', busqueda: [], descripcion: '', clips: [] }] : [tomas[0]],
          short: !!sh || plantilla === 'comparacion',
          shortInfo: { gancho: String(sh?.gancho || s.titulo || '').trim(), titulo_post: String(sh?.titulo_post || '').trim(), descripcion_post: String(sh?.descripcion_post || '').trim() },
        };
      }).filter(s => s.narracion),
    };
  }

  // ───────── alineación de la voz ─────────
  const alineando = new Map();   // id → job
  async function alinear(id, modelo) {
    if (alineando.has(id)) throw httpError(409, 'Ya se está alineando la voz de este proyecto.');
    const p = await leer(id);
    if (!p.voz) throw httpError(400, 'Primero sube la voz.');
    const h = await herramientas(true);
    if (!h.python.ok) throw httpError(503, 'Python no está instalado: hace falta para alinear la voz.');
    const d = path.join(PROY, id);
    const guion = path.join(d, 'guion_alinear.json');
    await fsp.writeFile(guion, JSON.stringify(p.secciones.map(s => ({ id: s.id, narracion: s.narracion }))), 'utf8');
    const job = nuevoJob('alinear', `Alinear voz · ${p.titulo}`, { proyecto: id });
    alineando.set(id, job);
    job.estado = 'procesando'; job.mensaje = 'Transcribiendo la voz…';
    const total = (await duracion(rutaVoz(p))) || 1;
    const args = [...h.python.pre, SCRIPT, '--audio', rutaVoz(p), '--guion', guion, '--out', path.join(d, 'alineacion.json'),
      '--modelo', ['base', 'small', 'medium'].includes(modelo) ? modelo : 'auto', '--ffprobe', FFPROBE, '--ffmpeg', FFMPEG];
    const proc = spawn(h.python.cmd, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let buf = '', err = '';
    job.avisos = [];
    proc.stdout.on('data', x => {
      buf += x; const ls = buf.split(/\r?\n/); buf = ls.pop();
      for (const l of ls) {
        let ev; try { ev = JSON.parse(l); } catch { continue; }
        if (ev.tipo === 'progreso') job.progreso = Math.min(97, Math.round((ev.t / total) * 100));
        if (ev.tipo === 'modelo') job.mensaje = `Whisper "${ev.modelo}" en ${String(ev.dispositivo).toUpperCase()}…`;
        if (ev.tipo === 'aviso') job.avisos.push(ev.mensaje);
      }
    });
    proc.stderr.on('data', x => { err = (err + x).slice(-6000); });
    proc.on('error', e => { alineando.delete(id); terminar(job, e); });
    proc.on('close', async code => {
      alineando.delete(id);
      if (code !== 0) return terminar(job, new Error(ultimasLineas(err, 6) || `alinear_voz.py terminó con código ${code}`));
      const al = await leerAlineacion(id);
      job.mensaje = al?.aproximado ? 'Listo (aproximado: sin Whisper)' : `Listo · coincidencia ${Math.round((al?.coincidencia || 0) * 100)} %`;
      terminar(job);
    });
    return job;
  }

  // ───────── diseño de cada plantilla (los textos los dibuja el navegador con las mismas medidas) ─────────
  // orient h = 1920×1080 (video largo) · v = 1080×1920 (short)
  const LAYOUT = {
    h: { W: 1920, H: 1080, clip: [{ x: 0, y: 0, w: 1920, h: 1080 }], comparacion: [{ x: 16, y: 275, w: 944, h: 531 }, { x: 960, y: 275, w: 944, h: 531 }], subY: null },
    v: { W: 1080, H: 1920, clip: [{ x: 0, y: 656, w: 1080, h: 608 }], comparacion: [{ x: 0, y: 300, w: 1080, h: 608 }, { x: 0, y: 1010, w: 1080, h: 608 }], subY: { clip: 1330, comparacion: 920 } },
  };

  /** Subtítulos: grupos de hasta 3 palabras (o 18 letras), cortando en signos de puntuación. */
  function grupos(palabras, t0, D) {
    const out = [];
    let g = [];
    const cerrar = () => { if (g.length) out.push(g); g = []; };
    for (const w of palabras) {
      const largo = g.map(x => x.w).join(' ').length + w.w.length;
      if (g.length && (g.length >= 3 || largo > 18)) cerrar();
      g.push(w);
      if (/[.,!?;:…]$/.test(w.w)) cerrar();
    }
    cerrar();
    return out.map((grupo, i) => {
      const a = Math.max(0, grupo[0].s - t0);
      const b = i < out.length - 1 ? Math.max(a + 0.05, out[i + 1][0].s - t0) : Math.min(D, grupo[grupo.length - 1].e - t0 + 0.4);
      return { texto: sinEmojis(grupo.map(x => x.w).join(' ')).replace(/[«»"]/g, ''), a, b };
    }).filter(x => x.texto && x.b > x.a);
  }

  // ── Bordes negros quemados en el video (barras arriba/abajo o a los lados) ──
  // Se detectan con cropdetect en el tramo que se usa; si el resultado es razonable, se recortan antes de escalar.
  const bordes = new Map();
  function detectarBordes(file, a, len) {
    let mt = 0; try { mt = fs.statSync(file).mtimeMs; } catch { /* nada */ }
    const k = `${file}|${mt}|${a.toFixed(1)}|${len.toFixed(1)}`;
    if (bordes.has(k)) return bordes.get(k);
    const prom = new Promise(resolve => {
      let err = '';
      const p = spawn(FFMPEG, ['-hide_banner', '-nostats', '-ss', a.toFixed(3), '-t', Math.min(len, 30).toFixed(3), '-i', file,
        '-vf', 'fps=2,cropdetect=limit=24:round=2:reset=0', '-an', '-f', 'null', '-'], { windowsHide: true });
      p.stderr.on('data', d => { err = (err + d).slice(-4000); });
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const m = [...err.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
        const w0 = err.match(/Stream #0:\d.*Video:.*?(\d{2,5})x(\d{2,5})/);
        if (!m || !w0) return resolve(null);
        const [cw, ch, cx, cy] = m.slice(1).map(Number), W0 = Number(w0[1]), H0 = Number(w0[2]);
        const quita = 1 - (cw * ch) / (W0 * H0);
        // solo si hay borde real (>1.5 %) y no se come la imagen (máx. 45 %)
        resolve(quita > 0.015 && quita < 0.45 && cw >= W0 * 0.5 && ch >= H0 * 0.5 ? { cw, ch, cx, cy } : null);
      });
    });
    bordes.set(k, prom);
    return prom;
  }

  async function renderSeccion({ sec, t0, D, voz, orient, capa, palabras, final, tag, salida, onProgreso, audio = {} }) {
    const volClips = Math.min(1, Math.max(0, Number(audio.clips ?? 0.35)));
    const enc = await detectarEncoder();
    if (!enc.ffmpeg) throw httpError(500, 'No encontré FFmpeg.');
    const L = LAYOUT[orient], { W, H } = L;
    const paneles = L[sec.plantilla] || L.clip;
    const entradas = [], filtros = [], temporales = [];
    let n = 0;
    const panelesOk = [];
    for (const [pi, pan] of paneles.entries()) {
      const toma = sec.tomas[pi];
      const clips = (toma?.clips || []).filter(c => c.archivo);
      if (!clips.length) throw new Error(`"${sec.titulo || 'Sección ' + sec.id}" no tiene clips en la toma ${toma?.etiqueta || pi + 1}.`);
      const vs = [];
      for (const [k, c] of clips.entries()) {
        const file = archivoSeguro(DIRS.gtavi.raw, c.archivo);
        const a = Math.max(0, Number(c.a) || 0);
        const len = Math.max(0.2, (Number(c.b) || (await duracion(file))) - a);
        entradas.push('-ss', a.toFixed(3), '-t', len.toFixed(3), '-i', file);
        const idx = n++;
        const b = c.bordes === false ? null : await detectarBordes(file, a, len);
        const quitar = b ? `crop=${b.cw}:${b.ch}:${b.cx}:${b.cy},` : '';
        filtros.push(`[${idx}:v]${quitar}scale=${pan.w}:${pan.h}:force_original_aspect_ratio=increase,crop=${pan.w}:${pan.h},setsar=1,fps=${FPS},format=yuv420p[p${pi}v${k}]`);
        filtros.push((c.sonido && volClips > 0 && await tieneAudio(file))
          ? `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${len.toFixed(3)}[p${pi}a${k}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${len.toFixed(3)}[p${pi}a${k}]`);
        vs.push(k);
      }
      filtros.push(`${vs.map(k => `[p${pi}v${k}][p${pi}a${k}]`).join('')}concat=n=${vs.length}:v=1:a=1[p${pi}vc][p${pi}ac]`);
      // si el material es más corto que la voz, se congela el último cuadro
      filtros.push(`[p${pi}vc]tpad=stop_mode=clone:stop_duration=${D.toFixed(3)},trim=duration=${D.toFixed(3)},setpts=PTS-STARTPTS[p${pi}]`);
      filtros.push(`[p${pi}ac]apad,atrim=duration=${D.toFixed(3)},asetpts=PTS-STARTPTS[p${pi}g]`);
      panelesOk.push({ pi, pan });
    }
    // voz (solo el tramo de esta sección)
    const iVoz = n++;
    entradas.push('-ss', t0.toFixed(3), '-t', D.toFixed(3), '-i', voz);
    let iCapa = null;
    if (capa) {
      const f = `${tag}_capa.png`;
      fs.writeFileSync(path.join(TMP, f), capa);
      temporales.push(f);
      iCapa = n++;
      entradas.push('-i', f);
    }

    // fondo: difuminado del propio clip (short de una toma) o color oscuro
    let cur;
    if (orient === 'v' && sec.plantilla !== 'comparacion') {
      filtros.push(`[p0]split=2[p0f][p0bg]`, `[p0bg]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,boxblur=20:3,eq=brightness=-0.08,scale=1080:1920,setsar=1[bg]`);
      cur = 'bg';
    } else {
      filtros.push(`color=c=0x0d0d12:s=${W}x${H}:r=${FPS}:d=${D.toFixed(3)},format=yuv420p[bg]`);
      cur = 'bg';
    }
    const etiquetaPanel = pi => (orient === 'v' && sec.plantilla !== 'comparacion' && pi === 0 ? 'p0f' : `p${pi}`);
    for (const { pi, pan } of panelesOk) {
      filtros.push(`[${cur}][${etiquetaPanel(pi)}]overlay=${pan.x}:${pan.y}:shortest=1[o${pi}]`);
      cur = `o${pi}`;
    }
    if (iCapa !== null) { filtros.push(`[${cur}][${iCapa}:v]overlay=0:0:format=auto[oc]`); cur = 'oc'; }

    // subtítulos (solo shorts)
    const dibujos = [];
    if (palabras?.length && orient === 'v') {
      const fuente = buscarFuente();
      const fontArg = fuente ? `fontfile=${escFiltro(fuente)}:` : '';
      const y = L.subY[sec.plantilla] || L.subY.clip;
      grupos(palabras, t0, D).forEach((g, i) => {
        const tf = `${tag}_sub${i}.txt`;
        fs.writeFileSync(path.join(TMP, tf), g.texto.toUpperCase(), 'utf8');
        temporales.push(tf);
        dibujos.push(`drawtext=${fontArg}textfile=${escFiltro(tf)}:expansion=none:fontsize=74:fontcolor=white:borderw=8:bordercolor=black:` +
          `shadowx=0:shadowy=5:shadowcolor=black@0.6:x=(w-text_w)/2:y=${y}:enable='between(t,${g.a.toFixed(3)},${g.b.toFixed(3)})'`);
      });
    }
    filtros.push(`[${cur}]${dibujos.length ? dibujos.join(',') + ',' : ''}format=yuv420p[vout]`);

    // audio: juego bajito que además se agacha cuando hablas (sidechain) + tu voz al frente
    const g = panelesOk.length > 1 ? (filtros.push(`[p0g][p1g]amix=inputs=2:duration=first:dropout_transition=0[gm]`), 'gm') : 'p0g';
    filtros.push(`[${g}]volume=${volClips.toFixed(2)}[gv]`);
    filtros.push(`[${iVoz}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${D.toFixed(3)},asplit=2[v1][vsc]`);
    filtros.push(`[gv][vsc]sidechaincompress=threshold=0.02:ratio=12:attack=10:release=400[duck]`);
    filtros.push(`[duck][v1]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95[aout]`);

    const args = ['-hide_banner', '-y', ...entradas, '-filter_complex', filtros.join(';'), '-map', '[vout]', '-map', '[aout]',
      ...codecVideo(enc, final ? 'normal' : 'alta'), '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-t', D.toFixed(3), ...(final ? ['-movflags', '+faststart'] : []), '-progress', 'pipe:1', '-nostats', salida];

    return new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, args, { cwd: TMP, windowsHide: true });
      let errLog = '';
      p.stderr.on('data', d => { errLog = (errLog + d).slice(-5000); });
      p.stdout.on('data', d => {
        const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
        if (m && onProgreso) onProgreso(Math.min(99, Math.round((Number(m[m.length - 1].split('=')[1]) / 1e6 / D) * 100)));
      });
      p.on('error', reject);
      p.on('close', code => {
        for (const f of temporales) fsp.unlink(path.join(TMP, f)).catch(() => {});
        if (code === 0) return resolve(salida);
        fsp.unlink(salida).catch(() => {});
        reject(new Error(ultimasLineas(errLog, 6) || `FFmpeg terminó con código ${code}`));
      });
    });
  }

  // ───────── música de fondo: en loop, bajita, se agacha cuando hablas y se desvanece al final ─────────
  const rutaMusica = p => (p.audio?.musica ? path.join(PROY, p.id, p.audio.musica) : null);
  async function ponerMusica(entrada, salida, p, onProgreso) {
    const D = await duracion(entrada);
    const vol = Math.min(1, Math.max(0.01, Number(p.audio?.volMusica ?? 0.12)));
    const fin = Math.max(0, D - 4);
    const filtro = [
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${D.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `volume=${vol.toFixed(3)},afade=t=in:d=1.5,afade=t=out:st=${fin.toFixed(3)}:d=${Math.min(4, D).toFixed(3)}[m]`,
      `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[a0][sc]`,
      `[m][sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=700[md]`,
      `[a0][md]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95[a]`,
    ].join(';');
    const args = ['-hide_banner', '-y', '-i', entrada, '-stream_loop', '-1', '-i', rutaMusica(p), '-filter_complex', filtro,
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-t', D.toFixed(3), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', salida];
    await new Promise((resolve, reject) => {
      const pr = spawn(FFMPEG, args, { cwd: TMP, windowsHide: true });
      let errLog = '';
      pr.stderr.on('data', d => { errLog = (errLog + d).slice(-5000); });
      pr.stdout.on('data', d => {
        const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
        if (m && onProgreso) onProgreso(Math.min(99, Math.round((Number(m[m.length - 1].split('=')[1]) / 1e6 / D) * 100)));
      });
      pr.on('error', reject);
      pr.on('close', code => (code === 0 ? resolve() : reject(new Error('Música: ' + (ultimasLineas(errLog, 4) || `FFmpeg terminó con código ${code}`)))));
    });
  }

  // ───────── subtítulos .srt y capítulos de YouTube ─────────
  const tc = (t, sep = ',') => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`;
  };
  function srt(palabras) {
    const lineas = [];
    let g = [];
    const cerrar = () => { if (g.length) lineas.push(g); g = []; };
    for (const w of palabras) {
      if (g.length && (g.length >= 8 || g.map(x => x.w).join(' ').length + w.w.length > 42)) cerrar();
      g.push(w);
      if (/[.!?…]$/.test(w.w)) cerrar();
    }
    cerrar();
    // sin renglones huérfanos: una o dos palabras sueltas se pegan al renglón anterior si cabe
    for (let i = lineas.length - 1; i > 0; i--) {
      if (lineas[i].length <= 2 && !/[.!?…]$/.test(lineas[i - 1][lineas[i - 1].length - 1].w) &&
          [...lineas[i - 1], ...lineas[i]].map(x => x.w).join(' ').length <= 52) {
        lineas[i - 1].push(...lineas[i]); lineas.splice(i, 1);
      }
    }
    return lineas.map((l, i) => `${i + 1}\n${tc(l[0].s)} --> ${tc(i < lineas.length - 1 ? Math.min(l[l.length - 1].e + 0.3, lineas[i + 1][0].s) : l[l.length - 1].e + 0.3)}\n${l.map(x => x.w).join(' ')}\n`).join('\n');
  }
  const mmss = t => { t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(t % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`; };

  // ───────── exportar ─────────
  const dataPng = x => (typeof x === 'string' && x.startsWith('data:image/png;base64,') ? Buffer.from(x.slice(22), 'base64') : null);

  async function exportar(id, { tipo, secciones: elegidas, capas }) {
    const p = await leer(id);
    const al = await leerAlineacion(id);
    if (!p.voz || !al) throw httpError(400, 'Primero sube la voz y espera a que se alinee.');
    if (al.secciones.length !== p.secciones.length) throw httpError(400, 'La voz se alineó con otra versión del guion. Vuelve a alinear.');
    const voz = rutaVoz(p);
    const audio = p.audio || {};
    const conMusica = !!(rutaMusica(p) && fs.existsSync(rutaMusica(p)));
    const largo = tipo !== 'shorts';
    const lista = p.secciones.map((s, i) => ({ s, i, t: al.secciones[i] }))
      .filter(x => largo || (Array.isArray(elegidas) ? elegidas.includes(x.s.id) : x.s.short));
    if (!lista.length) throw httpError(400, 'No elegiste secciones para los shorts.');
    for (const { s } of lista) {
      const faltan = s.tomas.slice(0, s.plantilla === 'comparacion' ? 2 : 1).filter(t => !t.clips?.length);
      if (faltan.length) throw httpError(400, `"${s.titulo || 'Sección ' + s.id}" no tiene clips en: ${faltan.map(t => t.etiqueta || 'toma').join(', ')}.`);
    }
    const capa = (sid, o) => dataPng(capas?.[sid]?.[o]);
    const base = slug(p.titulo, 40) || 'video';
    const job = nuevoJob(largo ? 'largo' : 'shorts', largo ? `Video largo · ${p.titulo}` : `${lista.length} shorts · ${p.titulo}`,
      { proyecto: id, items: lista.map(({ s }) => ({ archivo: s.titulo || `Sección ${s.id}`, estado: 'en cola', progreso: 0 })) });
    const n = lista.length;
    const avance = (k, x) => { job.items[k].progreso = x; job.progreso = Math.round(((k + x / 100) / n) * (largo ? 85 : 100)); };

    encolar(async () => {
      job.estado = 'procesando'; avisar();
      if (largo) {
        const salida = reservar(DIRS.gtavi.listos, `Largo_${base}_${sello()}.mp4`);
        const segs = [];
        try {
          for (const [k, { s, t }] of lista.entries()) {
            job.items[k].estado = 'procesando'; job.mensaje = `${k + 1}/${n} · ${s.titulo}`; avisar();
            const seg = `largo${job.id}_${String(k).padStart(2, '0')}.mp4`;
            await renderSeccion({ sec: s, t0: t.t0, D: t.t1 - t.t0, voz, orient: 'h', capa: capa(s.id, 'h'), final: false, audio,
              tag: `j${job.id}_${k}`, salida: path.join(TMP, seg), onProgreso: x => avance(k, x) });
            segs.push(seg); job.items[k].estado = 'listo'; avance(k, 100); avisar();
          }
          job.mensaje = 'Uniendo secciones…'; avisar();
          if (conMusica) {
            const unido = `largo${job.id}_unido.mp4`;
            segs.push(unido);
            await unirSegmentos(segs.slice(0, -1), path.join(TMP, unido), x => { job.progreso = 85 + Math.round(x * 0.1); });
            job.mensaje = 'Poniendo la música…'; avisar();
            await ponerMusica(path.join(TMP, unido), salida, p, x => { job.progreso = 95 + Math.round(x * 0.05); });
          } else {
            await unirSegmentos(segs, salida, x => { job.progreso = 85 + Math.round(x * 0.15); });
          }
          const capitulos = lista.map(({ s, t }, k) => `${mmss(k === 0 ? 0 : t.t0)} ${s.titulo || 'Intro'}`).join('\n');
          const titulo = p.titulo;
          const descripcion = `Capítulos:\n${capitulos}\n\n#GTA6 #GTAVI #GTA5 #GTA #Gaming`;
          await escribirJSON(rutaMeta(DIRS.gtavi.listos, path.basename(salida)), { completo: `${titulo}\n\n${descripcion}`, titulo, descripcion });
          await fsp.writeFile(salida.replace(/\.mp4$/i, '.srt'), srt(al.palabras), 'utf8');
          job.salida = path.basename(salida);
          job.mensaje = `${path.basename(salida)} + subtítulos .srt`;
        } finally {
          for (const sg of segs) fsp.unlink(path.join(TMP, sg)).catch(() => {});
          liberar(salida);
        }
        return;
      }
      let ok = 0;
      for (const [k, { s, i, t }] of lista.entries()) {
        job.items[k].estado = 'procesando'; job.mensaje = `${k + 1}/${n} · ${s.titulo}`; avisar();
        const salida = reservar(DIRS.gtavi.listos, `${base}_short_${String(i + 1).padStart(2, '0')}.mp4`);
        try {
          const tmpShort = conMusica ? path.join(TMP, `short${job.id}_${k}.mp4`) : salida;
          try {
            await renderSeccion({ sec: s, t0: t.t0, D: t.t1 - t.t0, voz, orient: 'v', capa: capa(s.id, 'v'), final: true, audio,
              palabras: al.palabras.filter(w => w.sec === i), tag: `j${job.id}_${k}`, salida: tmpShort, onProgreso: x => avance(k, conMusica ? x * 0.9 : x) });
            if (conMusica) await ponerMusica(tmpShort, salida, p, x => avance(k, 90 + x * 0.1));
          } finally { if (conMusica) fsp.unlink(tmpShort).catch(() => {}); }
          const titulo = s.shortInfo?.titulo_post || s.titulo, descripcion = s.shortInfo?.descripcion_post || '#GTA6 #GTAVI #GTA5 #GTA #Gaming';
          await escribirJSON(rutaMeta(DIRS.gtavi.listos, path.basename(salida)), { completo: [titulo, descripcion].filter(Boolean).join('\n\n'), titulo, descripcion });
          job.items[k].estado = 'listo'; ok++;
        } catch (e) { job.items[k].estado = 'error'; job.items[k].error = e.message; }
        finally { liberar(salida); avance(k, 100); avisar(); }
      }
      if (!ok) throw new Error('No se pudo exportar ningún short.');
      job.mensaje = `${ok}/${n} shorts en Gaming/Listos`;
    }).then(() => terminar(job), e => terminar(job, e));
    return job;
  }

  // ───────── API ─────────
  app.get('/api/proyectos', ruta(async (_req, res) => {
    const out = [];
    for (const d of await fsp.readdir(PROY, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const p = JSON.parse(await fsp.readFile(path.join(PROY, d.name, 'proyecto.json'), 'utf8'));
        out.push({ id: p.id, titulo: p.titulo, creado: p.creado, secciones: p.secciones.length, voz: !!p.voz,
          alineado: fs.existsSync(path.join(PROY, d.name, 'alineacion.json')) });
      } catch { /* carpeta sin proyecto */ }
    }
    res.json(out.sort((a, b) => String(b.creado).localeCompare(String(a.creado))));
  }));

  app.post('/api/proyectos', ruta(async (req, res) => {
    const g = parsearGuion(req.body?.json);
    const id = `${slug(g.titulo, 40) || 'video'}-${sello()}`.replace(/[^\w-]/g, '_');
    const p = { id, creado: new Date().toISOString(), voz: null, ...g };
    await fsp.mkdir(path.join(PROY, id), { recursive: true });
    await guardar(p);
    res.json(p);
  }));

  app.get('/api/proyectos/:id', ruta(async (req, res) => {
    const p = await leer(req.params.id);
    const al = await leerAlineacion(req.params.id);
    const job = [...jobs.values()].reverse().find(j => j.proyecto === p.id && j.tipo === 'alinear');
    res.json({ ...p, alineacion: al && { ...al, palabras: undefined, nPalabras: al.palabras.length },
      alineando: job && (job.estado === 'procesando' || job.estado === 'en cola') ? job : null });
  }));

  // Guarda lo que editas (títulos, plantilla, etiquetas, clips, shorts); la narración no se toca desde aquí
  app.put('/api/proyectos/:id/secciones', ruta(async (req, res) => {
    const p = await leer(req.params.id);
    const nuevas = Array.isArray(req.body?.secciones) ? req.body.secciones : [];
    for (const s of p.secciones) {
      const x = nuevas.find(y => y.id === s.id);
      if (!x) continue;
      if (typeof x.titulo === 'string') s.titulo = x.titulo.slice(0, 120);
      if (x.plantilla === 'clip' || x.plantilla === 'comparacion') s.plantilla = x.plantilla;
      if (typeof x.short === 'boolean') s.short = x.short;
      if (x.shortInfo && typeof x.shortInfo === 'object') {
        for (const k of ['gancho', 'titulo_post', 'descripcion_post']) if (typeof x.shortInfo[k] === 'string') s.shortInfo[k] = x.shortInfo[k];
      }
      if (Array.isArray(x.tomas)) {
        while (s.tomas.length < Math.min(2, x.tomas.length)) s.tomas.push({ etiqueta: '', fuente: '', busqueda: [], descripcion: '', clips: [] });
        x.tomas.slice(0, 2).forEach((t, j) => {
          if (typeof t.etiqueta === 'string') s.tomas[j].etiqueta = t.etiqueta.slice(0, 40);
          if (Array.isArray(t.clips)) {
            s.tomas[j].clips = t.clips.filter(c => c && typeof c.archivo === 'string')
              .map(c => ({ archivo: path.basename(c.archivo), a: Math.max(0, Number(c.a) || 0), b: Number(c.b) > 0 ? Number(c.b) : null, ...(c.sonido ? { sonido: true } : {}) }))
              .filter(c => c.b === null || c.b > c.a + 0.1);
          }
        });
      }
    }
    await guardar(p);
    avisar();
    res.json({ ok: true });
  }));

  // Voz: el navegador manda el archivo tal cual (sin formularios) y se alinea solo
  app.post('/api/proyectos/:id/voz', express.raw({ type: () => true, limit: '600mb' }), ruta(async (req, res) => {
    const p = await leer(req.params.id);
    const ext = path.extname(String(req.headers['x-nombre'] || '')).toLowerCase();
    if (!AUDIO_EXT.includes(ext)) throw httpError(400, `Formato de audio no soportado (${ext || 'sin extensión'}). Usa wav, mp3 o m4a.`);
    if (!req.body?.length) throw httpError(400, 'El audio llegó vacío.');
    if (p.voz) await fsp.unlink(rutaVoz(p)).catch(() => {});
    await fsp.unlink(path.join(PROY, p.id, 'alineacion.json')).catch(() => {});
    p.voz = 'voz' + ext;
    await fsp.writeFile(rutaVoz(p), req.body);
    await guardar(p);
    const job = await alinear(p.id, req.query.modelo);
    res.json({ ok: true, job });
  }));
  // Audio: volumen del sonido de los clips y música de fondo
  app.put('/api/proyectos/:id/audio', ruta(async (req, res) => {
    const p = await leer(req.params.id);
    p.audio = { ...(p.audio || {}) };
    if (req.body?.clips !== undefined) p.audio.clips = Math.min(1, Math.max(0, Number(req.body.clips) || 0));
    if (req.body?.volMusica !== undefined) p.audio.volMusica = Math.min(1, Math.max(0.01, Number(req.body.volMusica) || 0.12));
    await guardar(p);
    res.json(p.audio);
  }));
  app.post('/api/proyectos/:id/musica', express.raw({ type: () => true, limit: '300mb' }), ruta(async (req, res) => {
    const p = await leer(req.params.id);
    const nombre = decodeURIComponent(String(req.headers['x-nombre'] || ''));
    const ext = path.extname(nombre).toLowerCase();
    if (!AUDIO_EXT.includes(ext)) throw httpError(400, `Formato de audio no soportado (${ext || 'sin extensión'}). Usa mp3, wav o m4a.`);
    if (!req.body?.length) throw httpError(400, 'El audio llegó vacío.');
    if (rutaMusica(p)) await fsp.unlink(rutaMusica(p)).catch(() => {});
    p.audio = { ...(p.audio || {}), musica: 'musica' + ext, musicaNombre: path.basename(nombre).slice(0, 120) };
    await fsp.writeFile(rutaMusica(p), req.body);
    await guardar(p);
    res.json(p.audio);
  }));
  app.get('/api/proyectos/:id/musica', ruta(async (req, res) => {
    const p = await leer(req.params.id);
    if (!rutaMusica(p) || !fs.existsSync(rutaMusica(p))) throw httpError(404, 'Sin música');
    res.sendFile(rutaMusica(p));
  }));
  app.delete('/api/proyectos/:id/musica', ruta(async (req, res) => {
    const p = await leer(req.params.id);
    if (rutaMusica(p)) await fsp.unlink(rutaMusica(p)).catch(() => {});
    p.audio = { ...(p.audio || {}), musica: null, musicaNombre: null };
    await guardar(p);
    res.json(p.audio);
  }));
  // Miniatura: el navegador la arma en un canvas y la manda como PNG; se guarda junto a los videos en Listos
  app.post('/api/proyectos/:id/miniatura', express.raw({ type: () => true, limit: '20mb' }), ruta(async (req, res) => {
    const p = await leer(req.params.id);
    if (!req.body?.length || req.body.slice(1, 4).toString() !== 'PNG') throw httpError(400, 'La miniatura llegó vacía o no es PNG.');
    const nombre = `Miniatura_${slug(p.titulo, 40) || 'video'}_${sello()}.png`;
    await fsp.writeFile(path.join(DIRS.gtavi.listos, nombre), req.body);
    res.json({ ok: true, archivo: nombre });
  }));
  app.post('/api/proyectos/:id/alinear', ruta(async (req, res) => res.json(await alinear(req.params.id, req.body?.modelo))));
  app.get('/api/proyectos/:id/voz', ruta(async (req, res) => {
    const p = await leer(req.params.id);
    if (!p.voz) throw httpError(404, 'Sin voz');
    res.sendFile(rutaVoz(p));
  }));
  // Borrar un proyecto: su carpeta (guion, voz, alineación) va a la Papelera de reciclaje
  app.delete('/api/proyectos/:id', ruta(async (req, res) => {
    const d = dirProyecto(req.params.id);
    if (alineando.has(req.params.id)) throw httpError(409, 'Espera a que termine de alinearse la voz.');
    res.json({ ok: true, destino: await aLaPapelera(d) });
  }));
  app.post('/api/proyectos/:id/exportar', ruta(async (req, res) => res.json(await exportar(req.params.id, req.body || {}))));

  return { parsearGuion, grupos, srt };
};
