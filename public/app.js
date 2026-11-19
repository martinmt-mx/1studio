/* 1Studio · Tablero — frontend (sin frameworks) */
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');

const S = {
  tab: localStorage.getItem('tab') || 'gtavi',
  estado: null,
  metricas: [],
  drafts: {},          // key → { pegar, titulo, descripcion, completo }
  editorAbierto: {},   // key → bool
  form: { video: '', hook: '', creador: localStorage.getItem('ultimoCreador') || '' },
  pendiente: false,
  dl: { url: '', creador: '', rango: '' },
  lote: {
    json: localStorage.getItem('loteJSON') || '',
    modo: localStorage.getItem('loteModo') || 'individual',
    orient: localStorage.getItem('loteOrient') || 'vertical',
    fondo: localStorage.getItem('loteFondo') || 'difuminado',   // 'difuminado' | 'negro' | '#rrggbb'
    estilo: localStorage.getItem('loteEstilo') || 'insignias',  // recopilación: 'insignias' (#N…#1) | 'lista' (se descubre)
    titulo: localStorage.getItem('loteTitulo') || '',           // título fijo de arriba (estilo lista)
    extra: localStorage.getItem('loteExtra') !== 'no',          // renglón "????" extra que nunca sale
  },
  subtab: localStorage.getItem('subtab') || 'lote',
  modelo: localStorage.getItem('modeloWhisper') || 'auto',
  prompt: '',
  promptFecha: null,
  abiertos: {},        // <details data-abierto="…"> abiertos
  loteVal: null,       // respuesta de /api/lote/validar
  loteValClave: null,  // JSON + Raw con que se validó
  ajustes: (() => { try { return JSON.parse(localStorage.getItem('loteAjustes')) || {}; } catch { return {}; } })(),
  creditoModo: localStorage.getItem('creditoModo') || 'arroba',
  rawSel: [],          // clips de Raw marcados (en el orden en que los marcaste)
};

// ───────────── utilidades ─────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const tam = b => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
const fecha = t => new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t));
const key = (canal, name) => `${canal}/${name}`;

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg, tipo = 'ok') {
  const color = tipo === 'error' ? 'bg-red-600' : tipo === 'info' ? 'bg-zinc-700' : 'bg-green-600';
  const el = document.createElement('div');
  el.className = `${color} pointer-events-auto rounded-xl px-4 py-3 text-sm font-semibold shadow-2xl transition-opacity duration-300 max-w-md whitespace-pre-line`;
  el.textContent = msg;
  $('#toast').replaceChildren(el);
  setTimeout(() => (el.style.opacity = '0'), tipo === 'error' ? 5000 : 1800);
  setTimeout(() => el.remove(), tipo === 'error' ? 5400 : 2200);
}

// Copiar que funciona también por http://IP (sin HTTPS) en iPhone y Android
async function copiar(texto) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(texto); return true; }
  } catch { /* usa el respaldo */ }
  const ta = document.createElement('textarea');
  ta.value = texto;
  ta.setAttribute('readonly', '');
  Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', opacity: '0', fontSize: '16px' });
  document.body.appendChild(ta);
  ta.focus(); ta.select(); ta.setSelectionRange(0, texto.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// Misma regla que el servidor: corta en el primer "?" (+ emojis pegados) o en el primer salto de línea
const COLA = /^(?:[ \t]*(?:[?!¡]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣))*/u;
function partir(texto) {
  const t = String(texto || '').replace(/\r\n?/g, '\n').trim();
  const q = t.indexOf('?'), nl = t.indexOf('\n');
  let c = -1;
  if (q !== -1 && (nl === -1 || q < nl)) { c = q + 1; c += t.slice(c).match(COLA)[0].length; }
  else if (nl !== -1) c = nl;
  if (c === -1) return { completo: t, titulo: t, descripcion: '' };
  return { completo: t, titulo: t.slice(0, c).trim(), descripcion: t.slice(c).trim() };
}

function buscarVideo(k) {
  const [canal, ...rest] = k.split('/');
  const name = rest.join('/');
  return (S.estado?.canales?.[canal]?.listos || []).find(v => v.name === name);
}

// ───────────── componentes ─────────────
const btnBase = 'rounded-xl border border-zinc-700 bg-zinc-800/80 font-semibold transition active:scale-[.97] disabled:opacity-30 disabled:active:scale-100';

function tarjetaVideo(canal, v) {
  const k = key(canal, v.name);
  const d = S.drafts[k] || {};
  const m = v.meta;
  const val = f => (d[f] !== undefined ? d[f] : m[f]);
  const lista = m.titulo || m.completo;
  const abierto = S.editorAbierto[k] ?? window.innerWidth >= 768;
  const prev = d.pegar ? partir(d.pegar) : null;

  return `
  <article class="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4" data-key="${esc(k)}">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="truncate font-semibold" title="${esc(v.name)}">${esc(v.name)}</h3>
        <p class="mt-0.5 text-xs text-zinc-500">${tam(v.size)} · ${fecha(v.mtime)}</p>
      </div>
      <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${lista ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'}">
        ${lista ? 'Con texto' : 'Sin texto'}</span>
    </div>
    ${m.titulo ? `<p class="mt-2 line-clamp-2 text-sm text-zinc-300">${esc(m.titulo)}</p>` : ''}

    <a href="/api/descargar/${enc(canal)}/${enc(v.name)}" download="${esc(v.name)}"
       class="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-white py-4 text-base font-bold text-zinc-950 transition active:scale-[.98]">
      ⬇ Descargar MP4</a>

    <div class="mt-2 grid grid-cols-3 gap-2">
      ${[['completo', 'Completo'], ['titulo', 'Solo título'], ['descripcion', 'Solo descr.']].map(([f, l]) => `
        <button data-action="copiar" data-field="${f}" ${m[f] ? '' : 'disabled'}
          class="${btnBase} flex min-h-[64px] flex-col items-center justify-center px-1 text-sm leading-tight">
          <span class="text-[11px] font-medium text-zinc-400 lbl-top">Copiar</span><span class="lbl">${l}</span></button>`).join('')}
    </div>

    <details class="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/50" data-editor ${abierto ? 'open' : ''}>
      <summary class="cursor-pointer select-none px-3 py-2.5 text-sm font-semibold text-zinc-300">✎ Descripción</summary>
      <div class="space-y-2 px-3 pb-3">
        <label class="block text-xs text-zinc-400">Pega aquí la descripción completa (se parte en el primer <b>?</b> o salto de línea)</label>
        <textarea data-field="pegar" rows="4" placeholder="¿Gancho del título? 😱🔥&#10;Resto de la descripción, hashtags…"
          class="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-[16px] md:text-sm outline-none focus:border-zinc-400">${esc(d.pegar || '')}</textarea>
        <div data-preview class="${prev ? '' : 'hidden'} rounded-lg bg-zinc-900 p-2 text-xs text-zinc-400">
          ${prev ? `<b class="text-zinc-200">Título:</b> ${esc(prev.titulo)}<br><b class="text-zinc-200">Descripción:</b> ${esc(prev.descripcion.slice(0, 160))}${prev.descripcion.length > 160 ? '…' : ''}` : ''}
        </div>
        <button data-action="partir" class="w-full rounded-lg bg-fuchsia-600 py-2.5 text-sm font-bold active:scale-[.98]">✂ Partir y guardar</button>

        <div class="grid gap-2 border-t border-zinc-800 pt-3">
          <label class="text-xs text-zinc-400">Título</label>
          <input data-field="titulo" value="${esc(val('titulo'))}"
            class="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-[16px] md:text-sm outline-none focus:border-zinc-400" />
          <label class="text-xs text-zinc-400">Descripción</label>
          <textarea data-field="descripcion" rows="3"
            class="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-[16px] md:text-sm outline-none focus:border-zinc-400">${esc(val('descripcion'))}</textarea>
          <label class="text-xs text-zinc-400">Completo</label>
          <textarea data-field="completo" rows="3"
            class="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-[16px] md:text-sm outline-none focus:border-zinc-400">${esc(val('completo'))}</textarea>
          <button data-action="guardar" class="rounded-lg border border-zinc-600 py-2.5 text-sm font-bold active:scale-[.98]">Guardar cambios</button>
        </div>
      </div>
    </details>

    <div class="mt-3 flex gap-2">
      <a href="/media/${enc(canal)}/listos/${enc(v.name)}" target="_blank" class="${btnBase} px-4 py-2.5 text-sm">▶ Ver</a>
      <button data-action="publicar" class="flex-1 rounded-xl border border-red-500/40 bg-red-500/10 py-2.5 text-sm font-bold text-red-300 active:scale-[.98]">
        ✓ Marcar como publicado</button>
    </div>
  </article>`;
}

function seccion(titulo, n, contenido, extra = '') {
  return `<section class="mt-6">
    <div class="mb-3 flex items-baseline justify-between"><h2 class="text-sm font-bold uppercase tracking-wider text-zinc-400">${titulo}
      <span class="ml-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">${n}</span></h2>${extra}</div>
    ${contenido}</section>`;
}
const vacio = msg => `<p class="rounded-2xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">${msg}</p>`;
const gridVideos = (canal, vids) => vids.length
  ? `<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">${vids.map(v => tarjetaVideo(canal, v)).join('')}</div>`
  : vacio('No hay videos en <b>listos</b>.');

// ───────────── GTA VI: descargador · analizador · procesador ─────────────
const inputCls = 'w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-[16px] md:text-sm outline-none focus:border-zinc-400';
const aviso = (msg, tono = 'amber') => `<p class="mt-2 rounded-lg bg-${tono}-500/10 px-3 py-2 text-xs text-${tono}-300">${msg}</p>`;
const segmentado = (accion, actual, opciones) => `
  <div class="grid grid-cols-${opciones.length} gap-1 rounded-xl bg-zinc-950/70 p-1 text-xs font-semibold">
    ${opciones.map(([v, l]) => `<button data-action="${accion}" data-valor="${v}" class="rounded-lg px-2 py-2 transition ${v === actual ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400'}">${l}</button>`).join('')}
  </div>`;

function filaJob(j) {
  const color = j.estado === 'error' ? 'text-red-400' : j.estado === 'listo' ? 'text-green-400' : 'text-zinc-200';
  const etiqueta = { 'en cola': 'En cola', procesando: `${j.progreso}%`, listo: '✓ Listo', error: '✕ Error' }[j.estado] || j.estado;
  const titulo = j.tipo === 'procesar' ? `${j.video} → ${j.salida}` : j.titulo;
  const barra = j.estado === 'error' ? 'bg-red-500' : j.tipo === 'descarga' ? 'bg-sky-500' : 'bg-fuchsia-500';
  const items = j.items?.length ? `<ul class="mt-2 space-y-1">${j.items.map(it => `
      <li><div class="flex justify-between gap-2">
        <span class="truncate text-zinc-400">${j.tipo === 'top' ? `<b class="text-amber-300">#${it.ranking}</b> ` : ''}${esc(it.archivo)}</span>
        <span class="shrink-0 ${it.estado === 'error' ? 'text-red-400' : it.estado === 'listo' ? 'text-green-400' : 'text-zinc-300'}">
          ${it.estado === 'procesando' ? it.progreso + '%' : it.estado === 'listo' ? '✓' : it.estado === 'error' ? '✕' : '·'}</span></div>
        ${it.error ? `<pre class="whitespace-pre-wrap text-red-300">${esc(it.error)}</pre>` : ''}</li>`).join('')}</ul>` : '';
  return `
    <div class="mt-3 rounded-lg bg-zinc-950/60 p-3 text-xs">
      <div class="flex justify-between gap-2"><span class="truncate">${esc(titulo)}</span><b class="shrink-0 ${color}">${etiqueta}</b></div>
      ${j.mensaje ? `<p class="mt-1 truncate text-zinc-500">${esc(j.mensaje)}</p>` : ''}
      <div class="mt-2 h-1.5 overflow-hidden rounded bg-zinc-800"><div class="h-full ${barra} transition-all" style="width:${j.estado === 'error' ? 100 : j.progreso}%"></div></div>
      ${items}
      ${j.omitidos?.length ? `<p class="mt-2 text-amber-400">Omitidos (no están en Raw): ${esc(j.omitidos.join(', '))}</p>` : ''}
      ${j.error ? `<pre class="mt-2 whitespace-pre-wrap text-red-300">${esc(j.error)}</pre>` : ''}
    </div>`;
}

function bloqueDescargar(h, jobs) {
  const ok = h.ytdlp.ok;
  return `
  <section class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
    <div class="flex items-center justify-between gap-2"><h2 class="font-bold">⬇ Descargar clip</h2>
      <span class="text-xs ${ok ? 'text-zinc-500' : 'text-amber-400'}">${ok ? 'yt-dlp ' + esc(h.ytdlp.version) : 'yt-dlp no encontrado'}</span></div>
    ${ok ? '' : aviso('yt-dlp no está disponible: cierra y vuelve a abrir <b>INICIAR.bat</b> para descargarlo. El resto del tablero sigue funcionando.')}
    <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
      <input data-dl="url" type="url" inputmode="url" autocapitalize="off" value="${esc(S.dl.url)}" placeholder="URL de Twitch, Kick o YouTube" class="${inputCls} col-span-2 sm:col-span-3" />
      <input data-dl="creador" autocapitalize="off" value="${esc(S.dl.creador)}" placeholder="@creador (auto)" class="${inputCls}" />
      <input data-dl="rango" data-rango inputmode="numeric" value="${esc(S.dl.rango)}" placeholder="01:12:30-01:13:05 (opcional)" class="${inputCls}" />
      <button data-action="descargar-clip" ${ok ? '' : 'disabled'} class="col-span-2 sm:col-span-1 rounded-lg bg-sky-600 px-5 py-3 font-bold transition active:scale-[.98] disabled:opacity-40">Descargar</button>
    </div>
    <p class="mt-1.5 text-[11px] text-zinc-500">Se guarda en <b>Gaming/Raw</b> como <code>creador__fecha-hora.mp4</code>. El rango sirve para cortar un tramo de un VOD largo.</p>
    ${jobs.map(filaJob).join('')}
  </section>`;
}

function bloqueAnalizar(h, an) {
  const py = h.python;
  const corriendo = an.estado === 'procesando';
  const raws = S.estado.canales.gtavi.raw.length;
  // El aviso de "falta faster-whisper" ya se muestra arriba
  const avisosAn = (an.avisos || []).filter(a => py.whisper || !/faster-whisper no est/.test(a));
  return `
  <section class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
    <div class="flex items-center justify-between gap-2"><h2 class="font-bold">🧠 Analizar Raw para Claude</h2>
      <span class="shrink-0 text-xs ${py.ok && py.whisper ? 'text-zinc-500' : 'text-amber-400'}">${!py.ok ? 'Python no encontrado' : py.whisper ? 'Whisper listo' : 'sin faster-whisper'}</span></div>
    <p class="mt-1 text-xs text-zinc-400">Mide duración y picos de volumen y transcribe cada clip de <b>Gaming/Raw</b>. Luego copias el prompt, lo pegas en Claude y te devuelve el JSON para el lote.</p>
    ${!py.ok ? aviso('Python no está instalado o no está en el PATH. Instálalo desde python.org (marca "Add to PATH") y vuelve a abrir <b>INICIAR.bat</b>.')
      : !py.whisper ? aviso('faster-whisper no está instalado: el análisis solo medirá duración y picos. <b>INICIAR.bat</b> lo instala automáticamente.') : ''}
    <div class="mt-3 grid grid-cols-[auto_1fr] gap-2">
      <select data-modelo class="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-[16px] md:text-sm">
        ${[['auto', 'Modelo: auto'], ['base', 'base · rápido'], ['small', 'small · preciso']].map(([v, l]) => `<option value="${v}" ${S.modelo === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button data-action="analizar" ${py.ok && raws && !corriendo ? '' : 'disabled'}
        class="rounded-lg bg-emerald-600 px-4 py-3 font-bold transition active:scale-[.98] disabled:opacity-40">${corriendo ? 'Analizando…' : `Analizar Raw para Claude${raws ? ` (${raws})` : ''}`}</button>
    </div>
    ${corriendo ? `
      <div class="mt-3 rounded-lg bg-zinc-950/60 p-3 text-xs">
        <div class="flex justify-between gap-2"><span class="truncate text-zinc-400">${esc(an.mensaje || 'Analizando…')}</span><b>${an.progreso}%</b></div>
        <div class="mt-2 h-1.5 overflow-hidden rounded bg-zinc-800"><div class="h-full bg-emerald-500 transition-all" style="width:${an.progreso}%"></div></div>
      </div>` : ''}
    ${an.estado === 'error' ? `<pre class="mt-3 whitespace-pre-wrap rounded-lg bg-red-500/10 p-3 text-xs text-red-300">${esc(an.error)}</pre>` : ''}
    ${avisosAn.length ? `<ul class="mt-2 space-y-1 text-[11px] text-amber-300">${avisosAn.map(a => `<li>• ${esc(a)}</li>`).join('')}</ul>` : ''}
    ${!corriendo && S.prompt ? `
      <p class="mt-3 text-xs text-zinc-500">${an.n} clip${an.n === 1 ? '' : 's'} · ${an.fecha ? fecha(an.fecha) : ''}${an.modelo ? ` · Whisper ${esc(an.modelo)} (${esc(String(an.dispositivo || '').toUpperCase())})` : ''}</p>
      <button data-action="copiar-prompt" class="mt-2 flex w-full min-h-[56px] items-center justify-center rounded-xl bg-white text-base font-bold text-zinc-950 transition active:scale-[.98]">
        <span class="lbl">📋 Copiar prompt para Claude</span></button>
      <details data-abierto="prompt" class="mt-2 rounded-xl border border-zinc-800 bg-zinc-950/50" ${S.abiertos.prompt ? 'open' : ''}>
        <summary class="cursor-pointer select-none px-3 py-2.5 text-sm font-semibold text-zinc-300">Ver prompt</summary>
        <textarea readonly rows="10" class="block w-full rounded-b-xl bg-zinc-950 p-3 font-mono text-[12px] text-zinc-300 outline-none">${esc(S.prompt)}</textarea>
      </details>` : ''}
  </section>`;
}

// La revisión del JSON la hace el servidor: así se aceptan nombres con emojis cambiados o recortados.
const claveLote = () => S.lote.json + '|' + (S.estado?.canales?.gtavi?.raw || []).map(r => r.name).join('|');
let loteTimer = null;
function validarLote(inmediato = false) {
  clearTimeout(loteTimer);
  const clave = claveLote();
  if (!S.lote.json.trim()) { S.loteVal = null; S.loteValClave = clave; return pintarLote(); }
  S.loteValClave = clave;
  loteTimer = setTimeout(async () => {
    try { S.loteVal = await api('/api/lote/validar', { method: 'POST', body: JSON.stringify({ json: S.lote.json }) }); }
    catch (err) { S.loteVal = { error: err.message }; }
    if (S.loteValClave === clave) pintarLote();
  }, inmediato ? 0 : 350);
}
function pintarLote() {
  const box = $('[data-lote-preview]'), btn = $('[data-action="procesar-lote"]');
  if (box) conservarVideos(box, () => { box.innerHTML = previewLote(); });
  if (btn) { const b = textoBotonLote(); btn.textContent = b.texto; btn.disabled = !b.n || !S.estado?.encoder?.ffmpeg; }
  const edb = $('[data-action="abrir-editor"]'); if (edb) edb.disabled = !textoBotonLote().n;
}

// ───────────── Editor de clips del lote (crédito · sección · incluir · puesto) ─────────────
const fmtT = s => { s = Math.max(0, Number(s) || 0); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
function parseT(v) {
  const t = String(v ?? '').trim().replace(',', '.');
  if (!t) return null;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(t)) return NaN;
  return t.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
}
const guardarAjustes = () => { try { localStorage.setItem('loteAjustes', JSON.stringify(S.ajustes)); } catch { /* sin espacio */ } };
const itemsLote = () => (S.lote.json.trim() && S.loteValClave === claveLote() && S.loteVal?.items) || [];
const itemLote = k => itemsLote().find(i => i.archivo === k);

function creditoPorDefecto(it) {
  if (S.creditoModo === 'ninguno') return '';
  if (S.creditoModo === 'nombre') return it.visible || it.creador || '';
  return it.creador || it.visible || '';
}
/** Valores finales de un clip: lo que ajustaste o, si no, lo que vino del JSON. */
function efectivo(it) {
  const a = S.ajustes[it.archivo] || {};
  return {
    incluir: a.incluir !== false,
    ranking: a.ranking ?? it.ranking,
    gancho: a.gancho ?? it.gancho ?? '',
    credito: a.credito ?? creditoPorDefecto(it),
    ...(Array.isArray(a.secciones) ? { secciones: a.secciones } : {}),
  };
}
function textoSeccion(it) {
  const secs = seccionesDe(it), usado = durSecs(secs);
  if (esCompleto(it)) return `Completo · ${fmtT(it.duracion)}`;
  return `<span class="text-fuchsia-300">✂ ${secs.length === 1 ? `${fmtT(secs[0].a)} → ${fmtT(secs[0].b)}` : `${secs.length} secciones`}</span> · ${fmtT(usado)}`;
}
function textoTotal() {
  const inc = itemsLote().filter(i => i.existe && efectivo(i).incluir);
  const seg = inc.reduce((t, i) => t + durSecs(seccionesDe(i)), 0);
  return `${inc.length} clip${inc.length === 1 ? '' : 's'} · ${S.lote.modo === 'top' ? `duración total ≈ ${fmtT(seg)}` : `${fmtT(seg)} en total`}`;
}

function filaClip(it) {
  if (!it.existe) {
    return `<li class="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-xs opacity-60">
      <span class="text-red-400">✕ no está en Raw</span> · <span class="text-zinc-400">${esc(it.gancho || '')}</span>
      <span class="block truncate text-zinc-600">${esc(it.original || it.archivo)}</span></li>`;
  }
  const k = it.archivo, e = efectivo(it);
  const chips = [...new Set([it.creador, it.visible].filter(Boolean))];
  const campo = 'rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-[16px] md:text-sm outline-none focus:border-zinc-500';
  return `
  <li data-clip="${esc(k)}" class="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 ${e.incluir ? '' : 'opacity-50'}">
    <div class="flex items-center gap-2">
      <input type="checkbox" data-aj="incluir" ${e.incluir ? 'checked' : ''} title="Incluir este clip" class="h-5 w-5 shrink-0 accent-fuchsia-500" />
      <label class="flex shrink-0 items-center font-bold text-amber-300" title="Puesto">#<input data-aj="ranking" inputmode="numeric" value="${esc(e.ranking)}"
        class="w-8 bg-transparent font-bold text-amber-300 outline-none" /></label>
      <input data-aj="gancho" value="${esc(e.gancho)}" placeholder="Gancho (texto de arriba)" class="${campo} min-w-0 flex-1" />
    </div>
    <p class="mt-1 truncate pl-7 text-[11px] text-zinc-600" title="${esc(it.archivo)}">${it.original !== it.archivo ? '<span class="text-green-500">✓ encontrado</span> · ' : ''}${esc(it.archivo)}</p>
    <div class="mt-2 flex flex-wrap items-center gap-1.5 pl-7">
      <span class="w-14 text-[11px] text-zinc-500">Crédito</span>
      <input data-aj="credito" value="${esc(e.credito)}" placeholder="sin crédito" autocapitalize="off" class="${campo} min-w-[9rem] flex-1 py-1.5" />
      ${chips.map(v => `<button data-action="credito-chip" data-valor="${esc(v)}" class="rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 active:scale-95">${esc(v)}</button>`).join('')}
      <button data-action="credito-chip" data-valor="" title="Sin crédito" class="rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-500 active:scale-95">✕</button>
    </div>
    <div class="mt-2 flex items-center gap-2 pl-7">
      <span class="w-14 text-[11px] text-zinc-500">Sección</span>
      <span data-resumen class="min-w-0 flex-1 truncate text-xs text-zinc-400">${textoSeccion(it)}</span>
    </div>
  </li>`;
}

function previewLote() {
  if (S.lote.json.trim() && S.loteValClave !== claveLote()) validarLote(true);
  const p = S.loteVal;
  if (!S.lote.json.trim() || !p) return S.lote.json.trim() ? '<p class="text-xs text-zinc-500">Revisando…</p>' : '';
  if (p.error) return `<p class="text-xs text-red-400">${esc(p.error)}</p>`;
  const lista = S.lote.modo === 'top'
    ? [...p.items].sort((a, b) => (Number(efectivo(b).ranking) || 0) - (Number(efectivo(a).ranking) || 0))
    : p.items;
  return `
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span data-total class="text-xs text-zinc-400">${textoTotal()}</span>
      <div class="flex items-center gap-2"><span class="text-[11px] text-zinc-500">Crédito por defecto</span>
        <div class="w-56">${segmentado('credito-modo', S.creditoModo, [['arroba', '@usuario'], ['nombre', 'Nombre'], ['ninguno', 'Ninguno']])}</div></div>
    </div>
    ${S.lote.modo === 'top' ? '<p class="mt-1 text-[11px] text-zinc-500">El video va de arriba hacia abajo; las insignias se renumeran solas (#N … #1) según los clips incluidos.</p>' : ''}
    <ul class="mt-2 space-y-2">${lista.map(filaClip).join('')}</ul>`;
}

function textoBotonLote() {
  const n = itemsLote().filter(i => i.existe && efectivo(i).incluir).length;
  return { n, texto: `Exportar directo (${n})` };
}

/** Re-pinta sin reiniciar los videos que se están viendo (los mueve al HTML nuevo). */
function conservarVideos(contenedor, pintar) {
  const vids = {};
  contenedor.querySelectorAll('video[data-vkey]').forEach(v => (vids[v.dataset.vkey] = v));
  pintar();
  // solo se conserva el mismo video (misma fuente); si cambió el archivo, se usa el nuevo
  contenedor.querySelectorAll('video[data-vkey]').forEach(n => {
    const v = vids[n.dataset.vkey];
    if (v && v !== n && v.getAttribute('src') === n.getAttribute('src')) n.replaceWith(v);
  });
}

function actualizarClip(li) {
  const it = itemLote(li.dataset.clip);
  if (!it) return;
  const r = $('[data-resumen]', li); if (r) r.innerHTML = textoSeccion(it);
  li.classList.toggle('opacity-50', !efectivo(it).incluir);
  const t = $('[data-total]'); if (t) t.textContent = textoTotal();
  const btn = $('[data-action="procesar-lote"]');
  if (btn) { const b = textoBotonLote(); btn.textContent = b.texto; btn.disabled = !b.n || !S.estado?.encoder?.ffmpeg; }
  const edb = $('[data-action="abrir-editor"]'); if (edb) edb.disabled = !textoBotonLote().n;
}

// Fondo de los videos: difuminado del propio clip, negro o un color
function selectorFondo() {
  const f = S.lote.fondo, color = f.startsWith('#') ? f : '#1e1b4b';
  const op = (v, l) => `<button data-action="fondo" data-valor="${v}" class="rounded-lg px-3 py-1.5 text-xs font-semibold transition ${(v === 'color' ? f.startsWith('#') : f === v) ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400'}">${l}</button>`;
  return `<div class="inline-flex items-center gap-1 rounded-xl bg-zinc-950/70 p-1">${op('difuminado', 'Difuminado')}${op('negro', 'Negro')}${op('color', 'Color')}
    <input type="color" data-fondo-color value="${color}" title="Elegir color" class="h-7 w-8 cursor-pointer rounded border-0 bg-transparent p-0 ${f.startsWith('#') ? '' : 'opacity-40'}" /></div>`;
}
function fijarFondo(v) {
  S.lote.fondo = v; localStorage.setItem('loteFondo', v);
  if (S.editor?.abierto && typeof pintarFondoEditor === 'function') pintarFondoEditor();
}

function bloqueProcesar(c, gpu, jobs) {
  const lote = S.subtab !== 'manual';
  const b = textoBotonLote();
  const contenidoLote = `
    <textarea data-lote="json" rows="6" spellcheck="false" placeholder='Pega aquí el JSON que te devolvió Claude: [ { "ranking": 3, "archivo": "…", … } ]'
      class="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3 font-mono text-[13px] outline-none focus:border-zinc-400">${esc(S.lote.json)}</textarea>
    <div data-lote-preview class="mt-2">${previewLote()}</div>
    <div class="mt-3">${segmentado('modo', S.lote.modo, [['individual', 'A · Shorts individuales'], ['top', 'B · Top recopilación']])}</div>
    <p class="mt-1.5 text-[11px] text-zinc-500">${S.lote.modo === 'top'
      ? 'Un solo video de #N a #1 con insignia de puesto, gancho y crédito · 60 fps · audio 48 kHz estéreo normalizado → <b>Top_GTAVI_fecha.mp4</b>.'
      : 'Un short vertical 1080×1920 por clip → <b>Gaming/Listos</b>, con título, descripción y crédito ya llenos para el celular.'}</p>
    <div class="mt-2 flex flex-wrap items-center gap-2"><span class="text-[11px] text-zinc-500">Fondo</span>${selectorFondo()}</div>
    ${S.lote.modo === 'top' ? `<div class="mt-2">${segmentado('orient', S.lote.orient, [['vertical', '▯ Vertical 1080×1920'], ['horizontal', '▭ Horizontal 1920×1080']])}</div>` : ''}
    <div class="mt-3 flex flex-wrap gap-2">
      <button data-action="abrir-editor" ${b.n ? '' : 'disabled'}
        class="flex-1 rounded-lg bg-fuchsia-600 px-5 py-3 font-bold transition active:scale-[.98] disabled:opacity-40">Continuar al editor →</button>
      <button data-action="procesar-lote" ${b.n && gpu.ffmpeg ? '' : 'disabled'}
        class="rounded-lg border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-300 transition active:scale-[.98] disabled:opacity-40">${b.texto}</button>
      ${S.lote.json ? '<button data-action="limpiar-lote" class="rounded-lg border border-zinc-700 px-4 text-sm text-zinc-400">Limpiar</button>' : ''}
    </div>`;

  const contenidoManual = `
    <p class="mt-3 text-xs text-zinc-400">Vertical 1080×1920 · gancho arriba · crédito abajo (se quema tal cual lo escribas) → <b>Gaming/Listos</b></p>
    <div class="mt-2 flex flex-wrap items-center gap-2"><span class="text-[11px] text-zinc-500">Fondo</span>${selectorFondo()}</div>
    <div class="mt-3 grid gap-2 md:grid-cols-[2fr_2fr_1fr_auto]">
      <select data-form="video" class="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-[16px] md:text-sm">
        ${c.raw.length ? c.raw.map(r => `<option value="${esc(r.name)}" ${r.name === S.form.video ? 'selected' : ''}>${esc(r.info?.texto ? `${r.info.creador || ''} — ${r.info.texto}`.slice(0, 90) : r.name)}</option>`).join('') : '<option value="">(Gaming/Raw está vacío)</option>'}
      </select>
      <input data-form="hook" value="${esc(S.form.hook)}" placeholder="Gancho (texto de arriba)" class="${inputCls}" />
      <input data-form="creador" value="${esc(S.form.creador)}" placeholder="Crédito (ej. @usuario)" autocapitalize="off" class="${inputCls}" />
      <button data-action="procesar" ${c.raw.length && gpu.ffmpeg ? '' : 'disabled'}
        class="rounded-lg bg-fuchsia-600 px-5 py-3 font-bold transition active:scale-[.98] disabled:opacity-40">Procesar</button>
    </div>`;

  return `
  <section id="form-procesar" class="rounded-2xl border border-fuchsia-500/30 bg-gradient-to-br from-fuchsia-500/10 to-zinc-900 p-4">
    <div class="flex items-center justify-between gap-2"><h2 class="font-bold">⚙ Procesar clips</h2>
      <span class="text-xs ${gpu.gpu ? 'text-green-400' : 'text-zinc-400'}">${esc(gpu.etiqueta)}</span></div>
    <div class="mt-3">${segmentado('subtab', lote ? 'lote' : 'manual', [['lote', '🤖 Lote con IA'], ['manual', '✋ Manual (1 clip)']])}</div>
    ${lote ? contenidoLote : contenidoManual}
    ${gpu.ffmpeg ? '' : '<p class="mt-2 text-xs text-red-400">FFmpeg no está instalado o no está en el PATH.</p>'}
    ${jobs.map(filaJob).join('')}
  </section>`;
}

// Al elegir un clip, el @creador se llena solo si el nombre del archivo lo trae.
function autoCreador() {
  const r = (S.estado?.canales?.gtavi?.raw || []).find(x => x.name === S.form.video);
  if (r?.info?.creador) S.form.creador = r.info.creador;
}

function vistaGTAVI() {
  if (S.editor?.abierto) return vistaEditor();
  const c = S.estado.canales.gtavi;
  if (S.form.video && !c.raw.some(r => r.name === S.form.video)) S.form.video = '';
  if (!S.form.video && c.raw[0]) S.form.video = c.raw[0].name;
  const gpu = S.estado.encoder;
  const h = S.estado.herramientas || { ytdlp: { ok: false }, python: { ok: false } };
  const jobs = S.estado.jobs || [];

  S.rawSel = S.rawSel.filter(n => c.raw.some(r => r.name === n));
  const raw = c.raw.length
    ? `<ul class="divide-y divide-zinc-800 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">${c.raw.map(r => {
        const n = S.rawSel.indexOf(r.name) + 1;
        return `
        <li data-raw="${esc(r.name)}" class="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 transition ${n ? 'bg-fuchsia-500/10' : 'hover:bg-zinc-800/40'}">
          <span data-rawnum class="grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[11px] font-bold ${n ? 'border-fuchsia-400 bg-fuchsia-500 text-white' : 'border-zinc-600 text-transparent'}">${n || '✓'}</span>
          <div class="min-w-0 flex-1"><p class="truncate text-sm" title="${esc(r.name)}">${esc(r.info?.texto || r.name)}</p>
            <p class="truncate text-xs text-zinc-500">${r.info?.creador ? `<span class="text-zinc-300">${esc(r.info.creador)}</span> · ` : ''}${r.info?.plataforma ? esc(r.info.plataforma) + ' · ' : ''}${tam(r.size)} · ${fecha(r.mtime)}</p></div>
          <div class="flex shrink-0 gap-1.5">
            <a href="/media/gtavi/raw/${enc(r.name)}" target="_blank" class="${btnBase} px-3 py-1.5 text-xs">▶</a>
            <button data-action="usar-raw" data-name="${esc(r.name)}" class="${btnBase} px-3 py-1.5 text-xs">Usar</button>
          </div>
        </li>`;
      }).join('')}</ul>`
    : vacio('Suelta clips en <b>Gaming/Raw</b> o usa el descargador.');

  return `<div class="grid gap-4 lg:grid-cols-2">
      ${bloqueDescargar(h, jobs.filter(j => j.tipo === 'descarga'))}
      ${bloqueAnalizar(h, S.estado.analisis || {})}
    </div>
    <div class="mt-4">${bloqueProcesar(c, gpu, jobs.filter(j => j.tipo !== 'descarga' && !j.proyecto))}</div>`
    + seccion('Raw', c.raw.length,
        `<p class="-mt-1 mb-2 text-xs text-zinc-500">Toca los clips para marcarlos (el número es el orden en el video) y arma una recopilación sin pasar por Claude.</p>${raw}`,
        c.raw.length ? `<div class="flex gap-3 text-xs"><button data-action="raw-todos" class="text-zinc-400 hover:text-white">Marcar todos</button><button data-action="raw-ninguno" class="text-zinc-400 hover:text-white">Ninguno</button></div>` : '')
    + seccion('Listos', c.listos.length, gridVideos('gtavi', c.listos))
    + `<div id="barra-sel">${barraSeleccion()}</div>`;
}

// Barra fija de abajo cuando hay clips de Raw marcados
function barraSeleccion() {
  const n = S.rawSel.length;
  if (!n) return '';
  const hayLista = !!(S.lote.json.trim() && itemsLote().some(i => i.existe));
  const b = 'rounded-lg px-4 py-2.5 text-sm font-bold transition active:scale-[.98]';
  return `
  <div class="fixed inset-x-0 bottom-0 z-40 border-t border-fuchsia-500/40 bg-zinc-950/95 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] backdrop-blur">
    <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
      <b class="mr-auto text-sm">${n} clip${n === 1 ? '' : 's'} marcado${n === 1 ? '' : 's'}</b>
      <button data-action="crear-desde-raw" data-valor="top" class="${b} bg-fuchsia-600">🎬 Crear recopilación</button>
      <button data-action="crear-desde-raw" data-valor="individual" class="${b} border border-zinc-600">▯ Shorts individuales</button>
      ${hayLista ? `<button data-action="agregar-a-lista" class="${b} border border-zinc-600">+ Agregar a la lista actual</button>` : ''}
      <button data-action="raw-ninguno" class="px-2 text-zinc-400" title="Quitar selección">✕</button>
    </div>
  </div>`;
}
function pintarSeleccionRaw() {
  document.querySelectorAll('[data-raw]').forEach(li => {
    const n = S.rawSel.indexOf(li.dataset.raw) + 1, num = $('[data-rawnum]', li);
    li.classList.toggle('bg-fuchsia-500/10', !!n); li.classList.toggle('hover:bg-zinc-800/40', !n);
    num.textContent = n || '✓';
    num.className = `grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[11px] font-bold ${n ? 'border-fuchsia-400 bg-fuchsia-500 text-white' : 'border-zinc-600 text-transparent'}`;
  });
  const bar = $('#barra-sel'); if (bar) bar.innerHTML = barraSeleccion();
}

/** Arma la lista del lote con los clips marcados en Raw y abre el editor. */
async function loteDesdeRaw(modo, agregar) {
  const raw = S.estado.canales.gtavi.raw;
  const info = n => raw.find(r => r.name === n)?.info || {};
  let previos = [];
  if (agregar) { try { const d = JSON.parse(S.lote.json); previos = Array.isArray(d) ? d : []; } catch { previos = (S.loteVal?.items || []).map(i => ({ ...i })); } }
  const yaEsta = new Set(previos.map(p => p.archivo));
  const nuevos = S.rawSel.filter(n => !yaEsta.has(n));
  const tope = Math.max(0, ...previos.map(p => Number(p.ranking) || 0));
  // en el video van en el orden en que los marcaste (el primero marcado sale primero)
  const lista = [
    ...nuevos.map((archivo, i) => ({ ranking: tope + nuevos.length - i, archivo, creador: info(archivo).creador || '', gancho: '', titulo_post: '', descripcion_post: '' })),
    ...previos,
  ];
  S.lote.json = JSON.stringify(lista, null, 2);
  if (!agregar) { S.ajustes = {}; S.lote.modo = modo; localStorage.setItem('loteModo', modo); }
  for (const a of Object.values(S.ajustes)) delete a.ranking;   // el orden lo manda la lista nueva
  try { localStorage.setItem('loteJSON', S.lote.json); } catch { /* sin espacio */ }
  guardarAjustes();
  S.subtab = 'lote'; localStorage.setItem('subtab', 'lote');
  S.rawSel = [];
  try {
    S.loteVal = await api('/api/lote/validar', { method: 'POST', body: JSON.stringify({ json: S.lote.json }) });
    S.loteValClave = claveLote();
  } catch (err) { return toast(err.message, 'error'); }
  abrirEditor();
}

function vistaUcronia() {
  const c = S.estado.canales.ucronia;
  const guiones = c.guiones.length
    ? `<div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">${c.guiones.map(g => `
        <a href="/guion/${enc(g.name)}" target="_blank" class="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 transition hover:border-zinc-600 active:scale-[.99]">
          <span class="text-lg">📜</span>
          <div class="min-w-0"><p class="truncate text-sm font-medium">${esc(g.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '))}</p>
          <p class="text-xs text-zinc-500">${fecha(g.mtime)}</p></div></a>`).join('')}</div>`
    : vacio('No hay guiones en <b>Historias/Guiones</b>.');
  return seccion('Listos', c.listos.length, gridVideos('ucronia', c.listos)).replace('mt-6', 'mt-0')
    + seccion('Guiones', c.guiones.length, guiones);
}

function vistaMetricas() {
  const m = S.metricas;
  if (!m.length) return vacio('Aún no hay videos publicados. Usa <b>✓ Marcar como publicado</b> en una tarjeta.');
  const suma = f => m.reduce((a, r) => a + (r[f] || 0), 0);
  const hora = (r, h) => fecha(new Date(r.fechaPublicacion).getTime() + h * 3600e3);
  return `
  <div class="mb-4 grid grid-cols-3 gap-2 text-center">
    ${[['Publicados', m.length], ['Vistas 24h', suma('vistas24h').toLocaleString('es-MX')], ['Vistas 72h', suma('vistas72h').toLocaleString('es-MX')]]
      .map(([l, n]) => `<div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3"><p class="text-xl font-bold">${n}</p><p class="text-[11px] text-zinc-500">${l}</p></div>`).join('')}
  </div>
  <div class="grid gap-3 md:grid-cols-2">${m.map(r => `
    <article class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4" data-metrica="${esc(r.id)}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0"><h3 class="truncate text-sm font-semibold">${esc(r.titulo || r.video)}</h3>
          <p class="truncate text-xs text-zinc-500">${esc(r.video)}</p></div>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.canalId === 'gtavi' ? 'bg-fuchsia-500/15 text-fuchsia-300' : 'bg-sky-500/15 text-sky-300'}">${esc(r.canal)}</span>
      </div>
      <p class="mt-1 text-xs text-zinc-400">Publicado: ${fecha(r.fechaPublicacion)}</p>
      <div class="mt-3 grid grid-cols-2 gap-2">
        ${[['vistas24h', '24 h', 24], ['vistas72h', '72 h', 72]].map(([f, l, h]) => `
          <label class="block"><span class="text-xs text-zinc-400">Vistas ${l} <span class="text-zinc-600">· ${hora(r, h)}</span></span>
            <input data-mfield="${f}" inputmode="numeric" value="${r[f] ?? ''}" placeholder="—"
              class="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2.5 text-[16px] font-semibold outline-none transition focus:border-zinc-400" /></label>`).join('')}
      </div>
    </article>`).join('')}</div>`;
}

// ───────────── render / datos ─────────────
function render(forzar = false) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('tab-on', b.dataset.tab === S.tab));
  if (!S.estado) { app.innerHTML = '<p class="py-10 text-center text-zinc-500">Cargando…</p>'; return; }
  const e = S.estado.encoder;
  $('#encoder').textContent = e.ffmpeg ? (e.gpu ? '⚡ NVENC' : 'CPU') : 'sin FFmpeg';
  // En el editor, los refrescos automáticos solo actualizan el avance de exportación (no tocan el video ni las manijas).
  const enEditor = S.tab === 'gtavi' && S.editor?.abierto;
  if (enEditor && !forzar && $('#editor')) return montarEditor(true);
  if (S.tab === 'largo' && !forzar && $('#largo')) return montarLargo(true);
  conservarVideos(app, () => { app.innerHTML = S.tab === 'gtavi' ? vistaGTAVI() : S.tab === 'largo' ? (typeof vistaLargo === 'function' ? vistaLargo() : '') : S.tab === 'ucronia' ? vistaUcronia() : vistaMetricas(); });
  if (enEditor) montarEditor(false);
}

const editando = () => app.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

async function refrescar() {
  if (editando()) { S.pendiente = true; return; }
  try {
    const [estado, metricas] = await Promise.all([api('/api/estado'), api('/api/metricas')]);
    const an = estado.analisis || {};
    if (an.estado === 'listo' && an.fecha && an.fecha !== S.promptFecha) {
      const full = await api('/api/analisis').catch(() => null);
      if (full) { S.prompt = full.prompt || ''; S.promptFecha = an.fecha; }
    }
    S.estado = estado; S.metricas = metricas; S.pendiente = false;
    if (editando()) { S.pendiente = true; return; }
    render();
  } catch (err) { toast('Sin conexión con el servidor', 'error'); }
}

// Tiempo real: SSE + polling de respaldo (y rápido mientras hay un render en curso)
function conectarSSE() {
  const es = new EventSource('/api/eventos');
  es.onopen = () => ($('#live').className = 'h-2.5 w-2.5 rounded-full bg-green-500 shadow-[0_0_8px] shadow-green-500');
  es.onerror = () => ($('#live').className = 'h-2.5 w-2.5 rounded-full bg-red-500');
  es.addEventListener('cambio', refrescar);
}
setInterval(() => {
  const trabajando = (S.estado?.jobs || []).some(j => j.estado === 'procesando' || j.estado === 'en cola')
    || S.estado?.analisis?.estado === 'procesando';
  if (trabajando || Date.now() - (S.ultimoPoll || 0) > 15000) { S.ultimoPoll = Date.now(); refrescar(); }
}, 1500);

// ───────────── eventos ─────────────
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  S.tab = b.dataset.tab; localStorage.setItem('tab', S.tab); render(true); window.scrollTo({ top: 0 });
}));

app.addEventListener('focusout', () => setTimeout(() => { if (S.pendiente && !editando()) refrescar(); }, 150));

app.addEventListener('toggle', e => {
  const card = e.target.closest?.('[data-key]');
  if (e.target.matches?.('details[data-editor]') && card) S.editorAbierto[card.dataset.key] = e.target.open;
  if (e.target.matches?.('details[data-abierto]')) S.abiertos[e.target.dataset.abierto] = e.target.open;
}, true);

app.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.dl) { S.dl[t.dataset.dl] = t.value; return; }
  if (t.dataset.lote) {
    S.lote.json = t.value;
    try { localStorage.setItem('loteJSON', t.value); } catch { /* sin espacio */ }
    validarLote();
    return;
  }
  const li = t.closest('[data-clip]');
  if (li && t.dataset.aj && t.type !== 'checkbox') {
    (S.ajustes[li.dataset.clip] ||= {})[t.dataset.aj] = t.value;
    guardarAjustes(); actualizarClip(li);
    return;
  }
  if (t.dataset.form) {
    S.form[t.dataset.form] = t.value;
    if (t.dataset.form === 'creador') localStorage.setItem('ultimoCreador', t.value);
    return;
  }
  const card = t.closest('[data-key]');
  if (card && t.dataset.field) {
    const k = card.dataset.key;
    (S.drafts[k] ||= {})[t.dataset.field] = t.value;
    if (t.dataset.field === 'pegar') {
      const box = $('[data-preview]', card);
      if (!t.value.trim()) { box.classList.add('hidden'); return; }
      const p = partir(t.value);
      box.classList.remove('hidden');
      box.innerHTML = `<b class="text-zinc-200">Título:</b> ${esc(p.titulo)}<br><b class="text-zinc-200">Descripción:</b> ${esc(p.descripcion.slice(0, 160))}${p.descripcion.length > 160 ? '…' : ''}`;
    }
  }
});
app.addEventListener('change', e => {
  const li = e.target.closest('[data-clip]');
  if (li && e.target.dataset.aj === 'incluir') {
    (S.ajustes[li.dataset.clip] ||= {}).incluir = e.target.checked;
    guardarAjustes(); actualizarClip(li);
  }
  if (li && e.target.dataset.aj === 'ranking' && S.lote.modo === 'top') pintarLote();  // reordena al salir del campo
  if (e.target.dataset.form === 'video') { S.form.video = e.target.value; autoCreador(); render(); }
  if (e.target.matches('[data-fondo-color]')) {
    fijarFondo(e.target.value);
    e.target.closest('div')?.querySelector('[data-valor="color"]')?.click();
  }
  if (e.target.matches('[data-modelo]')) { S.modelo = e.target.value; localStorage.setItem('modeloWhisper', S.modelo); }
  const mc = e.target.closest('[data-metrica]');
  if (mc && e.target.dataset.mfield) guardarMetrica(mc.dataset.metrica, e.target);
});

async function guardarMetrica(id, input) {
  try {
    const reg = await api(`/api/metricas/${enc(id)}`, { method: 'PATCH', body: JSON.stringify({ [input.dataset.mfield]: input.value }) });
    const i = S.metricas.findIndex(m => m.id === id);
    if (i !== -1) S.metricas[i] = reg;
    input.value = reg[input.dataset.mfield] ?? '';
    input.classList.add('!border-green-500');
    setTimeout(() => input.classList.remove('!border-green-500'), 1200);
  } catch (err) { toast(err.message, 'error'); }
}

app.addEventListener('click', e => {
  const li = e.target.closest('[data-raw]');
  if (!li || e.target.closest('a, button')) return;
  const i = S.rawSel.indexOf(li.dataset.raw);
  if (i === -1) S.rawSel.push(li.dataset.raw); else S.rawSel.splice(i, 1);
  pintarSeleccionRaw();
});

app.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card = btn.closest('[data-key]');
  const k = card?.dataset.key;
  const [canal, ...rest] = (k || '').split('/');
  const name = rest.join('/');
  const accion = btn.dataset.action;

  if (accion === 'copiar') {
    const texto = buscarVideo(k)?.meta?.[btn.dataset.field] || '';
    const ok = texto && await copiar(texto);
    if (ok) {
      const lbl = $('.lbl', btn), top = $('.lbl-top', btn), antes = lbl.textContent;
      btn.classList.add('ok-flash'); lbl.textContent = '✓ Copiado'; top.style.visibility = 'hidden';
      navigator.vibrate?.(30);
      setTimeout(() => { btn.classList.remove('ok-flash'); lbl.textContent = antes; top.style.visibility = ''; }, 1400);
    } else toast('No se pudo copiar', 'error');
  }

  if (accion === 'partir' || accion === 'guardar') {
    const d = S.drafts[k] || {};
    const v = buscarVideo(k);
    const body = accion === 'partir'
      ? { modo: 'partir', completo: $('[data-field="pegar"]', card).value }
      : {
          // solo se manda lo que editaste; lo demás se queda como está en el servidor (evita borrar con una vista vieja)
          modo: 'manual',
          titulo: d.titulo ?? v?.meta?.titulo ?? '',
          descripcion: d.descripcion ?? v?.meta?.descripcion ?? '',
          completo: d.completo ?? v?.meta?.completo ?? '',
        };
    if (accion === 'partir' && !body.completo.trim()) return toast('Pega primero la descripción', 'info');
    if (accion === 'guardar' && !`${body.titulo}${body.descripcion}${body.completo}`.trim() && (v?.meta?.titulo || v?.meta?.completo)
        && !confirm('Vas a dejar este video SIN título ni descripción. ¿Seguro?')) return;
    btn.disabled = true;
    try {
      const { meta } = await api(`/api/meta/${enc(canal)}/${enc(name)}`, { method: 'POST', body: JSON.stringify(body) });
      if (v) v.meta = meta;
      delete S.drafts[k];
      document.activeElement?.blur?.();
      render();
      toast(accion === 'partir' ? '✂ Partido y guardado' : 'Cambios guardados');
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  }

  if (accion === 'publicar') {
    const tit = btn.closest('article')?.querySelector('[data-field="titulo"]')?.value?.trim();
    if (!confirm(`¿Marcar como PUBLICADO?\n\n${tit ? `“${tit}”\n(${name})` : name}\n\nSe registra en métricas y el MP4 se manda a la Papelera de reciclaje.`)) return;
    btn.disabled = true; btn.textContent = 'Publicando…';
    try {
      const r = await api(`/api/publicar/${enc(canal)}/${enc(name)}`, { method: 'POST' });
      toast(`Publicado ✓  MP4 → ${r.destino}`);
      delete S.drafts[k];
      await refrescar();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = '✓ Marcar como publicado'; }
  }

  if (accion === 'fondo') {
    const v = btn.dataset.valor;
    fijarFondo(v === 'color' ? ($('[data-fondo-color]', btn.parentElement)?.value || '#1e1b4b') : v);
    document.querySelectorAll('[data-action="fondo"]').forEach(x => {
      const on = x.dataset.valor === 'color' ? S.lote.fondo.startsWith('#') : S.lote.fondo === x.dataset.valor;
      x.className = x.className.replace(/bg-zinc-100 text-zinc-950|text-zinc-400/g, '').trim() + (on ? ' bg-zinc-100 text-zinc-950' : ' text-zinc-400');
    });
    document.querySelectorAll('[data-fondo-color]').forEach(x => x.classList.toggle('opacity-40', !S.lote.fondo.startsWith('#')));
  }
  if (accion === 'subtab' || accion === 'modo' || accion === 'orient') {
    const v = btn.dataset.valor;
    if (accion === 'subtab') { S.subtab = v; localStorage.setItem('subtab', v); }
    if (accion === 'modo') { S.lote.modo = v; localStorage.setItem('loteModo', v); }
    if (accion === 'orient') { S.lote.orient = v; localStorage.setItem('loteOrient', v); }
    render(true);
  }

  if (accion === 'copiar-prompt') {
    const ok = S.prompt && await copiar(S.prompt);
    const lbl = $('.lbl', btn), antes = lbl.textContent;
    if (ok) {
      btn.classList.add('ok-flash'); lbl.textContent = '✓ Prompt copiado · pégalo en Claude'; navigator.vibrate?.(30);
      setTimeout(() => { btn.classList.remove('ok-flash'); lbl.textContent = antes; }, 1800);
    } else toast('No se pudo copiar: abre "Ver prompt" y cópialo a mano', 'error');
  }

  if (accion === 'descargar-clip') {
    if (!/^https?:\/\//i.test(S.dl.url.trim())) return toast('Pega una URL válida (https://…)', 'info');
    btn.disabled = true;
    try {
      await api('/api/clips/descargar', { method: 'POST', body: JSON.stringify(S.dl) });
      toast('Descargando a Gaming/Raw…', 'info');
      S.dl = { url: '', creador: '', rango: '' };
      document.activeElement?.blur?.();
      await refrescar();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  }

  if (accion === 'analizar') {
    btn.disabled = true;
    try {
      await api('/api/analizar', { method: 'POST', body: JSON.stringify({ modelo: S.modelo }) });
      await refrescar();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  }

  const li = btn.closest('[data-clip]');
  if (accion === 'credito-chip' && li) {
    (S.ajustes[li.dataset.clip] ||= {}).credito = btn.dataset.valor;
    guardarAjustes();
    $('[data-aj="credito"]', li).value = btn.dataset.valor;
  }
  if (accion === 'credito-modo') {
    S.creditoModo = btn.dataset.valor; localStorage.setItem('creditoModo', S.creditoModo);
    // el modo por defecto reemplaza los créditos que no escribiste a mano
    for (const k of Object.keys(S.ajustes)) delete S.ajustes[k].credito;
    guardarAjustes(); pintarLote();
  }
  if (accion === 'abrir-editor') return abrirEditor();
  if (accion === 'raw-todos') { S.rawSel = S.estado.canales.gtavi.raw.map(r => r.name); return pintarSeleccionRaw(); }
  if (accion === 'raw-ninguno') { S.rawSel = []; return pintarSeleccionRaw(); }
  if (accion === 'crear-desde-raw') {
    if (S.lote.json.trim() && !confirm('Esto reemplaza la lista de clips actual del lote. ¿Continuar?')) return;
    return loteDesdeRaw(btn.dataset.valor, false);
  }
  if (accion === 'agregar-a-lista') return loteDesdeRaw(S.lote.modo, true);

  if (accion === 'procesar-lote') {
    const items = itemsLote().filter(i => i.existe);
    const ajustes = Object.fromEntries(items.map(i => [i.archivo, efectivo(i)]));
    // capas de texto con emojis (las dibuja el navegador, igual que en el editor)
    const incl = items.filter(i => efectivo(i).incluir);
    const orden = S.lote.modo === 'top' ? [...incl].sort((a, b) => (Number(efectivo(b).ranking) || 0) - (Number(efectivo(a).ranking) || 0)) : incl;
    for (const [k, png] of Object.entries(await generarCapas(orden))) ajustes[k].capa = png;
    btn.disabled = true;
    try {
      const job = await api('/api/lote', { method: 'POST', body: JSON.stringify({ json: S.lote.json, modo: S.lote.modo, orientacion: S.lote.orient, ajustes, fondo: S.lote.fondo,
        estilo: S.lote.estilo, titulo: S.lote.titulo, extra: S.lote.extra }) });
      toast(`${job.tipo === 'top' ? 'Top' : 'Lote'} en cola con ${job.encoder}${job.omitidos?.length ? `\n${job.omitidos.length} omitido(s): no están en Raw` : ''}`, 'info');
      document.activeElement?.blur?.();
      await refrescar();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  }

  if (accion === 'limpiar-lote') {
    S.lote.json = ''; S.loteVal = null; S.ajustes = {};
    localStorage.removeItem('loteJSON'); localStorage.removeItem('loteAjustes'); render();
  }

  if (accion === 'usar-raw') {
    S.form.video = btn.dataset.name; autoCreador(); S.subtab = 'manual'; localStorage.setItem('subtab', 'manual'); render();
    $('#form-procesar')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('[data-form="hook"]')?.focus(), 350);
  }

  if (accion === 'procesar') {
    if (!S.form.video) return toast('Elige un video', 'info');
    btn.disabled = true;
    try {
      const job = await api('/api/procesar', { method: 'POST', body: JSON.stringify({ ...S.form, fondo: S.lote.fondo }) });
      toast(`Procesando con ${job.encoder}…`, 'info');
      S.form.hook = '';
      document.activeElement?.blur?.();
      await refrescar();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  }
});

render();
refrescar();
conectarSSE();

// ───────────── tramo de tiempo: escribe solo números y se acomoda ─────────────
// "104350104430" → "10:43:50-10:44:30" · también acepta "-" a mano para tramos cortos ("0215-0245" → "02:15-02:45")
function formatearRango(v) {
  // agrupa de 2 en 2; respeta los ":" que escribas tú (para "1:05")
  const parte = p => {
    const segs = p.split(':').map(x => x.replace(/\D/g, ''));
    const ult = segs.pop();
    const out = [...segs, ...(ult.match(/\d{1,2}/g) || (segs.length ? [''] : []))];
    let n = 0; return out.filter(x => (n += x.length) <= 6 || !x).slice(0, 3).join(':');
  };
  const i = v.indexOf('-');
  if (i >= 0) return parte(v.slice(0, i)) + '-' + parte(v.slice(i + 1).replace(/-/g, ''));
  const d = v.replace(/[^\d:]/g, ''), digitos = d.replace(/:/g, '');
  if (digitos.length <= 6) return parte(d);
  // más de 6 números seguidos: el resto ya es el fin del tramo
  let k = 0, cuenta = 0; while (k < d.length && cuenta < 6) { if (d[k] !== ':') cuenta++; k++; }
  return parte(d.slice(0, k)) + '-' + parte(d.slice(k).replace(/^:/, ''));
}
document.addEventListener('input', e => {
  const t = e.target;
  if (!t.matches?.('input[data-rango]') || (e.inputType || '').startsWith('delete')) return;
  if (t.selectionStart !== t.value.length) return;   // editando en medio: no mover el cursor
  const f = formatearRango(t.value);
  if (f !== t.value) t.value = f;
}, true);
