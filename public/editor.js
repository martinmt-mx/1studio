/* 1Studio · Mini editor de recopilación (paso 2 del lote)
 * Orden de los clips, recortes con varias secciones por clip y vista previa con los textos encima.
 * Depende de app.js (S, $, esc, enc, api, toast, render, efectivo, itemsLote, guardarAjustes…). */
const ED = { abierto: false, orden: [], items: {}, todos: [], sel: null, secSel: 0, seq: false, arrastre: null, dragK: null, pendienteSeek: null };
S.editor = ED;

const edItem = k => ED.items[k];
const esTop = () => S.lote.modo === 'top';
const esLista = () => esTop() && S.lote.estilo === 'lista';
const edVertical = () => !esTop() || esLista() || S.lote.orient !== 'horizontal';
const puesto = k => ED.orden.length - ED.orden.indexOf(k);
/** Etiqueta del clip en el video: "#3" (insignias) o "2." (lista). */
const etiqueta = k => (esLista() ? `${ED.orden.indexOf(k) + 1}.` : esTop() ? `#${puesto(k)}` : '');
const durClip = it => it?.duracion || 0;
const durSecs = secs => secs.reduce((t, s) => t + Math.max(0, s.b - s.a), 0);
const minis = k => `/api/miniaturas/${enc(k)}`;
const vid = () => $('#ed-video');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Secciones que se conservan de un clip (por defecto, el clip completo). */
function seccionesDe(it) {
  const a = S.ajustes[it.archivo] || {};
  if (Array.isArray(a.secciones) && a.secciones.length) return a.secciones.map(s => ({ a: +s.a, b: +s.b }));
  const ini = parseT(a.inicio), fin = parseT(a.fin);
  return [{ a: Number.isFinite(ini) ? ini : 0, b: Number.isFinite(fin) ? fin : durClip(it) }];
}
function fijarSecciones(it, secs, guardar = true) {
  const a = (S.ajustes[it.archivo] ||= {});
  a.secciones = secs.map(s => ({ a: +(+s.a).toFixed(2), b: +(+s.b).toFixed(2) })).sort((x, y) => x.a - y.a);
  delete a.inicio; delete a.fin;
  if (guardar) guardarAjustes();
}
const esCompleto = it => { const s = seccionesDe(it); return s.length === 1 && s[0].a <= 0.05 && (!durClip(it) || s[0].b >= durClip(it) - 0.05); };
const totalEditor = () => ED.orden.reduce((t, k) => t + durSecs(seccionesDe(edItem(k))), 0);

// ───────────── abrir / cerrar ─────────────
function abrirEditor() {
  const todos = itemsLote().filter(i => i.existe);
  const items = todos.filter(i => efectivo(i).incluir);
  if (!items.length) return toast('Elige al menos un clip', 'info');
  const orden = esTop() ? [...items].sort((a, b) => (Number(efectivo(b).ranking) || 0) - (Number(efectivo(a).ranking) || 0)) : items;
  ED.todos = todos;
  ED.items = Object.fromEntries(items.map(i => [i.archivo, { ...i }]));
  ED.orden = orden.map(i => i.archivo);
  if (!ED.orden.includes(ED.sel)) ED.sel = ED.orden[0];
  ED.secSel = 0; ED.seq = false; ED.abierto = true;
  sincronizarPuestos();
  render(true);
  window.scrollTo({ top: 0 });
}
function cerrarEditor() {
  vid()?.pause();
  ED.abierto = false; ED.seq = false;
  render(true);
}
function sincronizarPuestos() {
  if (!esTop()) return;
  ED.orden.forEach((k, i) => { (S.ajustes[k] ||= {}).ranking = ED.orden.length - i; });
  guardarAjustes();
}

// ───────────── HTML ─────────────
// Copia de disenoVertical() de server.js: dónde van los textos según la forma del clip.
const TAMANOS_HOOK = [[72, 22], [64, 25], [56, 28], [48, 33]];
function envolverCli(texto, max) {
  const lineas = [];
  for (const parrafo of texto.split('\n')) {
    let actual = '';
    for (const p of parrafo.split(/\s+/).filter(Boolean)) {
      if (!actual) actual = p; else if ((actual + ' ' + p).length <= max) actual += ' ' + p; else { lineas.push(actual); actual = p; }
    }
    if (actual) lineas.push(actual);
  }
  return lineas;
}
function disenoVerticalCli({ srcW, srcH, hook, badge, credito }) {
  const W = 1080, H = 1920;
  const fgH = srcW && srcH ? Math.min(H, Math.round((W * srcH) / srcW)) : H;
  const banda = Math.max(0, Math.floor((H - fgH) / 2));
  const badgeH = badge ? 150 : 0;
  let lineas = [], size = 72, lh = 92, enBanda = false;
  if (hook) {
    for (const [s, m] of TAMANOS_HOOK) {
      const l = envolverCli(hook, m), h = Math.round(s * 1.28);
      if (badgeH + l.length * h + 60 <= banda) { lineas = l; size = s; lh = h; enBanda = true; break; }
    }
    if (!enBanda) { size = 72; lineas = envolverCli(hook, 22); if (lineas.length > 3) { size = 58; lineas = envolverCli(hook, 28); } lh = Math.round(size * 1.28); }
  } else enBanda = badgeH + 60 <= banda;
  const bloque = badgeH + lineas.length * lh;
  let badgeY, hookY;
  if (enBanda) { badgeY = Math.round(Math.max((banda - bloque) / 2, Math.min(70, banda - bloque - 20))); hookY = badgeY + badgeH; }
  else { badgeY = 90; hookY = Math.max(80, Math.round((badge ? 470 : 420) - (lineas.length * lh) / 2)); }
  const creditoY = credito ? (banda >= 110 ? banda + fgH + Math.min(60, Math.round((banda - 66) / 2)) : 1500) : null;
  return { badgeY, hookY, size, lh, lineas, creditoY };
}

function disenoListaCli({ srcW, srcH, titulo, total }) {
  const W = 1080, H = 1920;
  const t = disenoVerticalCli({ srcW, srcH, hook: titulo, badge: '', credito: '' });
  const fgH = srcW && srcH ? Math.min(H, Math.round((W * srcH) / srcW)) : H;
  const banda = Math.max(0, Math.floor((H - fgH) / 2));
  let size, lh, y0, conCaja = false;
  if (banda >= 200) {
    size = Math.max(28, Math.min(56, Math.floor((banda - 50) / total / 1.3)));
    lh = Math.round(size * 1.3);
    y0 = banda + fgH + Math.max(25, Math.round((banda - total * lh) / 2));
  } else {
    size = Math.max(28, Math.min(48, Math.floor(620 / total / 1.3)));
    lh = Math.round(size * 1.3); y0 = H - 300 - total * lh; conCaja = true;
  }
  const maxChars = Math.floor((W - 140) / (size * 0.56));
  return { titulo: t, size, lh, y0, maxChars, conCaja, creditoY: banda >= 200 ? banda + fgH - 84 : y0 - 90 };
}

// ───────────── Capa de textos (canvas) ─────────────
// El navegador dibuja todos los textos en un PNG transparente del tamaño del video y FFmpeg solo lo pega encima:
// así los emojis salen a color y la vista previa es idéntica al video final.
const FUENTE = '"Arial Black", Arial, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
function textoCanvas(ctx, t, { size, color = '#fff', x = null, y, borde = 7, sombra = 4, caja = null }) {
  if (!t) return;
  ctx.font = `bold ${size}px ${FUENTE.replace('"Arial Black", ', '')}`;
  ctx.textBaseline = 'top';
  const w = ctx.measureText(t).width;
  const px = x === null ? (ctx.canvas.width - w) / 2 : x;
  if (caja) { ctx.fillStyle = caja.color; ctx.fillRect(px - caja.pad, y - caja.pad, w + caja.pad * 2, size * 1.05 + caja.pad * 2); }
  ctx.lineJoin = 'round';
  if (borde) {
    ctx.save();
    if (sombra) { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowOffsetY = sombra; }
    ctx.strokeStyle = '#000'; ctx.lineWidth = borde * 2; ctx.strokeText(t, px, y);
    ctx.restore();
  }
  ctx.fillStyle = color; ctx.fillText(t, px, y);
}
const anchoTexto = (ctx, t, size) => { ctx.font = `bold ${size}px ${FUENTE.replace('"Arial Black", ', '')}`; return ctx.measureText(t).width; };

/** spec: { vertical, srcW, srcH, badge, hook, credito, lista: { titulo, textos, actual, total } } */
function dibujarCapa(cv, spec) {
  const W = spec.vertical ? 1080 : 1920, H = spec.vertical ? 1920 : 1080;
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const cred = String(spec.credito || '').trim().slice(0, 60);

  if (spec.lista) {
    const L = spec.lista;
    const d = disenoListaCli({ srcW: spec.srcW, srcH: spec.srcH, titulo: String(L.titulo || '').trim(), total: L.total });
    d.titulo.lineas.forEach((ln, i) => textoCanvas(ctx, ln, { size: d.titulo.size, y: d.titulo.hookY + i * d.titulo.lh }));
    for (let j = 0; j < L.total; j++) {
      const visto = j <= L.actual && j < L.textos.length;
      let t = `${j + 1}. ${visto ? String(L.textos[j] || '').trim() || '…' : '????'}`;
      // renglón largo: se achica la letra (hasta 70 %) y si aún no cabe se corta con "…"
      const maxW = W - 140;
      let size = d.size;
      const w0 = anchoTexto(ctx, t, size);
      if (w0 > maxW) size = Math.max(Math.round(d.size * 0.7), Math.floor(d.size * maxW / w0));
      while (anchoTexto(ctx, t, size) > maxW && t.length > 4) t = [...t].slice(0, -2).join('').trimEnd() + '…';
      textoCanvas(ctx, t, {
        size, x: 70, y: d.y0 + j * d.lh + Math.round((d.size - size) / 2),
        color: j === L.actual ? '#FFD400' : visto ? '#fff' : '#D4D4D8',
        borde: Math.max(3, Math.round(size / 10)), sombra: 3, caja: d.conCaja ? { color: 'rgba(0,0,0,.45)', pad: 10 } : null,
      });
    }
    if (cred) textoCanvas(ctx, cred, { size: 40, y: d.creditoY, borde: 4, sombra: 0, caja: { color: 'rgba(0,0,0,.45)', pad: 12 } });
    return;
  }

  const hook = String(spec.hook || '').trim();
  if (spec.vertical) {
    const d = disenoVerticalCli({ srcW: spec.srcW, srcH: spec.srcH, hook, badge: spec.badge, credito: cred });
    if (spec.badge) textoCanvas(ctx, spec.badge, { size: 130, color: '#FFD400', y: d.badgeY, borde: 9, sombra: 6 });
    d.lineas.forEach((ln, i) => textoCanvas(ctx, ln, { size: d.size, y: d.hookY + i * d.lh }));
    if (cred) textoCanvas(ctx, cred, { size: 48, y: d.creditoY, borde: 5, sombra: 0, caja: { color: 'rgba(0,0,0,.35)', pad: 14 } });
    return;
  }
  // horizontal 1920×1080
  if (spec.badge) textoCanvas(ctx, spec.badge, { size: 120, color: '#FFD400', x: 60, y: 40, borde: 8, sombra: 5 });
  if (hook) {
    let size = 60, lineas = envolverCli(hook, 38);
    if (lineas.length > 2) { size = 48; lineas = envolverCli(hook, 50); }
    const lh = Math.round(size * 1.28);
    lineas.forEach((ln, i) => textoCanvas(ctx, ln, { size, y: 50 + i * lh, borde: 6 }));
  }
  if (cred) textoCanvas(ctx, cred, { size: 40, y: H - 110, borde: 5, sombra: 0, caja: { color: 'rgba(0,0,0,.35)', pad: 14 } });
}

/** Lo que va escrito en el clip `it`, según su lugar en `orden` (lista de items en el orden del video). */
function specPara(it, orden, dims = {}) {
  const e = efectivo(it), idx = orden.findIndex(x => x.archivo === it.archivo);
  const base = { vertical: edVertical(), srcW: dims.w || it.w, srcH: dims.h || it.h, credito: e.credito };
  if (esLista()) {
    return { ...base, lista: { titulo: S.lote.titulo, textos: orden.map(x => efectivo(x).gancho), actual: idx, total: orden.length + (S.lote.extra ? 1 : 0) } };
  }
  return { ...base, hook: e.gancho, badge: esTop() ? `#${orden.length - idx}` : '' };
}

/** PNG (data URL) de la capa de cada clip, para mandarlos con el lote. */
async function generarCapas(orden) {
  try { await document.fonts?.ready; } catch { /* sin API de fuentes */ }
  const cv = document.createElement('canvas'), capas = {};
  for (const it of orden) { dibujarCapa(cv, specPara(it, orden)); capas[it.archivo] = cv.toDataURL('image/png'); }
  return capas;
}

const sinEmojisCli = s => String(s || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, '').replace(/\s+/g, ' ').trim();

function bloqueTimeline(k) {
  const it = edItem(k), e = efectivo(it), d = durSecs(seccionesDe(it)), sel = k === ED.sel;
  return `
  <div draggable="true" data-ed-bloque="${esc(k)}" title="${esc(e.gancho || k)}"
    class="relative h-20 shrink-0 cursor-pointer overflow-hidden rounded-lg bg-zinc-800 ring-2 transition ${sel ? 'ring-fuchsia-500' : 'ring-zinc-800 hover:ring-zinc-600'}"
    style="width:${Math.round(clamp(d * 9, 84, 260))}px;background-image:url('${minis(k)}');background-size:1200% 100%;background-position:0 0">
    <div class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-black/10"></div>
    ${esTop() ? `<b class="pointer-events-none absolute left-1.5 top-1 text-sm text-amber-300 drop-shadow">${etiqueta(k)}</b>` : ''}
    <span class="pointer-events-none absolute right-1.5 top-1 rounded bg-black/60 px-1 font-mono text-[10px]">${fmtT(d)}</span>
    ${esCompleto(it) ? '' : '<span class="pointer-events-none absolute right-1.5 top-6 text-[10px] text-fuchsia-300">✂</span>'}
    <p class="pointer-events-none absolute inset-x-1.5 bottom-1 truncate text-[11px] font-semibold">${esc(e.gancho || '(sin gancho)')}</p>
  </div>`;
}

function seccionesHTML(it) {
  const d = durClip(it) || 1, secs = seccionesDe(it), pct = x => (clamp(x, 0, d) / d) * 100;
  let html = '', cursor = 0;
  secs.forEach(s => { if (s.a > cursor) html += `<div class="absolute inset-y-0 bg-black/75" style="left:${pct(cursor)}%;width:${pct(s.a) - pct(cursor)}%"></div>`; cursor = s.b; });
  if (cursor < d) html += `<div class="absolute inset-y-0 bg-black/75" style="left:${pct(cursor)}%;width:${100 - pct(cursor)}%"></div>`;
  secs.forEach((s, i) => {
    const sel = i === ED.secSel;
    html += `
    <div class="ed-sec absolute inset-y-0 border-y-[3px] ${sel ? 'border-amber-300 bg-amber-300/15' : 'border-amber-500/70'}" data-i="${i}" style="left:${pct(s.a)}%;width:${pct(s.b) - pct(s.a)}%">
      <div data-h="a" data-i="${i}" class="absolute inset-y-0 left-0 w-3.5 cursor-ew-resize rounded-l-md bg-amber-400 shadow"><span class="pointer-events-none absolute inset-y-4 left-[5px] w-0.5 rounded bg-black/50"></span></div>
      <div data-h="b" data-i="${i}" class="absolute inset-y-0 right-0 w-3.5 cursor-ew-resize rounded-r-md bg-amber-400 shadow"><span class="pointer-events-none absolute inset-y-4 right-[5px] w-0.5 rounded bg-black/50"></span></div>
    </div>`;
  });
  return html;
}

function panelHTML(it) {
  if (!it) return '';
  const e = efectivo(it), k = it.archivo, i = ED.orden.indexOf(k);
  const campo = 'mt-0.5 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-[16px] md:text-sm outline-none focus:border-zinc-500';
  const chips = [...new Set([it.creador, it.visible].filter(Boolean))];
  return `
  <div class="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
    <div class="flex items-center gap-2">
      ${esTop() ? `<b class="text-lg text-amber-300">${etiqueta(k)}</b>` : `<b class="text-sm text-zinc-400">${i + 1}/${ED.orden.length}</b>`}
      <p class="min-w-0 flex-1 truncate text-[11px] text-zinc-500" title="${esc(k)}">${esc(k)}</p>
    </div>
    <label class="mt-2 block"><span class="text-[11px] text-zinc-500">${esLista() ? `Texto en la lista (renglón ${i + 1} · corto, ~30 letras)` : 'Gancho (arriba)'}</span>
      <input data-ed-campo="gancho" value="${esc(e.gancho)}" placeholder="${esLista() ? 'Ej. He survives a plane crash' : 'Escribe el gancho de este clip'}" class="${campo}" /></label>
    <label class="mt-2 block"><span class="text-[11px] text-zinc-500">Crédito (abajo, tal cual)</span>
      <input data-ed-campo="credito" value="${esc(e.credito)}" placeholder="sin crédito" autocapitalize="off" class="${campo}" /></label>
    <div class="mt-1.5 flex flex-wrap gap-1.5">
      ${chips.map(v => `<button data-ed="chip" data-valor="${esc(v)}" class="rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 active:scale-95">${esc(v)}</button>`).join('')}
      <button data-ed="chip" data-valor="" class="rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-500 active:scale-95">✕ sin crédito</button>
    </div>
    <div class="mt-3 grid grid-cols-3 gap-1.5">
      <button data-ed="mover" data-valor="-1" ${i <= 0 ? 'disabled' : ''} class="${btnBase} py-2 text-xs">◀ Antes</button>
      <button data-ed="mover" data-valor="1" ${i >= ED.orden.length - 1 ? 'disabled' : ''} class="${btnBase} py-2 text-xs">Después ▶</button>
      <button data-ed="quitar-clip" class="rounded-xl border border-red-500/40 bg-red-500/10 py-2 text-xs font-semibold text-red-300 active:scale-[.97]">Quitar</button>
    </div>
  </div>`;
}

function vistaEditor() {
  const it = edItem(ED.sel), v = edVertical();
  const jobs = (S.estado?.jobs || []).filter(j => j.tipo !== 'descarga' && !j.proyecto);
  const marco = v ? 'aspect-ratio:9/16;height:min(58vh,620px)' : 'aspect-ratio:16/9;width:min(100%,680px)';
  const herr = (accion, texto, extra = '') => `<button data-ed="${accion}" class="${btnBase} px-3 py-2 text-xs ${extra}">${texto}</button>`;
  return `
  <section id="editor" class="rounded-2xl border border-fuchsia-500/30 bg-zinc-900/70 p-3 md:p-4">
    <div class="flex flex-wrap items-center gap-2">
      <button data-ed="volver" class="${btnBase} px-3 py-2 text-sm">← Clips</button>
      <div class="min-w-0 flex-1">
        <h2 class="font-bold">🎬 Editor · ${esTop() ? `${esLista() ? 'Lista' : 'Top'} ${ED.orden.length}` : `${ED.orden.length} short${ED.orden.length === 1 ? '' : 's'}`}</h2>
        <p data-ed-total class="text-[11px] text-zinc-500">Duración ${esTop() ? 'del video' : 'total'}: ${fmtT(totalEditor())}</p>
      </div>
      <div class="flex items-center gap-1.5"><span class="text-[11px] text-zinc-500">Fondo</span>${selectorFondo()}</div>
      ${esTop() ? `<div class="inline-flex gap-1 rounded-xl bg-zinc-950/70 p-1 text-xs font-semibold">
        ${[['insignias', '#N Insignias'], ['lista', '📝 Lista']].map(([v, l]) => `<button data-ed="estilo" data-valor="${v}" class="rounded-lg px-3 py-1.5 ${S.lote.estilo === v ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400'}">${l}</button>`).join('')}</div>` : ''}
      ${esTop() && !esLista() ? `<div class="w-60">${segmentado('orient', S.lote.orient, [['vertical', '▯ 1080×1920'], ['horizontal', '▭ 1920×1080']])}</div>` : ''}
      <button data-ed="exportar" ${S.estado?.encoder?.ffmpeg ? '' : 'disabled'}
        class="rounded-lg bg-fuchsia-600 px-5 py-2.5 font-bold transition active:scale-[.98] disabled:opacity-40">⬆ Exportar</button>
    </div>

    <div class="mt-4 grid gap-4 ${v ? 'lg:grid-cols-[auto_1fr]' : ''}">
      <div class="flex flex-col items-center">
        <div id="ed-frame" class="relative max-w-full overflow-hidden rounded-xl ring-1 ring-zinc-800" style="${marco};container-type:inline-size;background:${S.lote.fondo.startsWith('#') ? S.lote.fondo : '#000'}">
          <canvas id="ed-fondo" width="${v ? 54 : 96}" height="${v ? 96 : 54}" class="absolute inset-0 h-full w-full ${S.lote.fondo === 'difuminado' ? '' : 'hidden'}" style="filter:brightness(.92)"></canvas>
          <video id="ed-video" data-vkey="editor" playsinline preload="auto" class="absolute inset-0 h-full w-full object-contain"></video>
          <canvas id="ed-capa" class="pointer-events-none absolute inset-0 h-full w-full"></canvas>
          <button data-ed="play" class="absolute inset-0 cursor-pointer" aria-label="Reproducir o pausar"></button>
        </div>
        <div class="mt-2 flex items-center gap-1.5">
          ${herr('anterior', '⏮')}${herr('paso', '−0.1s', '" data-valor="-0.1')}
          <button data-ed="play" id="ed-play" class="h-11 w-14 rounded-xl bg-white text-lg font-bold text-zinc-950 active:scale-95">▶</button>
          ${herr('paso', '+0.1s', '" data-valor="0.1')}${herr('siguiente', '⏭')}
        </div>
        <p id="ed-tiempo" class="mt-1 font-mono text-[11px] text-zinc-400">0:00.0</p>
        <button data-ed="todo" id="ed-todo" class="mt-2 rounded-lg border border-fuchsia-500/50 px-4 py-2 text-sm font-semibold text-fuchsia-200 active:scale-[.98]">▶ Reproducir todo</button>
      </div>
      <div class="min-w-0 space-y-3">
        ${esLista() ? `
        <div class="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
          <label class="block"><span class="text-[11px] text-amber-200/80">Título del video (fijo arriba, todo el video)</span>
            <input data-ed-titulo value="${esc(S.lote.titulo)}" placeholder="Ej. BRO What's happening with the planes??"
              class="mt-0.5 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-[16px] font-semibold outline-none focus:border-amber-400/60 md:text-sm" /></label>
          <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" data-ed-extra ${S.lote.extra ? 'checked' : ''} class="h-4 w-4 accent-amber-400" />
            <span>Agregar un renglón extra <b data-ed-extranum>${ED.orden.length + 1}. ????</b> que nunca se revela (la gente se queda esperando el último)</span></label>
        </div>` : ''}
        <div id="ed-panel">${panelHTML(it)}</div>
      </div>
    </div>

    <div class="mt-5">
      <div class="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span>✂ Recorte del clip seleccionado</span><span id="ed-secinfo"></span>
      </div>
      <div id="ed-track" class="relative h-16 touch-none select-none overflow-hidden rounded-lg bg-zinc-800"
        style="background-image:url('${it ? minis(it.archivo) : ''}');background-size:100% 100%">
        <div id="ed-secs" class="absolute inset-0">${it ? seccionesHTML(it) : ''}</div>
        <div id="ed-cabezal" class="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-white shadow-[0_0_6px_white]"></div>
      </div>
      <div class="mt-1 flex justify-between font-mono text-[10px] text-zinc-600"><span>0:00</span><span id="ed-durfin">${fmtT(durClip(it))}</span></div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        ${herr('cortar', '✂ Cortar aquí', 'border-fuchsia-500/50 text-fuchsia-200')}${herr('inicio', '⟦ Inicio aquí')}${herr('fin', 'Fin aquí ⟧')}
        ${herr('quitar-seccion', '🗑 Quitar sección')}${herr('completo', '↺ Clip completo')}
      </div>
      <p class="mt-1.5 text-[11px] text-zinc-500">Arrastra las orillas amarillas para recortar. Para quitar un pedazo de en medio: <b>Cortar aquí</b> al inicio y al final del pedazo, tócalo y <b>Quitar sección</b>.</p>
    </div>

    <div class="mt-5">
      <div class="mb-1.5 text-[11px] text-zinc-500">Línea de tiempo · ${esTop() ? 'de #' + ED.orden.length + ' a #1 · ' : ''}toca un clip para editarlo, arrástralo para cambiar el orden</div>
      <div id="ed-timeline" class="flex gap-1.5 overflow-x-auto pb-2">${ED.orden.map(bloqueTimeline).join('')}</div>
    </div>
    <div id="ed-jobs">${jobs.map(filaJob).join('')}</div>
  </section>`;
}

// ───────────── repintado parcial (sin reiniciar el video) ─────────────
function pintarSeleccion() {
  const it = edItem(ED.sel);
  const p = $('#ed-panel'); if (p) p.innerHTML = panelHTML(it);
  pintarOverlay(); pintarTrack(); pintarTimeline();
  const tr = $('#ed-track'); if (tr && it) tr.style.backgroundImage = `url('${minis(it.archivo)}')`;
  const df = $('#ed-durfin'); if (df) df.textContent = fmtT(durClip(it));
}
function pintarFondoEditor() {
  const f = $('#ed-frame'), c = $('#ed-fondo'); if (!f) return;
  f.style.background = S.lote.fondo.startsWith('#') ? S.lote.fondo : '#000';
  if (c) c.classList.toggle('hidden', S.lote.fondo !== 'difuminado');
}
function pintarOverlay() {
  const cv = $('#ed-capa'), it = edItem(ED.sel), v = vid();
  if (cv && it) dibujarCapa(cv, specPara(it, ED.orden.map(edItem), { w: v?.videoWidth, h: v?.videoHeight }));
  const x = $('[data-ed-extranum]'); if (x) x.textContent = `${ED.orden.length + 1}. ????`;
}
function pintarTrack() {
  const it = edItem(ED.sel); if (!it) return;
  const s = $('#ed-secs'); if (s) s.innerHTML = seccionesHTML(it);
  const secs = seccionesDe(it), info = $('#ed-secinfo');
  if (info) info.textContent = `${secs.length} ${secs.length === 1 ? 'sección' : 'secciones'} · se usan ${fmtT(durSecs(secs))} de ${fmtT(durClip(it))}`;
  const t = $('[data-ed-total]'); if (t) t.textContent = `Duración ${esTop() ? 'del video' : 'total'}: ${fmtT(totalEditor())}`;
}
function pintarTimeline() {
  const tl = $('#ed-timeline'); if (!tl) return;
  const x = tl.scrollLeft; tl.innerHTML = ED.orden.map(bloqueTimeline).join(''); tl.scrollLeft = x;
}
function pintarBotones() {
  const v = vid(), p = $('#ed-play'), t = $('#ed-todo');
  if (p) p.textContent = v && !v.paused ? '⏸' : '▶';
  if (t) t.textContent = ED.seq ? '⏹ Detener' : '▶ Reproducir todo';
}
/** Llamado por render() de app.js */
function montarEditor(soloJobs) {
  const j = $('#ed-jobs');
  if (j) j.innerHTML = (S.estado?.jobs || []).filter(x => x.tipo !== 'descarga' && !x.proyecto).map(filaJob).join('');
  if (soloJobs) return;
  const v = vid();
  if (v && v.dataset.src !== ED.sel) cargarClip(ED.sel, false);
  else { pintarTrack(); pintarBotones(); }
}

// ───────────── reproducción ─────────────
function cargarClip(k, reproducir) {
  if (!edItem(k)) return;
  ED.sel = k; ED.secSel = 0;
  const v = vid();
  pintarSeleccion();
  if (!v) return;
  const secs = seccionesDe(edItem(k));
  ED.pendienteSeek = { t: secs[0]?.a || 0, play: reproducir };
  if (v.dataset.src !== k) { v.dataset.src = k; v.src = `/media/gtavi/raw/${enc(k)}`; }
  else aplicarSeek();
}
function aplicarSeek() {
  const v = vid(), p = ED.pendienteSeek;
  if (!v || !p || v.readyState < 1) return;
  ED.pendienteSeek = null;
  v.currentTime = p.t;
  if (p.play) v.play().catch(() => {});
}
document.addEventListener('loadedmetadata', e => {
  if (e.target.id !== 'ed-video') return;
  const it = edItem(ED.sel);
  if (it && !it.duracion && isFinite(e.target.duration)) { it.duracion = e.target.duration; pintarTrack(); }
  pintarOverlay();   // ya se conoce la forma del clip
  aplicarSeek();
}, true);
document.addEventListener('play', e => e.target.id === 'ed-video' && pintarBotones(), true);
document.addEventListener('pause', e => e.target.id === 'ed-video' && pintarBotones(), true);
document.addEventListener('ended', e => { if (e.target.id === 'ed-video') ED.seq ? siguienteEnSecuencia() : pintarBotones(); }, true);

function alternar() {
  const v = vid(), it = edItem(ED.sel); if (!v || !it) return;
  if (!v.paused) return v.pause();
  const secs = seccionesDe(it), t = v.currentTime;
  if (!secs.some(s => t >= s.a && t < s.b - 0.05)) v.currentTime = (secs.find(s => s.a > t) || secs[0]).a;
  v.play().catch(() => {});
}
function siguienteEnSecuencia() {
  const i = ED.orden.indexOf(ED.sel);
  if (i >= 0 && i < ED.orden.length - 1) cargarClip(ED.orden[i + 1], true);
  else { ED.seq = false; vid()?.pause(); pintarBotones(); }
}

// Bucle: salta los pedazos quitados, mueve el cabezal y el contador.
(function tick() {
  requestAnimationFrame(tick);
  if (!ED.abierto) return;
  const v = vid(), it = edItem(ED.sel);
  if (!v || !it || v.readyState < 1) return;
  const t = v.currentTime, d = durClip(it) || v.duration || 1, secs = seccionesDe(it);
  if (!v.paused && !ED.arrastre) {
    if (!secs.some(s => t >= s.a - 0.04 && t < s.b)) {
      const sig = secs.find(s => s.a > t);
      if (sig) v.currentTime = sig.a;
      else if (ED.seq) siguienteEnSecuencia();
      else { v.pause(); v.currentTime = secs[0].a; }
    }
  }
  const c = $('#ed-cabezal'); if (c) c.style.left = `${clamp(t / d, 0, 1) * 100}%`;
  const cv = $('#ed-fondo');
  if (cv && S.lote.fondo === 'difuminado' && v.videoWidth && v.readyState >= 2) {
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    const esc2 = Math.max(W / v.videoWidth, H / v.videoHeight), sw = W / esc2, sh = H / esc2;   // "cover"
    ctx.filter = 'blur(1.5px)';
    ctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, -2, -2, W + 4, H + 4);
  }
  const lbl = $('#ed-tiempo');
  if (lbl) {
    const usado = secs.reduce((acc, s) => acc + clamp(t - s.a, 0, s.b - s.a), 0);
    lbl.textContent = `${fmtT(t)} / ${fmtT(d)}  ·  en el video ${fmtT(usado)} / ${fmtT(durSecs(secs))}`;
  }
})();

// ───────────── pista de recorte (mouse y táctil) ─────────────
function tiempoEn(e) {
  const tr = $('#ed-track'), r = tr.getBoundingClientRect(), it = edItem(ED.sel);
  return clamp((e.clientX - r.left) / r.width, 0, 1) * (durClip(it) || vid()?.duration || 0);
}
document.addEventListener('pointerdown', e => {
  const tr = e.target.closest('#ed-track'); if (!tr) return;
  const it = edItem(ED.sel), v = vid(); if (!it || !v) return;
  e.preventDefault();
  tr.setPointerCapture(e.pointerId);
  const h = e.target.closest('[data-h]'), sec = e.target.closest('.ed-sec'), t = tiempoEn(e);
  if (h) { ED.arrastre = { tipo: 'borde', i: +h.dataset.i, lado: h.dataset.h }; ED.secSel = +h.dataset.i; v.pause(); }
  else { ED.arrastre = { tipo: 'scrub' }; if (sec) ED.secSel = +sec.dataset.i; v.currentTime = t; }
  pintarTrack();
});
document.addEventListener('pointermove', e => {
  if (!ED.arrastre) return;
  const it = edItem(ED.sel), v = vid(); if (!it || !v) return;
  const t = tiempoEn(e), d = durClip(it) || v.duration;
  if (ED.arrastre.tipo === 'borde') {
    const secs = seccionesDe(it), { i, lado } = ED.arrastre, s = secs[i];
    if (lado === 'a') s.a = clamp(t, i ? secs[i - 1].b : 0, s.b - 0.2);
    else s.b = clamp(t, s.a + 0.2, i < secs.length - 1 ? secs[i + 1].a : d);
    fijarSecciones(it, secs, false);
    v.currentTime = lado === 'a' ? s.a : s.b;
    pintarTrack();
  } else v.currentTime = t;
});
document.addEventListener('pointerup', () => {
  if (!ED.arrastre) return;
  const eraBorde = ED.arrastre.tipo === 'borde';
  ED.arrastre = null;
  if (eraBorde) { guardarAjustes(); pintarTimeline(); }
});

// ───────────── herramientas ─────────────
function seccionEn(secs, t) { return secs.findIndex(s => t >= s.a && t <= s.b); }
const herramientas = {
  cortar(it, secs, t) {
    const i = secs.findIndex(s => t - s.a > 0.15 && s.b - t > 0.15);
    if (i === -1) return toast('Pon el cabezal dentro de una sección (no en la orilla)', 'info');
    secs.splice(i, 1, { a: secs[i].a, b: t }, { a: t, b: secs[i].b });
    ED.secSel = i + 1;
    return secs;
  },
  inicio(it, secs, t) {
    let i = seccionEn(secs, t); if (i === -1) i = secs.findIndex(s => s.a > t); if (i === -1) i = ED.secSel;
    secs[i].a = clamp(t, i ? secs[i - 1].b : 0, secs[i].b - 0.2); ED.secSel = i; return secs;
  },
  fin(it, secs, t) {
    let i = seccionEn(secs, t);
    if (i === -1) { for (let j = secs.length - 1; j >= 0; j--) if (secs[j].b < t) { i = j; break; } }
    if (i === -1) i = ED.secSel;
    secs[i].b = clamp(t, secs[i].a + 0.2, i < secs.length - 1 ? secs[i + 1].a : durClip(it)); ED.secSel = i; return secs;
  },
  'quitar-seccion'(it, secs) {
    if (secs.length === 1) return toast('Queda una sola sección. Para sacar el clip usa “Quitar”.', 'info');
    secs.splice(clamp(ED.secSel, 0, secs.length - 1), 1); ED.secSel = 0; return secs;
  },
  completo(it) { ED.secSel = 0; return [{ a: 0, b: durClip(it) }]; },
};

function moverClip(k, delta) {
  const i = ED.orden.indexOf(k), j = i + delta;
  if (i < 0 || j < 0 || j >= ED.orden.length) return;
  ED.orden.splice(j, 0, ED.orden.splice(i, 1)[0]);
  sincronizarPuestos(); pintarSeleccion();
}

async function exportar(btn) {
  const ajustes = Object.fromEntries(ED.todos.map(i => {
    const k = i.archivo;
    if (!ED.orden.includes(k)) return [k, { incluir: false }];
    const e = efectivo(i);
    return [k, { incluir: true, ranking: esTop() ? puesto(k) : e.ranking, gancho: e.gancho, credito: e.credito, secciones: seccionesDe(edItem(k)) }];
  }));
  btn.disabled = true;
  try {
    if (esLista() && !S.lote.titulo.trim()) { btn.disabled = false; $('[data-ed-titulo]')?.focus(); return toast('Escribe el título del video (el texto fijo de arriba)', 'info'); }
    const capas = await generarCapas(ED.orden.map(edItem));
    for (const [k, png] of Object.entries(capas)) if (ajustes[k]) ajustes[k].capa = png;
    const job = await api('/api/lote', { method: 'POST', body: JSON.stringify({ json: S.lote.json, modo: S.lote.modo, orientacion: S.lote.orient, ajustes,
      fondo: S.lote.fondo, estilo: S.lote.estilo, titulo: S.lote.titulo, extra: S.lote.extra }) });
    toast(`${job.tipo === 'top' ? (esLista() ? 'Lista' : 'Top') : 'Lote'} en cola con ${job.encoder}. Verás el avance abajo.`, 'info');
    vid()?.pause();
    await refrescar();
  } catch (err) { toast(err.message, 'error'); }
  btn.disabled = false;
}

// ───────────── eventos ─────────────
document.addEventListener('click', e => {
  const b = e.target.closest('#editor [data-ed]'); if (!b) return;
  const accion = b.dataset.ed, it = edItem(ED.sel), v = vid();
  if (accion === 'volver') return cerrarEditor();
  if (accion === 'estilo') { S.lote.estilo = b.dataset.valor; localStorage.setItem('loteEstilo', S.lote.estilo); return render(true); }
  if (accion === 'exportar') return exportar(b);
  if (accion === 'play') return alternar();
  if (accion === 'paso' && v) { v.pause(); v.currentTime = clamp(v.currentTime + Number(b.dataset.valor), 0, durClip(it) || v.duration); return; }
  if (accion === 'anterior' || accion === 'siguiente') {
    const k = ED.orden[ED.orden.indexOf(ED.sel) + (accion === 'anterior' ? -1 : 1)];
    if (k) cargarClip(k, false);
    return;
  }
  if (accion === 'todo') {
    ED.seq = !ED.seq;
    if (ED.seq) cargarClip(ED.orden[0], true); else v?.pause();
    return pintarBotones();
  }
  if (accion === 'chip' && it) {
    (S.ajustes[it.archivo] ||= {}).credito = b.dataset.valor; guardarAjustes();
    $('[data-ed-campo="credito"]').value = b.dataset.valor; pintarOverlay();
    return;
  }
  if (accion === 'mover' && it) return moverClip(it.archivo, Number(b.dataset.valor));
  if (accion === 'quitar-clip' && it) {
    const i = ED.orden.indexOf(it.archivo);
    ED.orden.splice(i, 1);
    (S.ajustes[it.archivo] ||= {}).incluir = false;
    sincronizarPuestos();
    if (!ED.orden.length) { toast('Quitaste todos los clips', 'info'); return cerrarEditor(); }
    toast('Clip quitado del video (lo puedes volver a marcar en “← Clips”)', 'info');
    render(true);
    return cargarClip(ED.orden[Math.min(i, ED.orden.length - 1)], false);
  }
  if (herramientas[accion] && it && v) {
    const secs = herramientas[accion](it, seccionesDe(it), v.currentTime);
    if (!secs) return;
    fijarSecciones(it, secs);
    pintarTrack(); pintarTimeline();
    b.classList.add('ok-flash'); setTimeout(() => b.classList.remove('ok-flash'), 400);
  }
});

document.addEventListener('click', e => {
  const bl = e.target.closest('#editor [data-ed-bloque]');
  if (bl && bl.dataset.edBloque !== ED.sel) { ED.seq = false; cargarClip(bl.dataset.edBloque, false); pintarBotones(); }
});

document.addEventListener('input', e => {
  if (e.target.matches('#editor [data-ed-titulo]')) { S.lote.titulo = e.target.value; localStorage.setItem('loteTitulo', S.lote.titulo); return pintarOverlay(); }
  if (e.target.matches('#editor [data-ed-extra]')) { S.lote.extra = e.target.checked; localStorage.setItem('loteExtra', S.lote.extra ? 'si' : 'no'); return pintarOverlay(); }
  const c = e.target.closest('#editor [data-ed-campo]'); if (!c) return;
  const it = edItem(ED.sel); if (!it) return;
  (S.ajustes[it.archivo] ||= {})[c.dataset.edCampo] = c.value;
  guardarAjustes(); pintarOverlay();
  if (c.dataset.edCampo === 'gancho') pintarTimeline();
});

// Reordenar arrastrando en la línea de tiempo (PC)
document.addEventListener('dragstart', e => {
  const bl = e.target.closest?.('[data-ed-bloque]'); if (!bl) return;
  ED.dragK = bl.dataset.edBloque; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ED.dragK);
});
document.addEventListener('dragover', e => { if (ED.dragK && e.target.closest?.('#ed-timeline')) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (!ED.dragK) return;
  const bl = e.target.closest?.('[data-ed-bloque]');
  if (bl && bl.dataset.edBloque !== ED.dragK) {
    e.preventDefault();
    const r = bl.getBoundingClientRect(), despues = e.clientX > r.left + r.width / 2;
    ED.orden.splice(ED.orden.indexOf(ED.dragK), 1);
    ED.orden.splice(ED.orden.indexOf(bl.dataset.edBloque) + (despues ? 1 : 0), 0, ED.dragK);
    sincronizarPuestos(); pintarSeleccion();
  }
  ED.dragK = null;
});
document.addEventListener('dragend', () => { ED.dragK = null; });

// Atajos de teclado (PC): espacio = play, ← → = ±0.1 s, C = cortar
document.addEventListener('keydown', e => {
  if (!ED.abierto || S.tab !== 'gtavi' || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const v = vid(); if (!v) return;
  if (e.code === 'Space') { e.preventDefault(); alternar(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); v.pause(); v.currentTime += (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1); }
  else if (e.key.toLowerCase() === 'c') $('[data-ed="cortar"]')?.click();
});
