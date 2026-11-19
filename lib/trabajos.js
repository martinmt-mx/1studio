/** 1Studio · Trabajos y cola de render en serie: clip manual, lote individual y recopilación tipo Top. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { VIDEO_EXT, DIRS, TMP, ANALISIS_FILE } = require('./config');
const { META_VACIA, httpError, archivoSeguro, reservar, liberar, rutaMeta, escribirJSON, sello, SIN_EMOJI, aHandle, infoArchivo, creadorDeArchivo } = require('./util');
const { avisar } = require('./eventos');
const { detectarEncoder, sinEmojis, duracion, dimensiones, renderClip, unirSegmentos } = require('./ffmpeg');

// ───────────────────────── Trabajos + cola de render ─────────────────────────
const jobs = new Map();
let jobSeq = 0;
function nuevoJob(tipo, titulo, extra = {}) {
  const job = { id: String(++jobSeq), tipo, titulo, estado: 'en cola', progreso: 0, mensaje: '', error: null, inicio: Date.now(), ...extra };
  jobs.set(job.id, job);
  avisar();
  return job;
}
function terminar(job, error) {
  job.fin = Date.now();
  if (error) { job.estado = 'error'; job.error = String(error.message || error); }
  else { job.estado = 'listo'; job.progreso = 100; }
  avisar();
}

// Un render a la vez (GPU/CPU al 100 %): los demás esperan en cola.
let cola = Promise.resolve();
function encolar(fn) { const p = cola.then(fn); cola = p.catch(() => {}); return p; }

// Nombres cortos: con los títulos largos de X la ruta pasaría el límite de 260 caracteres de Windows.
const slug = (t, max) => String(t || '').normalize('NFC').replace(SIN_EMOJI, '')
  .replace(/[^\wáéíóúñüÁÉÍÓÚÑÜ\- ]/g, ' ').trim().replace(/[\s_]+/g, '_').replace(/^_+/, '').slice(0, max).replace(/_+$/, '');
function nombreVertical(video) {
  const info = infoArchivo(video);
  const base = info.plataforma
    ? [info.creador.replace(/^@/, '') || 'clip', slug(info.texto, 40)].filter(Boolean).join('_')
    : slug(path.parse(video).name, 70);
  return (base || 'clip') + '_vertical.mp4';
}

async function procesarClip({ video, hook, creador, fondo }) {
  const entrada = archivoSeguro(DIRS.gtavi.raw, video);
  const enc = await detectarEncoder();
  if (!enc.ffmpeg) throw httpError(500, 'No encontré FFmpeg. Instálalo y agrégalo al PATH (o define FFMPEG_PATH).');
  const salida = reservar(DIRS.gtavi.listos, nombreVertical(video));
  const job = nuevoJob('procesar', video, { video, salida: path.basename(salida), encoder: enc.etiqueta });

  encolar(async () => {
    job.estado = 'procesando'; avisar();
    await renderClip({ entrada, salida, hook, credito: creador, fondo, tag: `j${job.id}`, onProgreso: p => (job.progreso = p) });
    const metaFile = rutaMeta(DIRS.gtavi.listos, path.basename(salida));
    if (!fs.existsSync(metaFile)) {
      const cr = sinEmojis(String(creador || ''));
      await escribirJSON(metaFile, { ...META_VACIA(), ...(cr ? { creador: cr } : {}) }).catch(() => {});
    }
  }).then(() => terminar(job), e => terminar(job, e)).finally(() => liberar(salida));
  return job;
}

// ── Lote con el JSON de Claude
function parsearJSONClaude(texto) {
  const t = String(texto || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let data;
  try { data = JSON.parse(t); } catch {
    const a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a === -1 || b <= a) throw httpError(400, 'No encontré un JSON válido (debe ser una lista [ … ]).');
    try { data = JSON.parse(t.slice(a, b + 1)); } catch (e2) { throw httpError(400, 'El JSON no es válido: ' + e2.message); }
  }
  if (!Array.isArray(data)) data = Object.values(data || {}).find(Array.isArray);
  if (!Array.isArray(data) || !data.length) throw httpError(400, 'El JSON debe ser una lista de clips.');
  return data.map((c, i) => ({
    ranking: Number(c?.ranking) || data.length - i,
    id: Number(c?.id) || null,
    archivo: String(c?.archivo || '').trim(),
    creador: String(c?.creador || '').trim(),
    gancho: String(c?.gancho || '').trim(),
    titulo_post: String(c?.titulo_post || '').trim(),
    descripcion_post: String(c?.descripcion_post || '').trim(),
  }));
}

function creadorValido(c, archivo) {
  const h = /desconocido/i.test(String(c || '')) ? '' : aHandle(c);
  return h || creadorDeArchivo(archivo);
}

// Claude a veces cambia un emoji o recorta un nombre largo: se busca por nombre exacto,
// luego por "id" del último análisis y al final por coincidencia aproximada (solo si es única).
const claveNombre = s => String(s || '').normalize('NFC').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
function idsDelAnalisis() {
  try { return (JSON.parse(fs.readFileSync(ANALISIS_FILE, 'utf8')).clips || []).map(c => c.archivo); } catch { return []; }
}
function resolverArchivo(c, raws, ids) {
  if (raws.includes(c.archivo)) return c.archivo;
  const nfc = c.archivo.normalize('NFC');
  let r = raws.find(x => x.normalize('NFC') === nfc);
  if (r) return r;
  if (c.id && ids[c.id - 1] && raws.includes(ids[c.id - 1])) return ids[c.id - 1];
  const k = claveNombre(c.archivo);
  if (!k) return null;
  const unico = arr => (arr.length === 1 ? arr[0] : null);
  return unico(raws.filter(x => claveNombre(x) === k))
    || (k.length >= 12 ? unico(raws.filter(x => { const kx = claveNombre(x); return kx.startsWith(k) || k.startsWith(kx); })) : null);
}

// Duraciones de Raw (caché por nombre + fecha) para el editor de secciones.
const cacheDur = new Map();
async function duracionCache(file) {
  let st; try { st = await fsp.stat(file); } catch { return null; }
  const k = `${file}|${st.mtimeMs}`;
  if (!cacheDur.has(k)) cacheDur.set(k, await duracion(file));
  return cacheDur.get(k);
}
const cacheDims = new Map();
async function dimsCache(file) {
  let st; try { st = await fsp.stat(file); } catch { return {}; }
  const k = `${file}|${st.mtimeMs}`;
  if (!cacheDims.has(k)) cacheDims.set(k, await dimensiones(file));
  return cacheDims.get(k);
}
/** Nombre visible para usar como crédito (sin emojis; vacío si no tiene letras latinas). */
function nombreVisible(archivo) {
  const v = sinEmojis(infoArchivo(archivo).visible || '').replace(/\s+/g, ' ').trim();
  return /[A-Za-z0-9]/.test(v) ? v : '';
}

async function revisarLote(texto) {
  const clips = parsearJSONClaude(texto);
  const raws = fs.readdirSync(DIRS.gtavi.raw).filter(f => VIDEO_EXT.includes(path.extname(f).toLowerCase()));
  const ids = idsDelAnalisis();
  return Promise.all(clips.map(async c => {
    const archivo = c.archivo || c.id ? resolverArchivo(c, raws, ids) : null;
    const base = archivo || c.archivo;
    return {
      ...c, original: c.archivo, archivo: base, existe: !!archivo,
      creador: creadorValido(c.creador, base), visible: nombreVisible(base),
      duracion: archivo ? await duracionCache(path.join(DIRS.gtavi.raw, archivo)) : null,
      ...(archivo ? await dimsCache(path.join(DIRS.gtavi.raw, archivo)) : {}),
    };
  }));
}

/** "1:05.5" / "65.5" / "" → segundos o null */
function parseTiempo(v) {
  const t = String(v ?? '').trim().replace(',', '.');
  if (!t) return null;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(t)) throw httpError(400, `Tiempo inválido: "${t}". Usa 1:05 o 65.5`);
  return t.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
}

/**
 * Aplica lo que ajustaste en el tablero (por archivo): incluir, puesto, gancho, crédito y sección.
 * Sin ajuste, el crédito es el @creador que dio Claude / el nombre del archivo.
 */
async function prepararLote(texto, ajustes = {}) {
  const todos = await revisarLote(texto);
  const omitidos = todos.filter(c => !c.existe).map(c => c.original || (c.id ? `id ${c.id}` : '(sin nombre)'));
  const validos = [];
  for (const c of todos.filter(c => c.existe)) {
    const a = (ajustes && typeof ajustes === 'object' && ajustes[c.archivo]) || {};
    if (a.incluir === false) continue;
    const nombre = c.gancho || c.archivo;
    let secciones = null;
    if (Array.isArray(a.secciones) && a.secciones.length) {
      const lim = c.duracion || Infinity;
      const lista = a.secciones
        .map(x => ({ a: Math.max(0, Number(x?.a) || 0), b: Math.min(lim, Number(x?.b) || 0) }))
        .filter(x => x.b - x.a >= 0.1).sort((x, y) => x.a - y.a);
      secciones = [];
      for (const x of lista) {                       // une secciones que se enciman
        const u = secciones[secciones.length - 1];
        if (u && x.a <= u.b) u.b = Math.max(u.b, x.b); else secciones.push({ ...x });
      }
      if (!secciones.length) throw httpError(400, `"${nombre}" no tiene ninguna sección para exportar.`);
    } else {
      const inicio = parseTiempo(a.inicio), fin = parseTiempo(a.fin);
      if (inicio !== null && fin !== null && fin <= inicio) throw httpError(400, `En "${nombre}" el fin debe ser mayor que el inicio.`);
      if (c.duracion && inicio !== null && inicio >= c.duracion) throw httpError(400, `En "${nombre}" el inicio pasa del final del clip.`);
      if (inicio !== null || fin !== null) secciones = [{ a: inicio || 0, b: fin !== null ? Math.min(fin, c.duracion || fin) : (c.duracion || null) }];
    }
    // el clip completo no necesita recorte
    if (secciones?.length === 1 && secciones[0].a <= 0.05 && c.duracion && secciones[0].b >= c.duracion - 0.05) secciones = null;
    validos.push({
      ...c,
      ranking: Number(a.ranking) || c.ranking,
      gancho: a.gancho !== undefined ? String(a.gancho) : c.gancho,
      credito: a.credito !== undefined ? String(a.credito).trim() : c.creador,
      secciones,
      capa: typeof a.capa === 'string' && a.capa.startsWith('data:image/png;base64,') ? Buffer.from(a.capa.slice(22), 'base64') : null,
    });
  }
  if (!validos.length) throw httpError(400, 'No hay clips para procesar (revisa que existan en Gaming/Raw y que estén incluidos).');
  return { validos, omitidos };
}

async function procesarLote({ json, modo, orientacion, ajustes, fondo, estilo, titulo: tituloVideo, extra }) {
  const enc = await detectarEncoder();
  if (!enc.ffmpeg) throw httpError(500, 'No encontré FFmpeg. Instálalo y agrégalo al PATH (o define FFMPEG_PATH).');
  const { validos, omitidos } = await prepararLote(json, ajustes);
  const top = modo === 'top';
  const esLista = top && estilo === 'lista';
  if (esLista && !sinEmojis(String(tituloVideo || ''))) throw httpError(400, 'Escribe el título del video (el texto fijo de arriba).');
  const orient = top && !esLista && orientacion === 'horizontal' ? 'horizontal' : 'vertical';   // la lista solo existe en vertical
  // Top: de #N (menor impacto) a #1 (mayor impacto). Individual: en el orden del JSON.
  const lista = top ? [...validos].sort((a, b) => b.ranking - a.ranking) : validos;
  // En el Top las insignias van seguidas aunque quites clips: #N … #1
  if (top) lista.forEach((c, i) => { c.ranking = lista.length - i; });
  // la capa (PNG) no se manda en /api/estado: se guarda como propiedad oculta
  const items = lista.map(({ capa, ...c }) => Object.defineProperty({ ...c, estado: 'en cola', progreso: 0 }, 'capa', { value: capa, enumerable: false }));
  const n = items.length;
  const job = nuevoJob(top ? 'top' : 'lote',
    top ? `${esLista ? 'Lista' : 'Top'} ${n} · ${orient === 'vertical' ? '1080×1920' : '1920×1080'} · 60 fps` : `Lote de ${n} short${n === 1 ? '' : 's'}`,
    { items, omitidos, encoder: enc.etiqueta });

  const avance = (i, p) => { items[i].progreso = p; job.progreso = Math.round(((i + p / 100) / n) * (top ? 85 : 100)); };

  encolar(async () => {
    job.estado = 'procesando'; avisar();

    if (!top) {
      let ok = 0;
      for (const [i, it] of items.entries()) {
        it.estado = 'procesando'; job.mensaje = `${i + 1}/${n} · ${it.archivo}`; avisar();
        const salida = reservar(DIRS.gtavi.listos, nombreVertical(it.archivo));
        try {
          await renderClip({ entrada: path.join(DIRS.gtavi.raw, it.archivo), salida, hook: it.gancho, credito: it.credito, fondo, capa: it.capa,
            secciones: it.secciones, tag: `j${job.id}_${i}`, onProgreso: p => avance(i, p) });
          const titulo = it.titulo_post, descripcion = it.descripcion_post;
          await escribirJSON(rutaMeta(DIRS.gtavi.listos, path.basename(salida)), {
            completo: [titulo, descripcion].filter(Boolean).join('\n\n'), titulo, descripcion, creador: it.credito || it.creador,
          });
          it.estado = 'listo'; it.salida = path.basename(salida); ok++;
        } catch (e) { it.estado = 'error'; it.error = e.message; }
        finally { liberar(salida); avance(i, 100); avisar(); }
      }
      if (!ok) throw new Error('No se pudo procesar ningún clip.');
      job.mensaje = `${ok}/${n} shorts en Gaming/Listos`;
      return;
    }

    // ── Modo Top: render normalizado por clip → unión sin recodificar
    const salida = reservar(DIRS.gtavi.listos, `Top_GTAVI_${sello()}.mp4`);
    job.salida = path.basename(salida);
    const segmentos = [];
    try {
      for (const [i, it] of items.entries()) {
        it.estado = 'procesando'; job.mensaje = `${esLista ? `${i + 1}.` : `#${it.ranking}`} · ${it.archivo}`; avisar();
        const seg = `top${job.id}_${String(i).padStart(2, '0')}.mp4`;
        try {
          await renderClip({ entrada: path.join(DIRS.gtavi.raw, it.archivo), salida: path.join(TMP, seg), hook: it.gancho, fondo, capa: it.capa,
            credito: it.credito, secciones: it.secciones, orient, normalizar: true, intermedio: true,
            ...(esLista
              // renglón extra que nunca se revela: la gente se queda esperando el último
              ? { hook: '', lista: { titulo: tituloVideo, textos: items.map(x => x.gancho), actual: i, total: n + (extra === false ? 0 : 1) } }
              : { badge: `#${it.ranking}` }),
            tag: `j${job.id}_${i}`, onProgreso: p => avance(i, p) });
          segmentos.push(seg); it.estado = 'listo';
        } catch (e) { it.estado = 'error'; it.error = e.message; }
        avance(i, 100); avisar();
      }
      if (!segmentos.length) throw new Error('No se pudo procesar ningún clip.');
      job.mensaje = `Uniendo ${segmentos.length} clips…`; avisar();
      // los clips ocupan el 0–85 % de la barra y la unión el 85–100 %
      await unirSegmentos(segmentos, salida, p => { job.progreso = 85 + Math.round(p * 0.15); });

      const usados = items.filter(it => it.estado === 'listo');
      const titulo = esLista ? String(tituloVideo).trim() : `🔥 Top ${usados.length} momentos de GTA VI que no vas a creer 🎮`;
      const descripcion = usados.map((it, i) => [esLista ? `${i + 1}.` : `#${it.ranking}`, sinEmojis(it.gancho || ''), it.credito ? `(${it.credito})` : ''].filter(Boolean).join(' ')).join('\n')
        + '\n\n#GTA6 #GTAVI #GTA #Gaming #Top';
      await escribirJSON(rutaMeta(DIRS.gtavi.listos, path.basename(salida)), {
        completo: `${titulo}\n\n${descripcion}`, titulo, descripcion,
        creador: [...new Set(usados.map(u => u.credito).filter(Boolean))].join(' '),
      });
      job.mensaje = `${usados.length}/${n} clips → ${path.basename(salida)}`;
    } finally {
      for (const s of segmentos) fsp.unlink(path.join(TMP, s)).catch(() => {});
      liberar(salida);
    }
  }).then(() => terminar(job), e => terminar(job, e));
  return job;
}

module.exports = { jobs, nuevoJob, terminar, encolar, slug, nombreVertical, procesarClip, parsearJSONClaude, creadorValido, claveNombre, idsDelAnalisis, resolverArchivo, cacheDur, duracionCache, cacheDims, dimsCache, nombreVisible, revisarLote, parseTiempo, prepararLote, procesarLote };
