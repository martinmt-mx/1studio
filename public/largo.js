/* 1Studio · Pestaña "Largo": video largo + shorts armados en torno a la voz.
 * Depende de app.js (S, $, esc, enc, api, toast, render, copiar, btnBase…) y editor.js (textoCanvas, fmtT, parseT,
 * envolverCli, disenoVerticalCli). */
const LG = {
  lista: [], p: null, id: localStorage.getItem('proyectoLargo') || null,
  picker: null,          // { secId, toma, archivo, a, b, filtro }
  subiendo: null,        // % de subida de la voz
  modelo: localStorage.getItem('modeloVoz') || 'auto',
  json: '', audio: null, guardarTimer: null,
  fuentes: [], fuenteUrl: '', busq: { q: '', hits: null, cargando: false, sel: null, ventana: 30 }, traer: null,
};
// mismas medidas que proyectos.js (LAYOUT)
const LAY = {
  h: { W: 1920, H: 1080, clip: [{ x: 0, y: 0, w: 1920, h: 1080 }], comparacion: [{ x: 16, y: 275, w: 944, h: 531 }, { x: 960, y: 275, w: 944, h: 531 }] },
  v: { W: 1080, H: 1920, clip: [{ x: 0, y: 656, w: 1080, h: 608 }], comparacion: [{ x: 0, y: 300, w: 1080, h: 608 }, { x: 0, y: 1010, w: 1080, h: 608 }] },
};

// ───────────── pronunciación para la voz (solo el texto que copias para AI Studio) ─────────────
// El guion, los subtítulos y los títulos siguen diciendo "GTA V"; la voz recibe "Ge Te A cinco".
// Guiones = se lee de corrido como una sola palabra; acento = dónde cae el énfasis ("ge-te-Á")
const PRONUNCIACION_BASE = `GTA VI = Ge-Te-Á seis
GTA V = Ge-Te-Á cinco
GTA 6 = Ge-Te-Á seis
GTA 5 = Ge-Te-Á cinco
GTA IV = Ge-Te-Á cuatro
GTA = Ge-Te-Á
RAGE = reich
NPCs = ene-pe-cés
NPC = ene-pe-cé
SWAT = suat
PS5 = pe ese cinco
FPS = efe pe ese`;
LG.pron = localStorage.getItem('pronunciacion') ?? PRONUNCIACION_BASE;
// reglas guardadas con la versión anterior ("Ge Te A" separado): se actualizan sin tocar las que agregaste
if (/= Ge Te A\b|= ene pe c/.test(LG.pron)) {
  LG.pron = LG.pron.replace(/= Ge Te A\b/g, '= Ge-Te-Á').replace(/= ene pe cés/g, '= ene-pe-cés').replace(/= ene pe cé\b/g, '= ene-pe-cé');
  if (!/^RAGE\s*=/m.test(LG.pron)) LG.pron += '\nRAGE = reich';
  localStorage.setItem('pronunciacion', LG.pron);
}

const UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce',
  'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco',
  'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
/** 0–999 999 en palabras (español). */
function enPalabras(n) {
  if (n < 30) return UNIDADES[n];
  if (n < 100) return DECENAS[Math.floor(n / 10)] + (n % 10 ? ' y ' + UNIDADES[n % 10] : '');
  if (n === 100) return 'cien';
  if (n < 1000) return CENTENAS[Math.floor(n / 100)] + (n % 100 ? ' ' + enPalabras(n % 100) : '');
  const miles = Math.floor(n / 1000), resto = n % 1000;
  return (miles === 1 ? 'mil' : enPalabras(miles).replace(/uno$/, 'un') + ' mil') + (resto ? ' ' + enPalabras(resto) : '');
}
function textoParaVoz(texto) {
  const reglas = LG.pron.split('\n').map(l => l.split('=')).filter(x => x.length === 2 && x[0].trim() && x[1].trim())
    .map(([a, b]) => [a.trim(), b.trim()]).sort((x, y) => y[0].length - x[0].length);   // las más largas primero
  let t = texto;
  for (const [a, b] of reglas) {
    const esc2 = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc2}(?![\\p{L}\\p{N}])`, 'gu'), b);
  }
  // números con dígitos → en palabras (así nunca los lee en inglés)
  t = t.replace(/\b\d{1,3}(?:,\d{3})+\b/g, n => n.replace(/,/g, ''))                       // 1,200 → 1200
       .replace(/\b(\d+)\.(\d+)\b/g, (_, e, d) => `${enPalabras(+e)} punto ${d.split('').map(x => UNIDADES[+x]).join(' ')}`)  // 1.5
       .replace(/(\d+)\s*%/g, (_, n) => `${enPalabras(+n)} por ciento`)
       .replace(/\b\d{1,6}\b/g, n => (+n <= 999999 ? enPalabras(+n) : n));
  return t;
}
const palabrasGuion = p => p.secciones.reduce((a, s) => a + s.narracion.split(/\s+/).filter(Boolean).length, 0);
const ppm = () => Number(localStorage.getItem('ppmVoz')) || 190;   // palabras por minuto de tu voz (se calibra sola)

const secT = s => LG.p?.alineacion?.secciones?.find(x => x.id === s.id);
const durSec = s => { const t = secT(s); return t ? t.t1 - t.t0 : null; };
const durClipLg = c => Math.max(0, (Number(c.b) || 0) - (Number(c.a) || 0));
const nombreCorto = n => { const i = (S.estado?.canales?.gtavi?.raw || []).find(r => r.name === n)?.info; return i?.texto ? `${i.creador || ''} ${i.texto}`.trim() : n; };

async function cargarProyectos() {
  try { LG.lista = await api('/api/proyectos'); } catch (e) { toast(e.message, 'error'); }
}
async function abrirProyecto(id) {
  try {
    LG.p = await api(`/api/proyectos/${enc(id)}`); LG.id = id; localStorage.setItem('proyectoLargo', id);
    const al = LG.p.alineacion;
    if (al && !al.aproximado && al.duracion > 30) localStorage.setItem('ppmVoz', String(Math.round(palabrasGuion(LG.p) / (al.duracion / 60))));
  } catch { LG.p = null; LG.id = null; localStorage.removeItem('proyectoLargo'); }
  render(true);
}
function guardarSecciones() {
  clearTimeout(LG.guardarTimer);
  LG.guardarTimer = setTimeout(async () => {
    if (!LG.p) return;
    const secciones = LG.p.secciones.map(s => ({ id: s.id, titulo: s.titulo, plantilla: s.plantilla, short: s.short, shortInfo: s.shortInfo,
      tomas: s.tomas.map(t => ({ etiqueta: t.etiqueta, clips: t.clips })) }));
    try { await api(`/api/proyectos/${enc(LG.p.id)}/secciones`, { method: 'PUT', body: JSON.stringify({ secciones }) }); }
    catch (e) { toast('No se guardó: ' + e.message, 'error'); }
  }, 400);
}

// ───────────── vistas ─────────────
function vistaLargo() {
  return `<div id="largo">${LG.p ? vistaProyecto() : vistaListaProyectos()}</div>`;
}

function vistaListaProyectos() {
  return `
  <section class="rounded-2xl border border-fuchsia-500/30 bg-gradient-to-br from-fuchsia-500/10 to-zinc-900 p-4">
    <h2 class="font-bold">🎬 Nuevo video largo</h2>
    <p class="mt-1 text-xs text-zinc-400">Pega el JSON del guion que te dio Gemini. Luego subes una sola voz con todo el guion y el tablero arma el video en torno a ella: cada sección dura lo que dura su parte de la voz.</p>
    <textarea data-lg="json" rows="7" spellcheck="false" placeholder='{ "titulo": "…", "secciones": [ { "id": 1, "titulo": "…", "narracion": "…", "plantilla": "comparacion", "tomas": [ … ] } ], "shorts": [ … ] }'
      class="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3 font-mono text-[13px] outline-none focus:border-zinc-400">${esc(LG.json)}</textarea>
    <button data-lga="crear" class="mt-2 rounded-lg bg-fuchsia-600 px-5 py-3 font-bold active:scale-[.98]">Crear proyecto</button>
  </section>
  ${seccion('Proyectos', LG.lista.length, LG.lista.length ? `<div class="grid gap-2 md:grid-cols-2">${LG.lista.map(p => `
    <button data-lga="abrir" data-id="${esc(p.id)}" class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-left transition hover:border-zinc-600 active:scale-[.99]">
      <p class="font-semibold">${esc(p.titulo)}</p>
      <p class="mt-1 text-xs text-zinc-500">${p.secciones} secciones · ${p.voz ? (p.alineado ? '🎙 voz alineada' : '🎙 voz sin alinear') : 'sin voz'} · ${fecha(p.creado)}</p>
    </button>`).join('')}</div>` : vacio('Aún no hay proyectos.'))}`;
}

function vistaProyecto() {
  const p = LG.p, al = p.alineacion;
  const jobs = (S.estado?.jobs || []).filter(j => j.proyecto === p.id);
  const alineando = jobs.find(j => j.tipo === 'alinear' && (j.estado === 'procesando' || j.estado === 'en cola'));
  const nShorts = p.secciones.filter(s => s.short).length;
  const listo = !!al && !alineando;
  return `
  <div class="flex flex-wrap items-center gap-2">
    <button data-lga="volver" class="${btnBase} px-3 py-2 text-sm">← Proyectos</button>
    <div class="min-w-0 flex-1"><h2 class="truncate text-lg font-bold">${esc(p.titulo)}</h2>
      <p class="text-[11px] ${p.secciones.length < 3 ? 'text-amber-300' : 'text-zinc-500'}">${p.secciones.length} secciones${p.secciones.length < 3 ? ' (¿seguro que pegaste el guion completo?)' : ''} · ${palabrasGuion(p).toLocaleString('es-MX')} palabras ≈ ${fmtT(palabrasGuion(p) / ppm() * 60).replace(/\.\d$/, '')} de voz${al ? ` · ${fmtT(al.duracion)} de voz` : ''}${p.miniatura ? ` · miniatura: “${esc(p.miniatura)}”` : ''}</p></div>
    <button data-lga="borrar" title="Borrar proyecto" class="${btnBase} px-3 py-2.5 text-sm text-zinc-400 hover:text-red-300">🗑</button>
    <button data-lga="miniatura" title="Armar la miniatura de YouTube" class="${btnBase} px-4 py-2.5 text-sm font-bold">🖼 Miniatura</button>
    <button data-lga="ver" ${listo ? '' : 'disabled'} title="Ver el video completo sin exportar" class="${btnBase} px-4 py-2.5 text-sm font-bold disabled:opacity-40">👁 Vista previa</button>
    <button data-lga="exportar" data-tipo="largo" ${listo ? '' : 'disabled'} class="rounded-lg bg-fuchsia-600 px-4 py-2.5 text-sm font-bold active:scale-[.98] disabled:opacity-40">⬆ Video largo 16:9</button>
    <button data-lga="exportar" data-tipo="shorts" ${listo && nShorts ? '' : 'disabled'} class="rounded-lg border border-fuchsia-500/50 px-4 py-2.5 text-sm font-bold text-fuchsia-200 active:scale-[.98] disabled:opacity-40">⬆ ${nShorts} shorts</button>
  </div>
  <div id="lg-jobs">${jobs.filter(j => j.tipo !== 'alinear').map(filaJob).join('')}</div>

  <section class="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
    <h3 class="font-bold">1 · Voz</h3>
    <p class="mt-1 text-xs text-zinc-400">Genera <b>un solo audio</b> en AI Studio con todo el texto (en orden) y súbelo. El tablero detecta dónde empieza cada sección.</p>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <button data-lga="copiar-voz" class="rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-zinc-950 active:scale-[.98]"><span class="lbl">📋 Copiar texto para la voz</span></button>
      <label class="cursor-pointer rounded-lg border border-zinc-600 px-4 py-2.5 text-sm font-semibold active:scale-[.98]">🎙 ${p.voz ? 'Cambiar voz' : 'Subir voz'}
        <input type="file" data-lg="voz" accept="audio/*,.wav,.mp3,.m4a" class="hidden" /></label>
      <select data-lg="modelo" class="rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-sm">
        ${[['auto', 'Whisper: auto'], ['base', 'base · rápido'], ['small', 'small · preciso'], ['medium', 'medium · más preciso']].map(([v, l]) => `<option value="${v}" ${LG.modelo === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      ${p.voz && !alineando ? `<button data-lga="alinear" class="${btnBase} px-3 py-2.5 text-xs">↻ Volver a alinear</button>` : ''}
    </div>
    ${avisoDuracion(p)}
    <details class="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/50" ${LG.verPron ? 'open' : ''} data-lg-pron>
      <summary class="cursor-pointer select-none px-3 py-2.5 text-sm font-semibold text-zinc-300">🗣 Pronunciación (cómo se escribe para la voz)</summary>
      <div class="px-3 pb-3">
        <p class="text-[11px] text-zinc-500">Una regla por línea: <code>como está en el guion = como debe sonar</code>. Solo cambia el texto que copias para AI Studio; los subtítulos y títulos siguen diciendo "GTA V". Los números con dígitos se escriben en palabras solos.</p>
        <textarea data-lg="pron" rows="7" spellcheck="false" class="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 font-mono text-[13px] outline-none focus:border-zinc-500">${esc(LG.pron)}</textarea>
        <button data-lga="pron-base" class="mt-1 text-[11px] text-zinc-500 hover:text-zinc-300">Restaurar reglas de ejemplo</button>
        <p class="mt-2 text-[11px] text-zinc-500">Ejemplo: <span class="text-zinc-300">${esc(ejemploPron(p))}</span></p>
      </div>
    </details>
    <div id="lg-voz">${estadoVoz(p, alineando)}</div>
    ${p.voz ? `<audio id="lg-audio" src="/api/proyectos/${enc(p.id)}/voz" controls preload="metadata" class="mt-3 w-full"></audio>` : ''}
  </section>

  <section class="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
    <h3 class="font-bold">🔎 Fuentes para buscar clips</h3>
    <p class="mt-1 text-xs text-zinc-400">Pega links de VODs o videos largos (Twitch, Kick, YouTube). El tablero los transcribe una vez y luego, en cada toma, busca los momentos donde el streamer dice esas frases. Sirven para todos tus proyectos.</p>
    <div class="mt-3 flex gap-2">
      <input data-lg="fuente-url" value="${esc(LG.fuenteUrl)}" placeholder="https://www.twitch.tv/videos/… o https://youtu.be/…" class="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 text-[16px] md:text-sm outline-none focus:border-zinc-500" />
      <button data-lga="fuente-agregar" class="rounded-lg bg-sky-600 px-4 text-sm font-bold active:scale-[.98]">Agregar</button>
    </div>
    <div id="lg-fuentes">${listaFuentes()}</div>
  </section>

  <section class="mt-4">
    <div class="mb-2 flex items-baseline justify-between"><h3 class="font-bold">2 · Secciones y material</h3>
      <span class="text-[11px] text-zinc-500">Si el material de una toma dura menos que la voz, se congela el último cuadro.</span></div>
    <div class="space-y-3">${p.secciones.map((s, i) => tarjetaSeccion(s, i)).join('')}</div>
  </section>
  ${tarjetaAudio(p)}
  ${LG.picker ? vistaPicker() : ''}`;
}

function ejemploPron(p) {
  const txt = p.secciones.map(s => s.narracion).join(' ');
  const m = txt.match(/[^.!?]*\b(GTA|NPC|\d)[^.!?]*[.!?]/);
  return m ? textoParaVoz(m[0].trim()).slice(0, 160) : textoParaVoz('GTA V y GTA VI salieron con 13 años de diferencia.');
}
function avisoDuracion(p) {
  const pal = palabrasGuion(p), seg = (pal / ppm()) * 60;
  if (seg >= 8 * 60) return '';
  const meta = 10 * ppm();                                          // palabras para ~10 minutos
  const porSeccion = Math.round((meta - 120) / Math.max(1, p.secciones.length - 2) / 10) * 10;  // sin contar intro y cierre
  return `<p class="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
    ⏱ Con ${pal.toLocaleString('es-MX')} palabras la voz durará unos <b>${fmtT(seg).replace(/\.\d$/, '')}</b> (tu voz habla ~${ppm()} palabras por minuto).
    Para unos 10 minutos hacen falta ~${meta.toLocaleString('es-MX')} palabras. Puedes pedirle a Gemini en el mismo chat:
    <i>"Alarga cada sección de comparación a unas ${porSeccion} palabras con datos concretos y ejemplos de lo que se ve en pantalla, sin relleno. Mismo formato JSON."</i>
    También ayuda escribir en las instrucciones de estilo de AI Studio: <i>"ritmo pausado, como narrador de documental"</i>.</p>`;
}
function estadoVoz(p, alineando) {
  if (LG.subiendo !== null) return barra(`Subiendo voz… ${LG.subiendo}%`, LG.subiendo, 'bg-sky-500');
  if (alineando) return barra(alineando.mensaje || 'Alineando…', alineando.progreso, 'bg-emerald-500');
  const al = p.alineacion;
  const ultimo = (S.estado?.jobs || []).find(j => j.proyecto === p.id && j.tipo === 'alinear');
  if (ultimo?.estado === 'error') return `<pre class="mt-3 whitespace-pre-wrap rounded-lg bg-red-500/10 p-3 text-xs text-red-300">${esc(ultimo.error)}</pre>`;
  if (!p.voz) return '';
  if (!al) return '<p class="mt-3 text-xs text-amber-300">La voz aún no está alineada.</p>';
  return `<p class="mt-3 text-xs ${al.aproximado || al.coincidencia < 0.6 ? 'text-amber-300' : 'text-green-400'}">
    ${al.aproximado ? '⚠ Alineación aproximada (sin Whisper): revisa los cortes escuchando cada sección.'
      : `✓ Voz alineada · ${Math.round(al.coincidencia * 100)} % de las palabras coinciden con el guion${al.coincidencia < 0.6 ? ' (bajo: ¿la voz es de otra versión del guion?)' : ''}`}
    · ${fmtT(al.duracion)}</p>
    ${(al.avisos || []).length ? `<ul class="mt-1.5 space-y-1 text-[11px] text-amber-300/90">${al.avisos.map(x => `<li class="break-words">• ${esc(x)}</li>`).join('')}</ul>` : ''}`;
}
const barra = (txt, pct, color) => `<div class="mt-3 rounded-lg bg-zinc-950/60 p-3 text-xs"><div class="flex justify-between"><span class="text-zinc-400">${esc(txt)}</span><b>${pct}%</b></div>
  <div class="mt-2 h-1.5 overflow-hidden rounded bg-zinc-800"><div class="h-full ${color} transition-all" style="width:${pct}%"></div></div></div>`;

function tarjetaSeccion(s, i) {
  const D = durSec(s);
  const campo = 'rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-[16px] md:text-sm outline-none focus:border-zinc-500';
  const tomas = s.plantilla === 'comparacion' ? [0, 1] : [0];
  return `
  <article data-sec="${s.id}" class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <b class="w-6 text-center text-zinc-500">${i + 1}</b>
      <input data-lgs="titulo" value="${esc(s.titulo)}" placeholder="Título en pantalla" class="${campo} min-w-0 flex-1 font-semibold" />
      <select data-lgs="plantilla" class="${campo}">
        <option value="comparacion" ${s.plantilla === 'comparacion' ? 'selected' : ''}>⇆ Comparación</option>
        <option value="clip" ${s.plantilla === 'clip' ? 'selected' : ''}>▭ Clip</option>
      </select>
      <span class="rounded bg-zinc-800 px-2 py-1 font-mono text-xs ${D ? 'text-zinc-200' : 'text-zinc-500'}">${D ? fmtT(D) : '–:–'}</span>
      <button data-lga="ver" ${D ? '' : 'disabled'} title="Ver cómo queda esta sección (sin exportar)" class="${btnBase} px-3 py-2 text-xs">👁 Ver</button>
      <button data-lga="escuchar" ${D ? '' : 'disabled'} class="${btnBase} px-3 py-2 text-xs">${LG.escuchando === s.id ? '⏹ Detener' : '▶ Escuchar'}</button>
      <label class="flex items-center gap-1.5 text-xs text-zinc-300"><input type="checkbox" data-lgs="short" ${s.short ? 'checked' : ''} class="h-4 w-4 accent-fuchsia-500" />Short</label>
    </div>
    <details class="mt-2 pl-8"><summary class="cursor-pointer text-[11px] text-zinc-500">Narración</summary><p class="mt-1 text-sm text-zinc-300">${esc(s.narracion)}</p></details>
    <div class="mt-2 grid min-w-0 grid-cols-1 gap-2 pl-8 ${tomas.length > 1 ? 'md:grid-cols-2' : ''}">${tomas.map(j => bloqueToma(s, j, D)).join('')}</div>
    ${s.short ? `<div class="mt-2 pl-8"><input data-lgs="gancho" value="${esc(s.shortInfo?.gancho || '')}" placeholder="Gancho del short (arriba)" class="${campo} w-full" /></div>` : ''}
  </article>`;
}

// ───────────── 3 · Audio: sonido de los clips y música ─────────────
function tarjetaAudio(p) {
  const A = p.audio || {}, todos = p.secciones.flatMap(x => x.tomas.flatMap(t => t.clips || []));
  const con = todos.filter(c => c.sonido).length;
  const volC = Math.round((A.clips ?? 0.35) * 100), volM = Math.round((A.volMusica ?? 0.12) * 100);
  return `
  <section class="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
    <h3 class="font-bold">3 · Audio</h3>
    <div class="mt-3 grid gap-4 md:grid-cols-2">
      <div class="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
        <p class="text-sm font-semibold">🎮 Sonido de los clips</p>
        <p class="mt-1 text-[11px] text-zinc-400">Por defecto todos van <b>en silencio</b> (muchos traen la voz del streamer). Toca 🔇 en un clip sin comentarios para usar el sonido del juego; siempre se agacha cuando hablas.</p>
        <p class="mt-2 text-xs text-zinc-300">${con ? `<b class="text-green-400">${con}</b> de ${todos.length} clips con sonido` : `Los ${todos.length} clips en silencio`}</p>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button data-lga="sonido-todos" data-on="0" class="${btnBase} px-3 py-1.5 text-xs">🔇 Silenciar todos</button>
          <button data-lga="sonido-todos" data-on="1" class="${btnBase} px-3 py-1.5 text-xs">🔊 Sonido a todos</button>
        </div>
        <label class="mt-3 block text-[11px] text-zinc-400">Volumen de los clips con 🔊: <b data-vol="clips" class="text-zinc-200">${volC}%</b>
          <input type="range" data-lg="vol-clips" min="5" max="80" step="5" value="${volC}" class="mt-1 w-full accent-fuchsia-500" /></label>
      </div>
      <div class="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
        <p class="text-sm font-semibold">🎵 Música de fondo <span class="text-[11px] font-normal text-zinc-500">(opcional)</span></p>
        <p class="mt-1 text-[11px] text-zinc-400">Suena en loop todo el video, bajita, se agacha cuando hablas y se desvanece al final. Usa música libre de derechos (Biblioteca de audio de YouTube / Estudio).</p>
        ${A.musica ? `
        <p class="mt-2 truncate text-xs text-zinc-200" title="${esc(A.musicaNombre || '')}">🎵 ${esc(A.musicaNombre || A.musica)}</p>
        <audio src="/api/proyectos/${enc(p.id)}/musica?v=${enc(A.musica + (A.musicaNombre || ''))}" controls preload="none" class="mt-2 w-full"></audio>
        <label class="mt-2 block text-[11px] text-zinc-400">Volumen de la música: <b data-vol="musica" class="text-zinc-200">${volM}%</b>
          <input type="range" data-lg="vol-musica" min="2" max="40" step="1" value="${volM}" class="mt-1 w-full accent-fuchsia-500" /></label>
        <div class="mt-2 flex gap-1.5">
          <label class="cursor-pointer ${btnBase} px-3 py-1.5 text-xs">Cambiar<input type="file" data-lg="musica" accept="audio/*,.mp3,.wav,.m4a" class="hidden" /></label>
          <button data-lga="quitar-musica" class="${btnBase} px-3 py-1.5 text-xs text-zinc-400 hover:text-red-300">Quitar</button>
        </div>` : `
        <label class="mt-3 inline-block cursor-pointer rounded-lg border border-zinc-600 px-4 py-2.5 text-sm font-semibold active:scale-[.98]">${LG.subiendoMusica != null ? `Subiendo ${LG.subiendoMusica}%…` : '🎵 Subir canción'}
          <input type="file" data-lg="musica" accept="audio/*,.mp3,.wav,.m4a" class="hidden" /></label>`}
      </div>
    </div>
    <button data-lga="ver" ${p.alineacion ? '' : 'disabled'} class="mt-3 rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-zinc-950 active:scale-[.98] disabled:opacity-40">👁 Probar cómo se oye (vista previa)</button>
    <p class="mt-3 text-[11px] text-zinc-500">Cuando todo esté listo, exporta con <b>⬆ Video largo 16:9</b> o <b>⬆ shorts</b> (arriba).</p>
  </section>`;
}
function guardarAudio(cambios) {
  LG.p.audio = { ...(LG.p.audio || {}), ...cambios };
  clearTimeout(LG.audioTimer);
  LG.audioTimer = setTimeout(() => api(`/api/proyectos/${enc(LG.p.id)}/audio`, { method: 'PUT', body: JSON.stringify(cambios) }).catch(err => toast(err.message, 'error')), 400);
}
async function subirMusica(file) {
  LG.subiendoMusica = 0; render(true);
  try {
    const r = await fetch(`/api/proyectos/${enc(LG.p.id)}/musica`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Nombre': encodeURIComponent(file.name) }, body: file });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'No se pudo subir la canción');
    LG.p.audio = j; toast('Música lista · ajusta el volumen');
  } catch (err) { toast(err.message, 'error'); }
  LG.subiendoMusica = null; render(true);
}

// ───────────── fuentes (VODs) ─────────────
async function cargarFuentes() {
  try { LG.fuentes = await api('/api/fuentes'); } catch { /* servidor sin fuentes */ }
  const box = $('#lg-fuentes'); if (box) box.innerHTML = listaFuentes();
}
const fuentesProcesando = () => LG.fuentes.some(f => f.estado === 'procesando' || f.estado === 'en cola');
const hhmmss = t => { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, x = t % 60; return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(x).padStart(2, '0')}`; };
function linkEnTiempo(url, t) {
  t = Math.max(0, Math.floor(t));
  try {
    const u = new URL(url);
    if (/youtu\.?be/.test(u.hostname)) { u.searchParams.set('t', `${t}s`); return u.toString(); }
    if (/twitch\.tv/.test(u.hostname)) { u.searchParams.set('t', `${Math.floor(t / 3600)}h${Math.floor(t / 60) % 60}m${t % 60}s`); return u.toString(); }
    if (/kick\.com/.test(u.hostname)) { u.searchParams.set('t', String(t)); return u.toString(); }
  } catch { /* url rara */ }
  return url;
}
function listaFuentes() {
  if (!LG.fuentes.length) return '<p class="mt-3 text-xs text-zinc-500">Aún no hay fuentes. Empieza con 2–3 VODs donde streamers reaccionen a los trailers de GTA VI.</p>';
  return `<ul class="mt-3 space-y-1.5">${LG.fuentes.map(f => {
    const proc = f.estado === 'procesando' || f.estado === 'en cola';
    return `<li class="rounded-lg bg-zinc-950/60 px-3 py-2 text-xs">
      <div class="flex items-center gap-2">
        <span class="shrink-0">${f.estado === 'listo' ? '✅' : f.estado === 'error' ? '⚠️' : '⏳'}</span>
        <a href="${esc(f.url)}" target="_blank" rel="noopener" class="min-w-0 flex-1 truncate hover:underline" title="${esc(f.titulo)}">${esc(f.titulo || f.url)}</a>
        <span class="shrink-0 text-zinc-500">${esc(f.canal || '')}${f.duracion ? ' · ' + hhmmss(f.duracion) : ''}</span>
        ${f.estado === 'error' ? `<button data-lga="fuente-reintentar" data-id="${esc(f.id)}" class="shrink-0 rounded bg-zinc-800 px-2 py-1">↻ Reintentar</button>` : ''}
        ${proc ? '' : `<button data-lga="fuente-borrar" data-id="${esc(f.id)}" title="Quitar fuente" class="shrink-0 px-1 text-zinc-500 hover:text-red-400">✕</button>`}
      </div>
      ${proc ? `<div class="mt-1.5 h-1.5 overflow-hidden rounded bg-zinc-800"><div class="h-full bg-sky-500 transition-all" style="width:${f.progreso || 0}%"></div></div>
        <p class="mt-1 text-[11px] text-zinc-400">${esc(f.mensaje || '')}</p>` : ''}
      ${f.estado === 'listo' ? `<p class="mt-0.5 text-[11px] text-zinc-500">${esc(f.origen || '')}${f.idioma ? ' · ' + esc(f.idioma) : ''} · ${f.segmentos || 0} frases</p>` : ''}
      ${f.estado === 'error' ? `<p class="mt-1 whitespace-pre-wrap text-[11px] text-red-300">${esc(f.error || '')}</p>` : ''}
    </li>`;
  }).join('')}</ul>`;
}
const STOP_RES = new Set('the and you this that for with are was what not but its que los las del por una como esta este eso mas muy'.split(' '));
const nombrePlataforma = h => (/twitch/i.test(h.plataforma || h.url) ? 'Twitch' : /youtu/i.test(h.plataforma || h.url) ? 'YouTube' : /kick/i.test(h.plataforma || h.url) ? 'Kick' : 'el sitio');
function resaltar(texto, q) {
  const ws = String(q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9ñ]+/).filter(w => w.length > 2 && !STOP_RES.has(w));
  const h = esc(texto);
  if (!ws.length) return h;
  const re = new RegExp(`\\b(${ws.map(w => w.replace(/[^a-z0-9ñ]/g, '')).join('|')})\\w*`, 'gi');
  return h.replace(re, m => `<mark class="rounded bg-amber-400/80 px-0.5 text-zinc-950">${m}</mark>`);
}
function listaHits() {
  const B = LG.busq;
  if (B.cargando) return '<p class="p-3 text-xs text-zinc-400">Buscando…</p>';
  if (!B.hits) return '';
  if (!B.hits.length) return '<p class="p-3 text-xs text-zinc-500">Sin coincidencias. Prueba otra frase más corta (2–3 palabras clave) o agrega más fuentes.</p>';
  return B.hits.map((h, i) => `
    <li><button data-lga="hit" data-i="${i}" class="w-full rounded-lg px-2.5 py-2 text-left text-xs ${B.sel === i ? 'bg-sky-500/20 ring-1 ring-sky-500' : 'hover:bg-zinc-800'}">
      <span class="flex items-center gap-2"><b class="font-mono text-sky-300">${hhmmss(h.t)}</b><span class="min-w-0 flex-1 truncate text-zinc-500">${esc(h.canal || '')} · ${esc(h.titulo || '')}</span></span>
      <span class="mt-0.5 line-clamp-2 block text-zinc-300">${resaltar(h.texto, h.consulta)}</span></button></li>`).join('');
}
function panelHit() {
  const B = LG.busq, h = B.hits?.[B.sel];
  if (!h) return '<p class="grid h-full place-items-center p-6 text-center text-sm text-zinc-500">Busca una frase y elige un momento.<br><span class="text-xs">Luego ⬇ Traer descarga solo ese pedazo a Raw y te lo abre aquí para recortarlo.</span></p>';
  const ini = Math.max(0, h.t - 8);
  return `
    <div class="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
      <p class="text-xs text-zinc-500">${esc(h.canal || '')} · ${esc(h.titulo || '')}</p>
      <p class="mt-1 font-mono text-lg font-bold text-sky-300">${hhmmss(h.t)}</p>
      <p class="mt-2 text-sm leading-relaxed text-zinc-200">“${resaltar(h.texto, h.consulta)}”</p>
      <p class="mt-2 text-[11px] text-zinc-500">Coincidió con: ${esc(h.consulta)}</p>
      <a href="${esc(linkEnTiempo(h.url, ini))}" target="_blank" rel="noopener" class="mt-3 inline-block rounded-lg border border-zinc-600 px-3 py-2 text-xs font-semibold">▶ Ver ese momento en ${nombrePlataforma(h)}</a>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <select data-lg="ventana" class="rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-sm">
        ${[30, 60, 90].map(v => `<option value="${v}" ${B.ventana === v ? 'selected' : ''}>${v} s</option>`).join('')}</select>
      <span class="font-mono text-[11px] text-zinc-500">${hhmmss(ini)} → ${hhmmss(ini + B.ventana)}</span>
      <button data-lga="traer" ${LG.traer ? 'disabled' : ''} class="ml-auto rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-bold active:scale-[.98] disabled:opacity-50">${LG.traer ? '⏳ Trayendo…' : `⬇ Traer ${B.ventana} s`}</button>
    </div>
    <p class="mt-1.5 text-[11px] text-zinc-500">Empieza 8 s antes de la frase para que no se corte la reacción. Al terminar se abre en la vista Raw para marcar inicio y fin exactos.</p>`;
}
function vistaBuscar(t) {
  const B = LG.busq, listas = LG.fuentes.filter(f => f.estado === 'listo').length;
  return `
    <div class="flex min-h-0 min-w-0 flex-col gap-2">
      ${t?.busqueda?.length ? `<div class="flex flex-wrap gap-1">${t.busqueda.map(q => `<button data-lga="chip" data-q="${esc(q)}" class="rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] ${B.q === q ? 'border-sky-500 bg-sky-500/20 text-sky-200' : 'text-zinc-300 hover:border-zinc-500'}">${esc(q)}</button>`).join('')}</div>` : ''}
      <div class="flex gap-1.5"><input data-lg="q" value="${esc(B.q)}" placeholder="Qué dice el streamer… (ej. look at the water)" class="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 text-[16px] md:text-sm outline-none" />
        <button data-lga="buscar" class="rounded-lg bg-sky-600 px-3 text-xs font-bold">Buscar</button></div>
      <p class="text-[10px] text-zinc-500">${listas ? `Buscando en ${listas} fuente${listas > 1 ? 's' : ''} transcrita${listas > 1 ? 's' : ''}.` : 'Aún no hay fuentes listas: agrégalas en la tarjeta “🔎 Fuentes” del proyecto.'}</p>
      <ul id="lg-hits" class="max-h-[50vh] space-y-1 overflow-auto">${listaHits()}</ul>
    </div>
    <div id="lg-hit" class="min-w-0">${panelHit()}</div>`;
}
async function buscarFuentes(q) {
  const B = LG.busq;
  B.q = q ?? B.q;
  if (!B.q.trim()) return toast('Escribe qué buscar', 'info');
  B.cargando = true; B.sel = null; render(true);
  try { B.hits = (await api('/api/fuentes/buscar', { method: 'POST', body: JSON.stringify({ consultas: [B.q] }) })).hits; }
  catch (err) { B.hits = []; toast(err.message, 'error'); }
  B.cargando = false; render(true);
}

function bloqueToma(s, j, D) {
  const t = s.tomas[j] || { etiqueta: '', clips: [], busqueda: [] };
  const mat = (t.clips || []).reduce((a, c) => a + durClipLg(c), 0);
  const falta = D && mat < D - 0.2;
  return `
  <div data-toma="${j}" class="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/50 p-2.5">
    <div class="flex items-center gap-2">
      <input data-lgt="etiqueta" value="${esc(t.etiqueta)}" placeholder="Etiqueta (ej. GTA V)" class="w-32 rounded-md bg-amber-400 px-2 py-1 text-xs font-bold text-zinc-950 outline-none" />
      <span class="ml-auto font-mono text-[11px] ${!D ? 'text-zinc-500' : falta ? 'text-amber-300' : 'text-green-400'}">${fmtT(mat)}${D ? ` / ${fmtT(D)}` : ''}</span>
    </div>
    ${t.descripcion ? `<p class="mt-1.5 text-[11px] text-zinc-400">🎬 ${esc(t.descripcion)}</p>` : ''}
    ${t.busqueda?.length ? `<p class="mt-1 flex flex-wrap gap-1">${t.busqueda.slice(0, 6).map(b => `<span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">${esc(b)}</span>`).join('')}</p>` : ''}
    <ul class="mt-2 space-y-1">${(t.clips || []).map((c, k) => `
      <li class="flex items-center gap-2 rounded-lg bg-zinc-900 px-2 py-1.5 text-xs">
        <span class="min-w-0 flex-1 truncate" title="${esc(c.archivo)}">${esc(nombreCorto(c.archivo))}</span>
        <span class="shrink-0 font-mono text-[10px] text-zinc-400">${fmtT(c.a)}→${fmtT(c.b)}</span>
        <button data-lga="sonido-clip" data-k="${k}" title="${c.sonido ? 'Con sonido del juego (clic para silenciar)' : 'En silencio (clic para usar su sonido)'}" class="shrink-0 px-1 ${c.sonido ? 'text-green-400' : 'text-zinc-600 hover:text-zinc-300'}">${c.sonido ? '🔊' : '🔇'}</button>
        ${t.clips.length > 1 ? `<button data-lga="mover-clip" data-k="${k}" data-d="-1" ${k === 0 ? 'disabled' : ''} title="Subir" class="shrink-0 px-1 text-zinc-500 hover:text-white disabled:opacity-20">↑</button>
        <button data-lga="mover-clip" data-k="${k}" data-d="1" ${k === t.clips.length - 1 ? 'disabled' : ''} title="Bajar" class="shrink-0 px-1 text-zinc-500 hover:text-white disabled:opacity-20">↓</button>` : ''}
        <button data-lga="quitar-clip" data-k="${k}" class="shrink-0 px-1 text-zinc-500 hover:text-red-400">✕</button>
      </li>`).join('')}</ul>
    <button data-lga="agregar-clip" class="mt-2 w-full rounded-lg border border-dashed border-zinc-700 py-2 text-xs text-zinc-300 hover:border-zinc-500">+ Agregar clip${falta ? ` (faltan ${fmtT(D - mat)})` : ''}</button>
  </div>`;
}

function vistaPicker() {
  const P = LG.picker, raw = S.estado?.canales?.gtavi?.raw || [];
  const s = LG.p.secciones.find(x => x.id === P.secId), t = s?.tomas[P.toma];
  const f = (P.filtro || '').toLowerCase();
  const lista = raw.filter(r => !f || `${r.name} ${r.info?.texto || ''} ${r.info?.creador || ''}`.toLowerCase().includes(f));
  return `
  <div id="lg-picker" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
    <div class="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900">
      <div class="flex items-center gap-2 border-b border-zinc-800 p-3">
        <b class="min-w-0 flex-1 truncate">Agregar clip a <span class="rounded bg-amber-400 px-1.5 text-zinc-950">${esc(t?.etiqueta || 'toma')}</span> · ${esc(s?.titulo || '')}</b>
        <button data-lga="cerrar-picker" class="px-2 text-xl text-zinc-400">✕</button>
      </div>
      <div class="flex gap-1 border-b border-zinc-800 px-3 pt-2">
        ${[['raw', '📁 Mis clips (Raw)'], ['buscar', '🔎 Buscar en fuentes']].map(([m, l]) => `<button data-lga="picker-modo" data-m="${m}" class="rounded-t-lg px-3 py-2 text-xs font-semibold ${(P.modo || 'raw') === m ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}">${l}</button>`).join('')}
      </div>
      <div class="grid min-h-0 flex-1 gap-3 overflow-auto p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        ${P.modo === 'buscar' ? vistaBuscar(t) : `
        <div class="flex min-h-0 min-w-0 flex-col gap-2">
          <input data-lg="filtro" value="${esc(P.filtro || '')}" placeholder="Buscar en Raw…" class="rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 text-[16px] md:text-sm outline-none" />
          <ul id="lg-picker-lista" class="max-h-[50vh] space-y-1 overflow-auto">${lista.map(r => `
            <li><button data-lga="elegir-raw" data-name="${esc(r.name)}" class="w-full rounded-lg px-2.5 py-2 text-left text-xs ${r.name === P.archivo ? 'bg-fuchsia-500/20 ring-1 ring-fuchsia-500' : 'hover:bg-zinc-800'}">
              <span class="block truncate">${esc(r.info?.texto || r.name)}</span><span class="block truncate text-zinc-500">${esc(r.info?.creador || '')} · ${tam(r.size)}</span></button></li>`).join('') || '<li class="p-3 text-xs text-zinc-500">Nada en Raw con ese texto.</li>'}</ul>
          <details class="rounded-lg border border-zinc-800 p-2"><summary class="cursor-pointer text-xs text-zinc-400">⬇ Descargar de un stream o video (URL + tramo)</summary>
            <input data-lg="dl-url" placeholder="URL de Twitch, Kick o YouTube" class="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-[16px] md:text-sm" />
            <div class="mt-1.5 flex gap-1.5"><input data-lg="dl-rango" data-rango inputmode="numeric" placeholder="104350 104430 → 10:43:50-10:44:30" class="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-[16px] md:text-sm" />
            <button data-lga="dl" class="max-w-[60%] truncate rounded-lg bg-sky-600 px-3 text-xs font-bold">Descargar</button></div>
            <p class="mt-1 text-[10px] text-zinc-500">Al terminar aparece en esta lista.</p></details>
        </div>
        <div class="min-w-0">
          ${P.archivo ? `
          <video id="lg-video" data-vkey="picker" src="/media/gtavi/raw/${enc(P.archivo)}" controls playsinline preload="auto" class="aspect-video w-full rounded-lg bg-black"></video>
          <div class="mt-2 grid grid-cols-2 gap-2">
            <label class="block"><span class="text-[11px] text-zinc-500">Inicio</span><input data-lg="pa" value="${esc(P.a ?? '')}" placeholder="0:00.0" class="mt-0.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-[16px] md:text-sm" /></label>
            <label class="block"><span class="text-[11px] text-zinc-500">Fin</span><input data-lg="pb" value="${esc(P.b ?? '')}" placeholder="final" class="mt-0.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-[16px] md:text-sm" /></label>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <button data-lga="marcar-a" class="${btnBase} px-3 py-2 text-xs">⟦ Inicio aquí</button>
            <button data-lga="marcar-b" class="${btnBase} px-3 py-2 text-xs">Fin aquí ⟧</button>
            <button data-lga="confirmar-clip" class="ml-auto rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-bold">Agregar a ${esc(t?.etiqueta || 'la toma')}</button>
          </div>
          <p class="mt-1.5 text-[11px] text-zinc-500">Puedes agregar varios pedazos seguidos a la misma toma; se reproducen en orden.</p>`
          : '<p class="grid h-full place-items-center p-6 text-sm text-zinc-500">Elige un clip de la lista</p>'}
        </div>`}
      </div>
    </div>
  </div>`;
}

// ───────────── capas de texto (canvas, con emojis) ─────────────
function dibujarCapaLargo(cv, s, orient) {
  const L = LAY[orient], W = L.W, H = L.H;
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, W, H);
  const pan = L[s.plantilla] || L.clip;
  const etiqueta = (t, x, y, size) => t && textoCanvas(ctx, t, { size, x, y, color: '#09090b', borde: 0, sombra: 0, caja: { color: '#FFD400', pad: 12 } });
  if (orient === 'h') {
    if (s.plantilla === 'comparacion') {
      textoCanvas(ctx, s.titulo, { size: 76, y: 120 });
      s.tomas.forEach((t, j) => pan[j] && etiqueta(t.etiqueta, pan[j].x + 28, pan[j].y + 26, 44));
    }
    return;
  }
  const gancho = String(s.shortInfo?.gancho || s.titulo || '').trim();
  if (s.plantilla === 'comparacion') {
    let size = 66, lineas = envolverCli(gancho, 24);
    if (lineas.length > 3) { size = 54; lineas = envolverCli(gancho, 30); }
    const lh = Math.round(size * 1.25), y0 = Math.round(150 - (lineas.length * lh) / 2 + 20);
    lineas.forEach((ln, i) => textoCanvas(ctx, ln, { size, y: Math.max(40, y0) + i * lh }));
    s.tomas.forEach((t, j) => pan[j] && etiqueta(t.etiqueta, pan[j].x + 26, pan[j].y + 24, 46));
  } else {
    const d = disenoVerticalCli({ srcW: 16, srcH: 9, hook: gancho, badge: '', credito: '' });
    d.lineas.forEach((ln, i) => textoCanvas(ctx, ln, { size: d.size, y: d.hookY + i * d.lh }));
    etiqueta(s.tomas[0]?.etiqueta, 26, pan[0].y + 24, 46);
  }
}
async function capasLargo(secciones, orient) {
  try { await document.fonts?.ready; } catch { /* sin API de fuentes */ }
  const cv = document.createElement('canvas'), out = {};
  for (const s of secciones) { dibujarCapaLargo(cv, s, orient); out[s.id] = { [orient]: cv.toDataURL('image/png') }; }
  return out;
}

// ───────────── refresco parcial (no reinicia videos ni campos) ─────────────
function montarLargo(soloEstado) {
  if (!LG.p) return;
  const jobs = (S.estado?.jobs || []).filter(j => j.proyecto === LG.p.id);
  const j = $('#lg-jobs'); if (j) j.innerHTML = jobs.filter(x => x.tipo !== 'alinear').map(filaJob).join('');
  const alineando = jobs.find(x => x.tipo === 'alinear' && (x.estado === 'procesando' || x.estado === 'en cola'));
  const v = $('#lg-voz'); if (v) v.innerHTML = estadoVoz(LG.p, alineando);
  // terminó la alineación: recargar el proyecto para traer los tiempos
  const recien = jobs.find(x => x.tipo === 'alinear' && x.estado === 'listo' && x.fin && x.fin > (LG.cargadoEn || 0));
  if (soloEstado && recien) { LG.cargadoEn = Date.now(); abrirProyecto(LG.p.id); }
  // "Traer" terminó: abrir el pedazo en el picker para recortarlo
  if (LG.traer) {
    const tj = (S.estado?.jobs || []).find(x => x.id === LG.traer.jobId);
    if (tj?.estado === 'listo' && (S.estado?.canales?.gtavi?.raw || []).some(r => r.name === tj.archivo)) {
      const T = LG.traer; LG.traer = null;
      toast('Pedazo traído a Raw · marca inicio y fin');
      LG.picker = { secId: T.secId, toma: T.toma, archivo: tj.archivo, a: '', b: '', filtro: '', modo: 'raw' };
      render(true);
    } else if (tj?.estado === 'error') {
      LG.traer = null; toast(`No se pudo descargar: ${tj.error || ''}`, 'error');
      if (LG.picker) render(true); // vuelve a habilitar los botones
    } else if (tj) {
      // avance visible en el botón que lo lanzó
      const txt = `⏳ ${tj.progreso ? tj.progreso + '% · ' : ''}${tj.mensaje || 'Descargando…'}`;
      document.querySelectorAll('[data-lga="dl"], [data-lga="traer"]').forEach(x => { x.disabled = true; x.textContent = txt; });
    } else if (S.estado && Date.now() - (LG.traer.desde || 0) > 15000) {
      LG.traer = null; if (LG.picker) render(true); // el servidor se reinició y el trabajo ya no existe
    }
  }
  if (soloEstado && fuentesProcesando()) cargarFuentes();
}
// mientras se transcribe una fuente, refrescar su avance
setInterval(() => { if (S.tab === 'largo' && LG.p && fuentesProcesando()) cargarFuentes(); }, 2500);

// ───────────── eventos ─────────────
const seccionDe = el => LG.p?.secciones.find(s => s.id === Number(el.closest('[data-sec]')?.dataset.sec));

document.addEventListener('input', e => {
  const t = e.target;
  if (!t.closest('#largo')) return;
  if (t.dataset.lg === 'json') { LG.json = t.value; return; }
  if (t.dataset.lg === 'fuente-url') { LG.fuenteUrl = t.value; return; }
  if (t.dataset.lg === 'q') { LG.busq.q = t.value; return; }
  if (t.dataset.lg === 'vol-clips' || t.dataset.lg === 'vol-musica') {
    const clips = t.dataset.lg === 'vol-clips', v = Number(t.value) / 100;
    const lbl = $(`[data-vol="${clips ? 'clips' : 'musica'}"]`); if (lbl) lbl.textContent = `${t.value}%`;
    guardarAudio(clips ? { clips: v } : { volMusica: v });
    return;
  }
  if (t.dataset.lg === 'pron') {
    LG.pron = t.value; localStorage.setItem('pronunciacion', t.value);
    const ej = t.closest('details')?.querySelector('p:last-child span'); if (ej) ej.textContent = ejemploPron(LG.p);
    return;
  }
  if (t.dataset.lg === 'filtro') {
    LG.picker.filtro = t.value;
    const box = $('#lg-picker'); if (!box) return;
    const html = vistaPicker(); const tmp = document.createElement('div'); tmp.innerHTML = html;
    $('#lg-picker-lista').innerHTML = $('#lg-picker-lista', tmp).innerHTML;
    return;
  }
  if (t.dataset.lg === 'pa' || t.dataset.lg === 'pb') { LG.picker[t.dataset.lg === 'pa' ? 'a' : 'b'] = t.value; return; }
  const s = seccionDe(t); if (!s) return;
  if (t.dataset.lgs === 'titulo') s.titulo = t.value;
  if (t.dataset.lgs === 'gancho') s.shortInfo = { ...(s.shortInfo || {}), gancho: t.value };
  if (t.dataset.lgt === 'etiqueta') s.tomas[Number(t.closest('[data-toma]').dataset.toma)].etiqueta = t.value;
  guardarSecciones();
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (!t.closest('#largo')) return;
  if (t.dataset.lg === 'modelo') { LG.modelo = t.value; localStorage.setItem('modeloVoz', t.value); return; }
  if (t.dataset.lg === 'ventana') { LG.busq.ventana = Number(t.value); const hb = $('#lg-hit'); if (hb) hb.innerHTML = panelHit(); return; }
  if (t.dataset.lg === 'voz' && t.files?.[0]) return subirVoz(t.files[0]);
  if (t.dataset.lg === 'musica' && t.files?.[0]) return subirMusica(t.files[0]);
  const s = seccionDe(t); if (!s) return;
  if (t.dataset.lgs === 'plantilla') {
    s.plantilla = t.value;
    if (s.plantilla === 'comparacion' && s.tomas.length < 2) s.tomas.push({ etiqueta: 'GTA VI', clips: [], busqueda: [] });
    guardarSecciones(); render(true);
  }
  if (t.dataset.lgs === 'short') { s.short = t.checked; guardarSecciones(); render(true); }
});

function subirVoz(file) {
  const xhr = new XMLHttpRequest();
  LG.subiendo = 0; montarLargo(false);
  xhr.upload.onprogress = ev => { if (ev.lengthComputable) { LG.subiendo = Math.round((ev.loaded / ev.total) * 100); const v = $('#lg-voz'); if (v) v.innerHTML = estadoVoz(LG.p); } };
  xhr.onload = async () => {
    LG.subiendo = null;
    let r = {}; try { r = JSON.parse(xhr.responseText); } catch { /* sin json */ }
    if (xhr.status >= 400) toast(r.error || 'No se pudo subir la voz', 'error');
    else toast('Voz subida · alineando con el guion…', 'info');
    LG.cargadoEn = Date.now();
    await refrescar(); await abrirProyecto(LG.p.id);
  };
  xhr.onerror = () => { LG.subiendo = null; toast('No se pudo subir la voz', 'error'); render(true); };
  xhr.open('POST', `/api/proyectos/${enc(LG.p.id)}/voz?modelo=${enc(LG.modelo)}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-Nombre', encodeURIComponent(file.name).replace(/%2E/gi, '.'));
  xhr.send(file);
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-lga]'); if (!b || !b.closest('#largo')) return;
  const a = b.dataset.lga, s = seccionDe(b);
  if (a === 'crear') {
    if (!LG.json.trim()) return toast('Pega primero el JSON del guion', 'info');
    try { const p = await api('/api/proyectos', { method: 'POST', body: JSON.stringify({ json: LG.json }) }); LG.json = ''; await cargarProyectos(); abrirProyecto(p.id); }
    catch (err) { toast(err.message, 'error'); }
  }
  if (a === 'abrir') abrirProyecto(b.dataset.id);
  if (a === 'pron-base') { LG.pron = PRONUNCIACION_BASE; localStorage.setItem('pronunciacion', LG.pron); LG.verPron = true; render(true); }
  if (a === 'borrar') {
    if (!confirm(`¿Borrar el proyecto "${LG.p.titulo}"?\n\nSu carpeta (guion, voz y alineación) va a la Papelera. Los videos ya exportados en Listos no se tocan.`)) return;
    try {
      const r = await api(`/api/proyectos/${enc(LG.p.id)}`, { method: 'DELETE' });
      toast(`Proyecto borrado → ${r.destino}`);
      LG.p = null; LG.id = null; localStorage.removeItem('proyectoLargo'); await cargarProyectos(); render(true);
    } catch (err) { toast(err.message, 'error'); }
  }
  if (a === 'volver') { LG.p = null; LG.id = null; localStorage.removeItem('proyectoLargo'); await cargarProyectos(); render(true); }
  if (a === 'copiar-voz') {
    const ok = await copiar(LG.p.secciones.map(x => textoParaVoz(x.narracion)).join('\n\n'));
    const l = $('.lbl', b), antes = l.textContent;
    if (ok) { b.classList.add('ok-flash'); l.textContent = '✓ Copiado · pégalo en AI Studio'; setTimeout(() => { b.classList.remove('ok-flash'); l.textContent = antes; }, 1800); }
    else toast('No se pudo copiar', 'error');
  }
  if (a === 'alinear') {
    try { await api(`/api/proyectos/${enc(LG.p.id)}/alinear`, { method: 'POST', body: JSON.stringify({ modelo: LG.modelo }) }); LG.cargadoEn = Date.now(); await refrescar(); }
    catch (err) { toast(err.message, 'error'); }
  }
  if (a === 'escuchar' && s) {
    const t = secT(s), au = $('#lg-audio'); if (!t || !au) return;
    if (LG.escuchando === s.id && !au.paused) { au.pause(); return; }
    au.currentTime = t.t0; LG.parar = t.t1; LG.escuchando = s.id;
    au.play().catch(() => { LG.escuchando = null; });
    botonesEscuchar();
  }
  if (a === 'agregar-clip' && s) {
    LG.picker = { secId: s.id, toma: Number(b.closest('[data-toma]').dataset.toma), archivo: null, a: '', b: '', filtro: LG.picker?.filtro || '' };
    render(true);
  }
  if (a === 'miniatura') return abrirMiniatura();
  if (a === 'ver') { if (!LG.p.alineacion) return toast('Primero sube y alinea la voz', 'info'); clearTimeout(LG.guardarTimer); return abrirVista(s?.id ?? null); }
  if (a === 'sonido-clip' && s) {
    const c = s.tomas[Number(b.closest('[data-toma]').dataset.toma)].clips[Number(b.dataset.k)];
    c.sonido = !c.sonido;
    guardarSecciones(); render(true);
  }
  if (a === 'sonido-todos') {
    const on = b.dataset.on === '1';
    for (const x of LG.p.secciones) for (const t of x.tomas) for (const c of t.clips || []) c.sonido = on;
    guardarSecciones(); render(true);
    toast(on ? 'Todos los clips con sonido' : 'Todos los clips en silencio');
  }
  if (a === 'quitar-musica') {
    try { LG.p.audio = await api(`/api/proyectos/${enc(LG.p.id)}/musica`, { method: 'DELETE' }); render(true); } catch (err) { toast(err.message, 'error'); }
  }
  if (a === 'mover-clip' && s) {
    const cl = s.tomas[Number(b.closest('[data-toma]').dataset.toma)].clips, k = Number(b.dataset.k), d = Number(b.dataset.d);
    if (!cl[k + d]) return;
    [cl[k], cl[k + d]] = [cl[k + d], cl[k]];
    guardarSecciones(); render(true);
  }
  if (a === 'quitar-clip' && s) {
    s.tomas[Number(b.closest('[data-toma]').dataset.toma)].clips.splice(Number(b.dataset.k), 1);
    guardarSecciones(); render(true);
  }
  if (a === 'cerrar-picker') { LG.picker = null; render(true); }
  if (a === 'picker-modo') {
    LG.picker.modo = b.dataset.m;
    if (b.dataset.m === 'buscar') {
      const t = LG.p.secciones.find(x => x.id === LG.picker.secId)?.tomas[LG.picker.toma];
      if (!LG.busq.q && t?.busqueda?.length) { cargarFuentes(); return buscarFuentes(t.busqueda[0]); }
      cargarFuentes();
    }
    render(true);
  }
  if (a === 'chip') return buscarFuentes(b.dataset.q);
  if (a === 'buscar') return buscarFuentes($('[data-lg="q"]')?.value ?? LG.busq.q);
  if (a === 'hit') {
    LG.busq.sel = Number(b.dataset.i);
    document.querySelectorAll('#lg-hits [data-lga="hit"]').forEach((x, i) => x.className = x.className.replace(/bg-sky-500\/20 ring-1 ring-sky-500|hover:bg-zinc-800/, i === LG.busq.sel ? 'bg-sky-500/20 ring-1 ring-sky-500' : 'hover:bg-zinc-800'));
    const hb = $('#lg-hit'); if (hb) { hb.innerHTML = panelHit(); if (innerWidth < 768) hb.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  if (a === 'traer') {
    const h = LG.busq.hits?.[LG.busq.sel]; if (!h || LG.traer) return;
    const ini = Math.max(0, h.t - 8), rango = `${hhmmss(ini)}-${hhmmss(ini + LG.busq.ventana)}`;
    try {
      const job = await api('/api/clips/descargar', { method: 'POST', body: JSON.stringify({ url: h.url, rango, creador: h.canal || '' }) });
      LG.traer = { jobId: job.id, secId: LG.picker.secId, toma: LG.picker.toma, desde: Date.now() };
      toast(`Trayendo ${rango}…`, 'info');
      const hb = $('#lg-hit'); if (hb) hb.innerHTML = panelHit();
      await refrescar();
    } catch (err) { toast(err.message, 'error'); }
  }
  if (a === 'fuente-agregar') {
    const url = ($('[data-lg="fuente-url"]')?.value || LG.fuenteUrl).trim();
    if (!/^https?:\/\//i.test(url)) return toast('Pega una URL válida', 'info');
    try { await api('/api/fuentes', { method: 'POST', body: JSON.stringify({ url }) }); LG.fuenteUrl = ''; const i = $('[data-lg="fuente-url"]'); if (i) i.value = ''; toast('Fuente agregada · transcribiendo…', 'info'); }
    catch (err) { toast(err.message, 'error'); }
    cargarFuentes();
  }
  if (a === 'fuente-reintentar') { try { await api(`/api/fuentes/${enc(b.dataset.id)}/reintentar`, { method: 'POST' }); } catch (err) { toast(err.message, 'error'); } cargarFuentes(); }
  if (a === 'fuente-borrar') {
    const f = LG.fuentes.find(x => x.id === b.dataset.id);
    if (!confirm(`¿Quitar "${f?.titulo || 'esta fuente'}" de la biblioteca?\n\nSu transcripción va a la Papelera.`)) return;
    try { await api(`/api/fuentes/${enc(b.dataset.id)}`, { method: 'DELETE' }); } catch (err) { toast(err.message, 'error'); }
    cargarFuentes();
  }
  if (a === 'elegir-raw') { LG.picker = { ...LG.picker, archivo: b.dataset.name, a: '', b: '' }; render(true); }
  if (a === 'marcar-a' || a === 'marcar-b') {
    const v = $('#lg-video'); if (!v) return;
    const k = a === 'marcar-a' ? 'a' : 'b';
    LG.picker[k] = fmtT(v.currentTime);
    $(`[data-lg="p${k}"]`).value = LG.picker[k];
  }
  if (a === 'confirmar-clip') {
    const v = $('#lg-video'), P = LG.picker;
    const ini = parseT(P.a) ?? 0, fin = parseT(P.b) ?? (v?.duration || 0);
    if (Number.isNaN(ini) || Number.isNaN(fin) || fin <= ini + 0.1) return toast('Revisa inicio y fin', 'info');
    const sec = LG.p.secciones.find(x => x.id === P.secId);
    sec.tomas[P.toma].clips.push({ archivo: P.archivo, a: +ini.toFixed(2), b: +fin.toFixed(2) });
    guardarSecciones();
    LG.picker = null; render(true);
    toast(`Clip agregado (${fmtT(fin - ini)})`);
  }
  if (a === 'dl') {
    const url = $('[data-lg="dl-url"]')?.value.trim(), rango = $('[data-lg="dl-rango"]')?.value.trim();
    if (!/^https?:\/\//i.test(url || '')) return toast('Pega una URL válida', 'info');
    if (LG.traer) return toast('Espera a que termine la descarga anterior', 'info');
    try {
      const job = await api('/api/clips/descargar', { method: 'POST', body: JSON.stringify({ url, rango, creador: '' }) });
      LG.traer = { jobId: job.id, secId: LG.picker.secId, toma: LG.picker.toma, desde: Date.now() };
      toast(`Descargando ${rango || 'el video completo'}… se abrirá aquí al terminar`, 'info');
      b.disabled = true; b.textContent = '⏳ Descargando…';
      await refrescar();
    } catch (err) { toast(err.message, 'error'); }
  }
  if (a === 'exportar') {
    const tipo = b.dataset.tipo, secs = tipo === 'shorts' ? LG.p.secciones.filter(x => x.short) : LG.p.secciones;
    b.disabled = true;
    try {
      clearTimeout(LG.guardarTimer);
      await api(`/api/proyectos/${enc(LG.p.id)}/secciones`, { method: 'PUT', body: JSON.stringify({ secciones: LG.p.secciones }) });
      const capas = await capasLargo(secs, tipo === 'shorts' ? 'v' : 'h');
      const job = await api(`/api/proyectos/${enc(LG.p.id)}/exportar`, { method: 'POST', body: JSON.stringify({ tipo, secciones: secs.map(x => x.id), capas }) });
      toast(`${job.titulo} · en cola`, 'info'); await refrescar();
    } catch (err) { toast(err.message, 'error'); }
    b.disabled = false;
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.closest?.('#largo')) return;
  if (e.target.dataset.lg === 'q') { e.preventDefault(); buscarFuentes(e.target.value); }
  if (e.target.dataset.lg === 'fuente-url') { e.preventDefault(); $('[data-lga="fuente-agregar"]')?.click(); }
});

document.addEventListener('toggle', e => { if (e.target.matches?.('details[data-lg-pron]')) LG.verPron = e.target.open; }, true);

// "Escuchar" se detiene al final de la sección; el botón cambia a "Detener" mientras suena
function botonesEscuchar() {
  document.querySelectorAll('#largo [data-sec] [data-lga="escuchar"]').forEach(x => {
    const on = LG.escuchando === Number(x.closest('[data-sec]').dataset.sec);
    x.textContent = on ? '⏹ Detener' : '▶ Escuchar';
    x.classList.toggle('!border-fuchsia-500', on); x.classList.toggle('!text-fuchsia-200', on);
  });
}
document.addEventListener('timeupdate', e => {
  if (e.target.id === 'lg-audio' && LG.parar && e.target.currentTime >= LG.parar) { e.target.pause(); }
}, true);
document.addEventListener('pause', e => {
  if (e.target.id === 'lg-audio') { LG.parar = null; LG.escuchando = null; botonesEscuchar(); }
}, true);
document.addEventListener('play', e => {
  if (e.target.id === 'lg-audio' && !LG.parar) { LG.escuchando = null; botonesEscuchar(); } // play desde el reproductor de arriba
}, true);

cargarFuentes();
cargarProyectos().then(async () => { if (LG.id) await abrirProyecto(LG.id); else if (S.tab === 'largo') render(true); });

// ───────────── 👁 Vista previa en vivo: voz + clips + títulos + música, sin exportar ─────────────
// Imita lo que hace el render: clips llenando su panel, sonido de clips y música que se agachan cuando hablas.
const PV = {};
function abrirVista(secId) {
  cerrarVista();
  const p = LG.p, al = p.alineacion;
  const secs = al.secciones.map(t => ({ t, s: p.secciones.find(x => x.id === t.id) })).filter(x => x.s);
  const ini = secId != null ? secs.find(x => x.s.id === secId)?.t.t0 ?? 0 : 0;
  const A = p.audio || {};
  Object.assign(PV, { p, secs, idx: -1, paneles: [], ctx: null, an: null, buf: null, gM: 1, gC: 1, raf: 0,
    volM: A.volMusica ?? 0.12, volC: A.clips ?? 0.35, total: al.duracion || secs[secs.length - 1].t.t1 });
  const r = document.createElement('div');
  r.id = 'pv';
  r.className = 'fixed inset-0 z-[60] flex items-center justify-center overflow-auto bg-zinc-950 p-3';
  r.innerHTML = `
    <div class="w-full max-w-6xl">
      <div class="mb-2 flex items-center gap-2 text-white">
        <b id="pv-sec" class="min-w-0 flex-1 truncate"></b>
        <span class="hidden text-[11px] text-zinc-400 sm:inline">Espacio = play/pausa · Esc = cerrar</span>
        <button id="pv-cerrar" class="px-2 text-2xl text-zinc-300">✕</button>
      </div>
      <div id="pv-stage" class="relative w-full overflow-hidden rounded-lg" style="aspect-ratio:16/9;background:#0d0d12"></div>
      <div class="mt-3 flex flex-wrap items-center gap-3 text-white">
        <button id="pv-play" class="rounded-lg bg-fuchsia-600 px-4 py-2 font-bold">▶</button>
        <span id="pv-t" class="font-mono text-xs text-zinc-300">0:00</span>
        <input id="pv-seek" type="range" min="0" max="${PV.total.toFixed(1)}" step="0.1" value="${ini}" class="min-w-[140px] flex-1 accent-fuchsia-500" />
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-300">
        <label class="flex items-center gap-2">🎵 Música <input id="pv-volm" type="range" min="2" max="40" value="${Math.round(PV.volM * 100)}" ${A.musica ? '' : 'disabled'} class="w-32 accent-fuchsia-500" /><b id="pv-volm-l">${A.musica ? Math.round(PV.volM * 100) + '%' : 'sin música'}</b></label>
        <label class="flex items-center gap-2">🎮 Clips con 🔊 <input id="pv-volc" type="range" min="5" max="80" step="5" value="${Math.round(PV.volC * 100)}" class="w-32 accent-fuchsia-500" /><b id="pv-volc-l">${Math.round(PV.volC * 100)}%</b></label>
        <span class="text-zinc-500">Los cambios de volumen se guardan solos. El recorte de bordes negros solo se ve al exportar.</span>
      </div>
    </div>`;
  document.body.appendChild(r);
  PV.voz = new Audio(`/api/proyectos/${enc(p.id)}/voz`);
  PV.voz.preload = 'auto';
  PV.voz.currentTime = ini;
  PV.mus = A.musica ? new Audio(`/api/proyectos/${enc(p.id)}/musica?v=${enc(A.musica + (A.musicaNombre || ''))}`) : null;
  if (PV.mus) { PV.mus.loop = true; PV.mus.preload = 'auto'; }
  $('#pv-cerrar').onclick = cerrarVista;
  $('#pv-play').onclick = () => (PV.voz.paused ? playVista() : pausaVista());
  $('#pv-seek').oninput = e => { PV.voz.currentTime = Number(e.target.value); pvTick(true); };
  $('#pv-volm').oninput = e => { PV.volM = Number(e.target.value) / 100; $('#pv-volm-l').textContent = e.target.value + '%'; guardarAudio({ volMusica: PV.volM }); };
  $('#pv-volc').oninput = e => { PV.volC = Number(e.target.value) / 100; $('#pv-volc-l').textContent = e.target.value + '%'; guardarAudio({ clips: PV.volC }); };
  PV.voz.onended = pausaVista;
  PV.tecla = e => {
    if (e.key === 'Escape') cerrarVista();
    if (e.key === ' ' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '') ) { e.preventDefault(); PV.voz.paused ? playVista() : pausaVista(); }
  };
  document.addEventListener('keydown', PV.tecla);
  pvTick(true);
}
function cerrarVista() {
  if (!PV.voz) return;
  cancelAnimationFrame(PV.raf);
  PV.voz.pause(); PV.mus?.pause();
  document.querySelectorAll('#pv video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
  PV.ctx?.close().catch(() => {});
  document.removeEventListener('keydown', PV.tecla);
  $('#pv')?.remove();
  PV.voz = null;
  if (LG.p) render(true); // refleja los volúmenes que cambiaste
}
function playVista() {
  if (!PV.ctx) {
    try {
      PV.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = PV.ctx.createMediaElementSource(PV.voz);
      PV.an = PV.ctx.createAnalyser(); PV.an.fftSize = 1024; PV.buf = new Float32Array(PV.an.fftSize);
      src.connect(PV.an); PV.an.connect(PV.ctx.destination);
    } catch { PV.an = null; }
  }
  PV.ctx?.resume?.();
  PV.voz.play().catch(() => toast('No se pudo reproducir la voz', 'error'));
  $('#pv-play').textContent = '⏸';
  cancelAnimationFrame(PV.raf);
  const loop = () => { pvTick(false); PV.raf = requestAnimationFrame(loop); };
  loop();
}
function pausaVista() {
  if (!PV.voz) return;
  PV.voz.pause(); PV.mus?.pause();
  PV.paneles.forEach(pn => pn.vids.forEach(v => v.pause()));
  const b = $('#pv-play'); if (b) b.textContent = '▶';
  cancelAnimationFrame(PV.raf);
}
function montarSeccionVista(i) {
  PV.idx = i;
  const { s, t } = PV.secs[i], stage = $('#pv-stage');
  stage.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
  stage.innerHTML = '';
  $('#pv-sec').textContent = `${i + 1}/${PV.secs.length} · ${s.titulo || 'Sección'}`;
  const L = LAY.h, pans = L[s.plantilla] || L.clip;
  PV.paneles = pans.map((pan, j) => {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;overflow:hidden;background:#000;left:${pan.x / L.W * 100}%;top:${pan.y / L.H * 100}%;width:${pan.w / L.W * 100}%;height:${pan.h / L.H * 100}%`;
    const clips = (s.tomas[j]?.clips || []).filter(c => c.archivo);
    const vids = clips.map((c, k) => {
      const v = document.createElement('video');
      v.src = `/media/gtavi/raw/${enc(c.archivo)}#t=${Number(c.a) || 0}`;
      v.preload = 'auto'; v.playsInline = true; v.muted = !c.sonido;
      v.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;${k ? 'visibility:hidden' : ''}`;
      box.appendChild(v);
      return v;
    });
    if (!clips.length) box.innerHTML = '<div style="display:grid;place-items:center;height:100%;color:#f59e0b;font:600 14px sans-serif">Sin clips</div>';
    stage.appendChild(box);
    return { clips, vids, activo: 0 };
  });
  const cv = document.createElement('canvas');
  dibujarCapaLargo(cv, s, 'h');
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  stage.appendChild(cv);
  PV.t0 = t.t0; PV.t1 = t.t1;
}
function pvTick(forzar) {
  if (!PV.voz) return;
  const T = PV.voz.currentTime, jugando = !PV.voz.paused;
  let i = PV.secs.findIndex(x => T >= x.t.t0 && T < x.t.t1);
  if (i < 0) i = T < PV.secs[0].t.t0 ? 0 : PV.secs.length - 1;
  if (i !== PV.idx) montarSeccionVista(i);
  const local = Math.max(0, T - PV.t0);
  // nivel de la voz → cuánto se agachan clips y música (como sidechaincompress del render)
  let rms = 0;
  if (PV.an && jugando) { PV.an.getFloatTimeDomainData(PV.buf); let q = 0; for (const x of PV.buf) q += x * x; rms = Math.sqrt(q / PV.buf.length); }
  const red = (thr, ratio) => (rms > thr ? Math.pow(thr / rms, 1 - 1 / ratio) : 1);
  const suave = (cur, obj) => cur + (obj - cur) * (obj < cur ? 0.5 : 0.04);
  PV.gM = suave(PV.gM, red(0.03, 6)); PV.gC = suave(PV.gC, red(0.02, 12));
  for (const pn of PV.paneles) {
    if (!pn.clips.length) continue;
    let acc = 0, k = 0, off = 0, fin = false;
    for (; k < pn.clips.length; k++) {
      const c = pn.clips[k], v = pn.vids[k];
      const len = c.b ? c.b - c.a : Math.max(0.2, (v.duration || 999) - c.a);
      if (local < acc + len) { off = local - acc; break; }
      acc += len;
    }
    if (k >= pn.clips.length) { k = pn.clips.length - 1; const c = pn.clips[k]; off = c.b ? c.b - c.a : Math.max(0, (pn.vids[k].duration || 0) - c.a); fin = true; }
    const c = pn.clips[k], v = pn.vids[k], quiero = (Number(c.a) || 0) + off;
    if (pn.activo !== k) { pn.vids[pn.activo].pause(); pn.vids[pn.activo].style.visibility = 'hidden'; v.style.visibility = 'visible'; pn.activo = k; }
    if (forzar || Math.abs(v.currentTime - quiero) > 0.35) { try { v.currentTime = quiero; } catch { /* aún cargando */ } }
    if (jugando && !fin && v.paused) v.play().catch(() => {});
    if ((!jugando || fin) && !v.paused) v.pause();          // sin material: se congela el último cuadro
    if (c.sonido) { v.muted = false; v.volume = Math.min(1, PV.volC * PV.gC); }
  }
  // música: corre continua desde el inicio del video, con entrada y salida suaves
  if (PV.mus) {
    const d = PV.mus.duration || 0, quiero = d ? T % d : T;
    if (jugando) {
      if (PV.mus.paused) { try { PV.mus.currentTime = quiero; } catch { /* nada */ } PV.mus.play().catch(() => {}); }
      else if (Math.abs(PV.mus.currentTime - quiero) > 0.4) PV.mus.currentTime = quiero;
    } else if (!PV.mus.paused) PV.mus.pause();
    const fade = Math.min(1, T / 1.5, Math.max(0, (PV.total - T) / 4));
    PV.mus.volume = Math.max(0, Math.min(1, PV.volM * PV.gM * fade));
  }
  const tt = $('#pv-t'); if (tt) tt.textContent = `${fmtT(T).replace(/\.\d$/, '')} / ${fmtT(PV.total).replace(/\.\d$/, '')}`;
  const sk = $('#pv-seek'); if (sk && document.activeElement !== sk) sk.value = T;
}

// ───────────── 🖼 Miniatura de YouTube (1280×720): dos cuadros, GTA V vs GTA VI, texto grande ─────────────
const MN = {};
function clipsDelProyecto(lado) {
  // lado 0 = toma GTA V (izquierda), 1 = GTA VI (derecha); en secciones de un solo clip, cuentan para GTA VI
  const out = [], vistos = new Set();
  LG.p.secciones.forEach((s, i) => s.tomas.forEach((t, j) => (t.clips || []).forEach(c => {
    const esLado = s.plantilla === 'comparacion' ? j === lado : lado === 1;
    if (!esLado || vistos.has(c.archivo)) return;
    vistos.add(c.archivo);
    out.push({ archivo: c.archivo, a: Number(c.a) || 0, b: Number(c.b) || 0, sec: String(s.titulo || `Sección ${i + 1}`).slice(0, 40) });
  })));
  return out;
}
function abrirMiniatura() {
  $('#mn')?.remove();
  const p = LG.p;
  const ladoInfo = [0, 1].map(l => ({ lista: clipsDelProyecto(l), cuadro: null }));
  Object.assign(MN, {
    lados: ladoInfo,
    texto: (p.miniatura || '13 AÑOS DE DIFERENCIA').toUpperCase(),
    // etiquetas: las de la primera sección de comparación (ej. "GTA V" / "GTA VI")
    etiquetas: (p.secciones.find(x => x.plantilla === 'comparacion')?.tomas.map(t => t.etiqueta) || ['Antes', 'Después']).slice(0, 2),
    vs: true, realce: true,
  });
  const r = document.createElement('div');
  r.id = 'mn';
  r.className = 'fixed inset-0 z-[60] overflow-auto bg-zinc-950 p-3 text-white';
  const panelLado = l => `
    <div class="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div class="flex items-center gap-2"><b class="rounded bg-amber-400 px-2 text-sm text-zinc-950">${l ? 'Derecha' : 'Izquierda'}</b>
        <input data-mn="etq${l}" value="${esc(MN.etiquetas[l])}" class="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs" />
        <select data-mn="clip${l}" class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 p-1.5 text-xs">
          ${MN.lados[l].lista.map((c, k) => `<option value="${k}">${esc(c.sec)} · ${esc(nombreCorto(c.archivo)).slice(0, 40)}</option>`).join('') || '<option>Sin clips</option>'}
        </select></div>
      <video id="mn-v${l}" muted playsinline preload="auto" class="mt-2 aspect-video w-full rounded bg-black object-cover"></video>
      <input type="range" id="mn-s${l}" min="0" max="1" step="0.04" value="0" class="mt-2 w-full accent-fuchsia-500" />
      <p class="text-[11px] text-zinc-500">Mueve la barra hasta el cuadro que más impacte; se actualiza solo.</p>
    </div>`;
  r.innerHTML = `
    <div class="mx-auto max-w-6xl">
      <div class="mb-3 flex items-center gap-2"><b class="flex-1 text-lg">🖼 Miniatura · ${esc(p.titulo)}</b><button id="mn-cerrar" class="px-2 text-2xl text-zinc-300">✕</button></div>
      <canvas id="mn-cv" width="1280" height="720" class="w-full rounded-lg border border-zinc-800 bg-black"></canvas>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <input data-mn="texto" value="${esc(MN.texto)}" maxlength="40" placeholder="Texto grande (3-4 palabras)" class="min-w-[220px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-[16px] font-bold md:text-sm" />
        <label class="flex items-center gap-1.5 text-xs"><input type="checkbox" data-mn="vs" checked class="h-4 w-4 accent-fuchsia-500" />VS</label>
        <label class="flex items-center gap-1.5 text-xs"><input type="checkbox" data-mn="realce" checked class="h-4 w-4 accent-fuchsia-500" />Más color y contraste</label>
        <button id="mn-guardar" class="rounded-lg bg-fuchsia-600 px-5 py-2.5 text-sm font-bold">⬇ Guardar miniatura</button>
      </div>
      <div class="mt-3 grid gap-3 md:grid-cols-2">${panelLado(0)}${panelLado(1)}</div>
    </div>`;
  document.body.appendChild(r);
  [0, 1].forEach(l => {
    const v = $(`#mn-v${l}`), sl = $(`#mn-s${l}`), sel = $(`[data-mn="clip${l}"]`);
    const cargar = () => {
      const c = MN.lados[l].lista[Number(sel.value)]; if (!c) return;
      v.src = `/media/gtavi/raw/${enc(c.archivo)}`;
      v.onloadedmetadata = () => {
        const fin = c.b || v.duration;
        sl.min = c.a; sl.max = Math.max(c.a + 0.1, fin).toFixed(2); sl.value = ((c.a + fin) / 2).toFixed(2);
        v.currentTime = Number(sl.value);
      };
    };
    v.onseeked = () => { MN.lados[l].cuadro = v; dibujarMiniatura(); };
    sl.oninput = () => { v.currentTime = Number(sl.value); };
    sel.onchange = cargar;
    cargar();
  });
  r.addEventListener('input', e => {
    const k = e.target.dataset.mn; if (!k) return;
    if (k === 'texto') MN.texto = e.target.value.toUpperCase();
    if (k === 'etq0' || k === 'etq1') MN.etiquetas[Number(k.slice(3))] = e.target.value;
    if (k === 'vs' || k === 'realce') MN[k] = e.target.checked;
    dibujarMiniatura();
  });
  r.addEventListener('change', e => { if (e.target.dataset.mn === 'vs' || e.target.dataset.mn === 'realce') { MN[e.target.dataset.mn] = e.target.checked; dibujarMiniatura(); } });
  $('#mn-cerrar').onclick = () => { r.querySelectorAll('video').forEach(v => { v.removeAttribute('src'); v.load(); }); r.remove(); };
  $('#mn-guardar').onclick = guardarMiniatura;
  dibujarMiniatura();
}
function dibujarMiniatura() {
  const cv = $('#mn-cv'); if (!cv) return;
  const ctx = cv.getContext('2d'), W = 1280, H = 720, corte = 26; // inclinación de la división
  ctx.fillStyle = '#0d0d12'; ctx.fillRect(0, 0, W, H);
  const cubrir = (v, x0, x1) => {
    const vw = v.videoWidth, vh = v.videoHeight; if (!vw) return;
    const w = x1 - x0, esc2 = Math.max(w / vw, H / vh), dw = vw * esc2, dh = vh * esc2;
    ctx.drawImage(v, x0 + (w - dw) / 2, (H - dh) / 2, dw, dh);
  };
  ctx.filter = MN.realce ? 'contrast(1.12) saturate(1.3) brightness(1.03)' : 'none';
  // izquierda
  ctx.save(); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W / 2 + corte, 0); ctx.lineTo(W / 2 - corte, H); ctx.lineTo(0, H); ctx.closePath(); ctx.clip();
  if (MN.lados[0].cuadro) cubrir(MN.lados[0].cuadro, 0, W / 2 + corte); ctx.restore();
  // derecha
  ctx.save(); ctx.beginPath(); ctx.moveTo(W / 2 + corte, 0); ctx.lineTo(W, 0); ctx.lineTo(W, H); ctx.lineTo(W / 2 - corte, H); ctx.closePath(); ctx.clip();
  if (MN.lados[1].cuadro) cubrir(MN.lados[1].cuadro, W / 2 - corte, W); ctx.restore();
  ctx.filter = 'none';
  // degradado oscuro arriba para que el texto se lea
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.45); g.addColorStop(0, 'rgba(0,0,0,.65)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 0.45);
  // línea divisoria
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(W / 2 + corte, 0); ctx.lineTo(W / 2 - corte, H); ctx.stroke();
  // VS
  if (MN.vs) {
    ctx.fillStyle = '#e11d48'; ctx.beginPath(); ctx.arc(W / 2, H * 0.6, 62, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 8; ctx.strokeStyle = '#fff'; ctx.stroke();
    textoCanvas(ctx, 'VS', { size: 64, y: H * 0.6 - 34, borde: 0, sombra: 0 });
  }
  // texto grande (1-2 renglones, se ajusta al ancho)
  const t = String(MN.texto || '').trim();
  if (t) {
    let lineas = [t], size = 112;
    const ancho = s2 => Math.max(...lineas.map(x => anchoTexto(ctx, x, s2)));
    if (anchoTexto(ctx, t, size) > W - 80) { const pal = t.split(/\s+/), m = Math.ceil(pal.length / 2); lineas = [pal.slice(0, m).join(' '), pal.slice(m).join(' ')].filter(Boolean); }
    while (ancho(size) > W - 80 && size > 48) size -= 4;
    lineas.forEach((ln, i) => textoCanvas(ctx, ln, { size, y: 34 + i * size * 1.08, color: i === lineas.length - 1 ? '#FFD400' : '#fff', borde: 10, sombra: 6 }));
  }
  // etiquetas abajo
  const etq = (txt, x, alinear) => {
    if (!txt) return; const size = 58, w = anchoTexto(ctx, txt, size);
    textoCanvas(ctx, txt, { size, x: alinear === 'der' ? x - w : x, y: H - size - 44, color: '#09090b', borde: 0, sombra: 0, caja: { color: '#FFD400', pad: 14 } });
  };
  etq(MN.etiquetas[0], 40, 'izq'); etq(MN.etiquetas[1], W - 40, 'der');
}
async function guardarMiniatura() {
  const cv = $('#mn-cv');
  if (!MN.lados[0].cuadro || !MN.lados[1].cuadro) return toast('Elige un cuadro para cada lado', 'info');
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `Miniatura_${(LG.p.titulo || 'video').replace(/[^\w]+/g, '_').slice(0, 40)}.png`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  try {
    const r = await fetch(`/api/proyectos/${enc(LG.p.id)}/miniatura`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'No se pudo guardar en Listos');
    toast(`Miniatura guardada en Gaming/Listos (${j.archivo})`);
  } catch (err) { toast(err.message, 'error'); }
}
