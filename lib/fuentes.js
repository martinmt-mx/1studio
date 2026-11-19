/**
 * 1Studio · Buscador en fuentes (VODs y videos largos)
 *
 * Biblioteca global en Gaming/fuentes/<id>/ (fuente.json + transcripcion.json).
 *  · YouTube con subtítulos → se bajan los subtítulos (segundos, sin descargar el video)
 *  · Twitch / Kick / sin subtítulos → se baja solo el audio y se transcribe con Whisper por pedazos
 * Luego se busca "lo que dice el streamer" y cada resultado trae su minuto, para descargar solo ese tramo.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, FFMPEG, FFPROBE, resolveDir, CARPETAS } = require('./config');
const { httpError, ruta, escribirJSON, ultimasLineas, sello, ejecutar, aLaPapelera } = require('./util');
const { herramientas, rutaYtdlp } = require('./herramientas');
const { avisar } = require('./eventos');

module.exports = function montarFuentes(ctx) {
  const { app } = ctx;
  const DIR = resolveDir(CARPETAS.gtavi, 'fuentes');
  const SCRIPT = path.join(ROOT, 'python', 'transcribir_fuente.py');

  // Estado en memoria (fuente de verdad) + escritura en disco en serie por fuente
  const FU = new Map();
  const escrituras = new Map();
  const dirDe = id => {
    if (!/^[\w-]{3,80}$/.test(String(id)) || !FU.has(id)) throw httpError(404, 'No existe esa fuente');
    return path.join(DIR, id);
  };
  const leer = id => { dirDe(id); return FU.get(id); };
  const guardar = f => {
    FU.set(f.id, f);
    const copia = JSON.stringify(f, null, 2), file = path.join(DIR, f.id, 'fuente.json');
    const prom = (escrituras.get(f.id) || Promise.resolve()).then(() => fsp.writeFile(file, copia, 'utf8')).catch(() => {});
    escrituras.set(f.id, prom);
    return prom;
  };
  const enProceso = new Set();

  // Al arrancar: cargar la biblioteca; lo que quedó a medias se marca para reintentar
  for (const d of fs.readdirSync(DIR)) {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(DIR, d, 'fuente.json'), 'utf8'));
      if (f.estado === 'procesando' || f.estado === 'en cola') {
        Object.assign(f, { estado: 'error', error: 'Se interrumpió al cerrar el tablero. Dale “Reintentar”.', mensaje: '' });
        fs.writeFileSync(path.join(DIR, d, 'fuente.json'), JSON.stringify(f, null, 2));
      }
      FU.set(f.id, f);
    } catch { /* carpeta suelta */ }
  }

  // ───────── subtítulos ─────────
  function elegirSubs(info) {
    const man = info.subtitles || {}, aut = info.automatic_captions || {};
    const pref = [info.language, 'es', 'en'].filter(Boolean);
    for (const l of pref) {
      const k = Object.keys(man).find(x => x !== 'live_chat' && (x === l || x.startsWith(l + '-')));
      if (k) return { lang: k, auto: false };
    }
    const orig = Object.keys(aut).find(x => x.endsWith('-orig'));
    if (orig) return { lang: orig, auto: true };
    for (const l of pref) if (aut[l]) return { lang: l, auto: true };
    return null;
  }
  function parseJson3(txt) {
    const out = [];
    for (const ev of JSON.parse(txt).events || []) {
      if (!ev.segs) continue;
      const t = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const s = (ev.tStartMs || 0) / 1000;
      out.push({ s, e: s + (ev.dDurationMs || 2000) / 1000, t });
    }
    return out;
  }
  function parseVtt(txt) {
    const out = [];
    const seg = (h, m, s, ms) => (Number(h || 0) * 3600) + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    for (const b of txt.replace(/\r/g, '').split(/\n\n+/)) {
      const m = b.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
      if (!m) continue;
      const lineas = b.split('\n');
      const t = lineas.slice(lineas.findIndex(l => l.includes('-->')) + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (t && (!out.length || out[out.length - 1].t !== t)) out.push({ s: seg(m[1], m[2], m[3], m[4]), e: seg(m[5], m[6], m[7], m[8]), t });
    }
    return out;
  }

  // ───────── procesar una fuente ─────────
  let cola = Promise.resolve();
  function encolarFuente(f) {
    Object.assign(f, { estado: 'en cola', progreso: 0, mensaje: 'En cola…', error: null });
    guardar(f);
    cola = cola.then(() => procesar(f.id).catch(() => {}));
  }
  const actualizar = async (id, cambios) => {
    const f = FU.get(id); if (!f) throw new Error('La fuente se borró');
    Object.assign(f, cambios); guardar(f); avisar(); return f;
  };

  async function procesar(id) {
    enProceso.add(id);
    const d = path.join(DIR, id);
    try {
      let f = await actualizar(id, { estado: 'procesando', progreso: 2, mensaje: 'Leyendo datos del video…' });
      const h = await herramientas(true);
      if (!h.ytdlp.ok) throw new Error('yt-dlp no está disponible. Abre de nuevo INICIAR.bat.');
      const yt = rutaYtdlp();
      const m = await ejecutar(yt, ['--no-playlist', '--dump-single-json', '--skip-download', '--no-warnings', '--encoding', 'utf-8', f.url]);
      let info;
      try { info = JSON.parse(m.stdout); } catch { throw new Error(ultimasLineas(m.stderr, 3) || 'yt-dlp no pudo leer la URL'); }
      f = await actualizar(id, {
        titulo: info.title || f.url, canal: info.channel || info.uploader || info.uploader_id || '',
        duracion: Number(info.duration) || null, plataforma: info.extractor_key || '', mensaje: 'Buscando subtítulos…', progreso: 5,
      });

      // 1) subtítulos (YouTube): rápido y sin descargar video
      const sub = elegirSubs(info);
      if (sub) {
        const r = await ejecutar(yt, ['--no-playlist', '--skip-download', sub.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', sub.lang,
          '--sub-format', 'json3/vtt/best', '--no-warnings', '-o', path.join(d, 'subs.%(ext)s'), f.url]);
        const archivo = (await fsp.readdir(d)).find(x => x.startsWith('subs.') && /\.(json3|vtt)$/.test(x));
        if (archivo) {
          const txt = await fsp.readFile(path.join(d, archivo), 'utf8');
          const segmentos = archivo.endsWith('.json3') ? parseJson3(txt) : parseVtt(txt);
          await fsp.unlink(path.join(d, archivo)).catch(() => {});
          if (segmentos.length >= 5) {
            await escribirJSON(path.join(d, 'transcripcion.json'), { origen: 'subtitulos', idioma: sub.lang, segmentos });
            return actualizar(id, { estado: 'listo', progreso: 100, mensaje: '', origen: 'subtítulos de YouTube', idioma: sub.lang, segmentos: segmentos.length });
          }
        } else if (r.code !== 0) {
          await actualizar(id, { mensaje: 'Sin subtítulos útiles; transcribo el audio…' });
        }
      }

      // 2) solo el audio + Whisper
      if (!h.python.ok || !h.python.whisper) throw new Error('Este video no tiene subtítulos y faster-whisper no está instalado (INICIAR.bat lo instala).');
      await actualizar(id, { mensaje: 'Descargando solo el audio…', progreso: 6 });
      await new Promise((resolve, reject) => {
        const p = spawn(yt, ['--no-playlist', '-f', 'ba/bestaudio/worst', '--newline', '--no-colors', '--no-warnings', '--encoding', 'utf-8',
          '--progress-template', 'download:[dl]%(progress._percent_str)s', '-o', path.join(d, 'audio.%(ext)s'), f.url],
        { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        let err = '', buf = '', ultimo = 0;
        p.stdout.on('data', x => {
          buf += x; const ls = buf.split(/\r?\n|\r/); buf = ls.pop();
          for (const l of ls) {
            const n = parseFloat(l.replace(/\x1b\[[0-9;]*m/g, '').replace('[dl]', ''));
            if (l.includes('[dl]') && !isNaN(n) && Date.now() - ultimo > 1500) { ultimo = Date.now(); actualizar(id, { progreso: Math.round(6 + n * 0.24), mensaje: `Descargando audio ${n.toFixed(0)}%` }).catch(() => {}); }
          }
        });
        p.stderr.on('data', x => { err = (err + x).slice(-4000); });
        p.on('error', reject);
        p.on('close', c => (c === 0 ? resolve() : reject(new Error(ultimasLineas(err, 3) || 'No se pudo descargar el audio'))));
      });
      const audio = (await fsp.readdir(d)).find(x => x.startsWith('audio.') && !x.endsWith('.part'));
      if (!audio) throw new Error('yt-dlp terminó pero no encontré el audio.');
      await actualizar(id, { mensaje: 'Transcribiendo con Whisper…', progreso: 30 });
      await new Promise((resolve, reject) => {
        const p = spawn(h.python.cmd, [...h.python.pre, SCRIPT, '--audio', path.join(d, audio), '--out', path.join(d, 'transcripcion.json'),
          '--ffmpeg', FFMPEG, '--ffprobe', FFPROBE], { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
        let err = '', buf = '';
        p.stdout.on('data', x => {
          buf += x; const ls = buf.split(/\r?\n/); buf = ls.pop();
          for (const l of ls) {
            let ev; try { ev = JSON.parse(l); } catch { continue; }
            if (ev.tipo === 'progreso') actualizar(id, { progreso: Math.round(30 + (ev.t / ev.total) * 69), mensaje: `Transcribiendo… ${Math.round((ev.t / ev.total) * 100)}%` }).catch(() => {});
            if (ev.tipo === 'modelo') actualizar(id, { mensaje: `Whisper "${ev.modelo}" en ${String(ev.dispositivo).toUpperCase()}…` }).catch(() => {});
          }
        });
        p.stderr.on('data', x => { err = (err + x).slice(-6000); });
        p.on('error', reject);
        p.on('close', c => (c === 0 ? resolve() : reject(new Error(ultimasLineas(err, 4) || `transcribir_fuente.py terminó con código ${c}`))));
      });
      await fsp.unlink(path.join(d, audio)).catch(() => {});   // el audio ya no hace falta
      const tr = JSON.parse(await fsp.readFile(path.join(d, 'transcripcion.json'), 'utf8'));
      return actualizar(id, { estado: 'listo', progreso: 100, mensaje: '', origen: `Whisper (${tr.dispositivo === 'cuda' ? 'GPU' : 'CPU'})`, idioma: tr.idioma, segmentos: tr.segmentos.length });
    } catch (e) {
      await actualizar(id, { estado: 'error', error: e.message, mensaje: '' }).catch(() => {});
      throw e;
    } finally {
      enProceso.delete(id);
    }
  }

  // ───────── búsqueda ─────────
  const STOP = new Set(('the a an and or to of in on at is it its this that i im you your he she we they my me so like just what was are be '
    + 'with for from look looks bro dude oh yo yeah no not do did does can cant how why when all out up get got go '
    + 'de la el los las un una unos unas y o que en es por para con se lo le les me mi tu su sus al del si ya ahi esta este eso esto como mas muy pero hay').split(' '));
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim();
  const tokens = s => norm(s).split(' ').filter(w => w.length > 1 && !STOP.has(w));
  const indices = new Map();
  function indice(id) {
    const file = path.join(DIR, id, 'transcripcion.json');
    const mt = fs.statSync(file).mtimeMs;
    const c = indices.get(id);
    if (c && c.mt === mt) return c.segs;
    const segs = JSON.parse(fs.readFileSync(file, 'utf8')).segmentos.map(s => ({ ...s, n: norm(s.t), tk: new Set(tokens(s.t)) }));
    indices.set(id, { mt, segs });
    return segs;
  }
  const parecida = (w, ventana) => ventana.has(w) || (w.length >= 4 && [...ventana].some(x => x.length >= 4 && (x.startsWith(w) || w.startsWith(x))));

  function buscar(consultas, ids) {
    const fuentes = listar().filter(f => f.estado === 'listo' && (!ids?.length || ids.includes(f.id)));
    const hits = [];
    for (const f of fuentes) {
      let segs; try { segs = indice(f.id); } catch { continue; }
      const deFuente = [];
      for (const q of consultas) {
        const qt = [...new Set(tokens(q))], frase = norm(q);
        if (!qt.length) continue;
        const necesita = qt.length <= 2 ? qt.length : Math.ceil(qt.length * 0.6);
        for (let i = 0; i < segs.length; i++) {
          const ventana = new Set([...segs[i].tk, ...(segs[i + 1]?.tk || [])]);
          const n = qt.filter(w => parecida(w, ventana)).length;
          if (n < necesita) continue;
          const exacta = frase.length > 3 && `${segs[i].n} ${segs[i + 1]?.n || ''}`.includes(frase);
          // el momento es la frase que más coincide (no siempre la primera de la ventana)
          const solo = k => (segs[k] ? qt.filter(w => parecida(w, segs[k].tk)).length : -1);
          const ancla = solo(i + 1) > solo(i) ? i + 1 : i;
          deFuente.push({ i: ancla, score: n / qt.length + (exacta ? 0.5 : 0), consulta: q });
        }
      }
      // un resultado por momento (sin repetir lo que está a menos de 15 s)
      deFuente.sort((a, b) => b.score - a.score);
      const elegidos = [];
      for (const hh of deFuente) {
        const t = segs[hh.i].s;
        if (elegidos.some(x => Math.abs(x.t - t) < 15)) continue;
        elegidos.push({ ...hh, t });
        if (elegidos.length >= 25) break;
      }
      for (const hh of elegidos) {
        const ctxTexto = [segs[hh.i - 1], segs[hh.i], segs[hh.i + 1]].filter(Boolean).map(x => x.t).join(' ').slice(0, 260);
        hits.push({ fuente: f.id, titulo: f.titulo, canal: f.canal, url: f.url, plataforma: f.plataforma, t: hh.t, score: +hh.score.toFixed(2), consulta: hh.consulta, texto: ctxTexto });
      }
    }
    return hits.sort((a, b) => b.score - a.score || a.t - b.t).slice(0, 40);
  }

  function listar() {
    return [...FU.values()].sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
  }

  // ───────── API ─────────
  app.get('/api/fuentes', ruta(async (_req, res) => res.json(listar())));
  app.post('/api/fuentes', ruta(async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) throw httpError(400, 'Pega una URL válida (https://…)');
    const ya = listar().find(f => f.url === url);
    if (ya) throw httpError(409, `Esa fuente ya está en la biblioteca: ${ya.titulo || ya.url}`);
    const f = { id: `fuente-${sello()}-${Math.random().toString(36).slice(2, 6)}`, url, creado: new Date().toISOString(), titulo: url };
    await fsp.mkdir(path.join(DIR, f.id), { recursive: true });
    FU.set(f.id, f);
    encolarFuente(f);
    res.json(f);
  }));
  app.post('/api/fuentes/:id/reintentar', ruta(async (req, res) => {
    const f = leer(req.params.id);
    if (enProceso.has(f.id) || f.estado === 'en cola') throw httpError(409, 'Esa fuente ya se está procesando.');
    encolarFuente(f);
    res.json({ ok: true });
  }));
  app.delete('/api/fuentes/:id', ruta(async (req, res) => {
    const d = dirDe(req.params.id);
    if (enProceso.has(req.params.id)) throw httpError(409, 'Espera a que termine de procesarse.');
    indices.delete(req.params.id);
    await escrituras.get(req.params.id);
    const destino = await aLaPapelera(d);
    FU.delete(req.params.id); escrituras.delete(req.params.id);
    res.json({ ok: true, destino });
  }));
  app.post('/api/fuentes/buscar', ruta(async (req, res) => {
    const consultas = (Array.isArray(req.body?.consultas) ? req.body.consultas : [req.body?.consultas]).map(String).filter(x => x.trim()).slice(0, 12);
    if (!consultas.length) throw httpError(400, 'Escribe qué buscar.');
    res.json({ hits: buscar(consultas, req.body?.fuentes) });
  }));

  return { buscar, parseJson3, parseVtt, elegirSubs };
};
