#!/usr/bin/env python3
"""
alinear_voz.py — 1Studio · Video largo

Recibe la voz completa (un solo audio) y el guion dividido en secciones, y calcula:
  · en qué segundo empieza y termina cada sección
  · el tiempo de cada palabra DEL GUION (para subtítulos exactos, sin errores de transcripción)

Cómo: transcribe con faster-whisper (tiempos por palabra) y alinea esas palabras con las del guion
(difflib). Las palabras que Whisper no reconoce igual (números, nombres) se interpolan entre sus vecinas.
Sin faster-whisper, reparte el audio en proporción al largo de cada sección (aproximado).

Uso: python alinear_voz.py --audio voz.wav --guion guion.json --out alineacion.json [--modelo auto|base|small]
"""
import argparse
import datetime
import difflib
import traceback
import json
import os
import re
import subprocess
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analizar_raw import emitir, preparar_dlls_nvidia, hay_cuda, cargar_audio, CREATE_NO_WINDOW  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


AVISOS = []
LOG = None


def log(texto):
    if LOG:
        with open(LOG, 'a', encoding='utf-8') as fh:
            fh.write(f'[{datetime.datetime.now():%H:%M:%S}] {texto}\n')


def aviso(mensaje):
    AVISOS.append(mensaje)
    log('AVISO: ' + mensaje)
    emitir(tipo='aviso', mensaje=mensaje)


def norm(w):
    w = unicodedata.normalize('NFD', w.lower())
    w = ''.join(c for c in w if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9ñ]', '', w)


def _instalado(md, k):
    try:
        md.version(k)
        return True
    except Exception:
        return False


def duracion(ffprobe, f):
    r = subprocess.run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f],
                       capture_output=True, text=True, creationflags=CREATE_NO_WINDOW)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def transcribir(audio, modelo_pedido, ffmpeg):
    from faster_whisper import WhisperModel
    preparar_dlls_nvidia()
    muestras = cargar_audio(ffmpeg, audio)   # se decodifica una sola vez, con FFmpeg
    log(f'Audio decodificado: {len(muestras) / 16000:.1f} s')
    intentos = (['cuda'] if hay_cuda() else []) + ['cpu']
    ultimo = None
    for disp in intentos:
        nombre = modelo_pedido if modelo_pedido in ('base', 'small', 'medium') else ('small' if disp == 'cuda' else 'base')
        try:
            emitir(tipo='modelo', modelo=nombre, dispositivo=disp)
            m = WhisperModel(nombre, device=disp, compute_type='float16' if disp == 'cuda' else 'int8')
            segs, _ = m.transcribe(muestras, language='es', word_timestamps=True, vad_filter=True, beam_size=5)
            palabras = []
            for s in segs:
                for w in (s.words or []):
                    palabras.append({'w': w.word.strip(), 's': float(w.start), 'e': float(w.end)})
                emitir(tipo='progreso', t=float(s.end))
            return palabras, nombre, disp
        except Exception as e:  # típico en Windows: faltan cuDNN/cuBLAS → CPU
            ultimo = e
            log(f'Whisper falló en {disp}:\n' + traceback.format_exc())
            aviso(f'Whisper falló en {disp.upper()}: {str(e)[:300]}')
    raise ultimo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--guion', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--modelo', default='auto')
    ap.add_argument('--ffprobe', default='ffprobe')
    ap.add_argument('--ffmpeg', default='ffmpeg')
    a = ap.parse_args()
    global LOG
    LOG = os.path.join(os.path.dirname(os.path.abspath(a.out)), 'alineacion.log')
    try:
        import platform, importlib.metadata as md
        versiones = {k: md.version(k) for k in ('faster-whisper', 'ctranslate2', 'av', 'onnxruntime') if _instalado(md, k)}
        log(f'--- inicio · Python {platform.python_version()} · {platform.platform()} · {versiones} · cuda={hay_cuda()}')
    except Exception:
        log('--- inicio')

    with open(a.guion, encoding='utf-8') as fh:
        secciones = json.load(fh)
    dur = duracion(a.ffprobe, a.audio)
    emitir(tipo='inicio', duracion=dur)

    # Palabras del guion (las que tienen letras o números), con su sección
    guion = []
    for si, s in enumerate(secciones):
        for w in str(s.get('narracion', '')).split():
            if norm(w):
                guion.append({'w': w, 'n': norm(w), 'sec': si, 's': None, 'e': None})
    if not guion:
        raise SystemExit('El guion no tiene narración.')

    aproximado = False
    modelo = disp = None
    try:
        import faster_whisper  # noqa: F401
        audio_w, modelo, disp = transcribir(a.audio, a.modelo, a.ffmpeg)
    except ImportError:
        audio_w = []
        aviso('faster-whisper no está instalado: reparto aproximado por largo de texto.')
    except Exception as e:
        audio_w = []
        log('No se pudo transcribir:\n' + traceback.format_exc())
        aviso(f'No se pudo transcribir ({str(e)[:300]}): reparto aproximado.')

    if audio_w:
        an = [norm(x['w']) for x in audio_w]
        sm = difflib.SequenceMatcher(None, [g['n'] for g in guion], an, autojunk=False)
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                g, x = guion[blk.a + k], audio_w[blk.b + k]
                g['s'], g['e'] = x['s'], x['e']
        coincidencia = sum(1 for g in guion if g['s'] is not None) / len(guion)
        log(f'Transcripción OK: {len(audio_w)} palabras · coincidencia {coincidencia:.0%}')
        if coincidencia < 0.6:
            aviso(f'Coincidencia guion ↔ voz baja: {coincidencia:.0%}')
    else:
        coincidencia = 0.0
        aproximado = True
        # reparto proporcional al número de letras
        total = sum(len(g['w']) for g in guion) or 1
        t = 0.0
        for g in guion:
            d = dur * len(g['w']) / total
            g['s'], g['e'] = t, t + d * 0.9
            t += d

    # Interpolar las palabras sin tiempo entre sus vecinas con tiempo
    idx = [i for i, g in enumerate(guion) if g['s'] is not None]
    for i, g in enumerate(guion):
        if g['s'] is not None:
            continue
        prev = max((j for j in idx if j < i), default=None)
        nxt = min((j for j in idx if j > i), default=None)
        t_ini = guion[prev]['e'] if prev is not None else 0.0
        t_fin = guion[nxt]['s'] if nxt is not None else dur
        i0 = prev if prev is not None else -1
        i1 = nxt if nxt is not None else len(guion)
        paso = (t_fin - t_ini) / (i1 - i0)
        g['s'] = t_ini + paso * (i - i0)
        g['e'] = g['s'] + paso * 0.9

    # Límites de sección: un poco antes de la primera palabra de cada sección; secciones contiguas
    primeras = {}
    for g in guion:
        primeras.setdefault(g['sec'], g['s'])
    limites = [0.0]
    for si in range(1, len(secciones)):
        t = primeras.get(si)
        if t is None:
            t = limites[-1]
        limites.append(max(limites[-1] + 0.3, t - 0.06))
    limites.append(max(dur, limites[-1] + 0.3))
    out_sec = [{'id': s.get('id', i + 1), 't0': round(limites[i], 3), 't1': round(limites[i + 1], 3)} for i, s in enumerate(secciones)]

    resultado = {
        'duracion': round(dur, 3), 'aproximado': aproximado, 'coincidencia': round(coincidencia, 3),
        'modelo': modelo, 'dispositivo': disp, 'secciones': out_sec, 'avisos': AVISOS,
        'palabras': [{'w': g['w'], 's': round(g['s'], 3), 'e': round(g['e'], 3), 'sec': g['sec']} for g in guion],
    }
    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(resultado, fh, ensure_ascii=False)
    os.replace(tmp, a.out)
    emitir(tipo='fin', secciones=len(out_sec))


if __name__ == '__main__':
    main()
