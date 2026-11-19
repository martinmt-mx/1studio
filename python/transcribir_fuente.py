#!/usr/bin/env python3
"""
transcribir_fuente.py — 1Studio · Buscador en fuentes

Transcribe el audio de un VOD largo (horas) con faster-whisper, por pedazos de 10 minutos
(así no se carga todo el audio en memoria), y guarda frases con su tiempo para poder buscar
"lo que dijo el streamer" y saltar a ese momento.

Uso: python transcribir_fuente.py --audio audio.m4a --out transcripcion.json [--modelo auto|base|small]
"""
import argparse
import json
import os
import subprocess
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analizar_raw import emitir, preparar_dlls_nvidia, hay_cuda, cargar_audio, CREATE_NO_WINDOW  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

PEDAZO = 600  # segundos


def duracion(ffprobe, f):
    r = subprocess.run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f],
                       capture_output=True, text=True, creationflags=CREATE_NO_WINDOW)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def cargar_modelo(pedido):
    from faster_whisper import WhisperModel
    preparar_dlls_nvidia()
    for disp in (['cuda'] if hay_cuda() else []) + ['cpu']:
        nombre = pedido if pedido in ('base', 'small', 'medium') else ('small' if disp == 'cuda' else 'base')
        try:
            m = WhisperModel(nombre, device=disp, compute_type='float16' if disp == 'cuda' else 'int8')
            emitir(tipo='modelo', modelo=nombre, dispositivo=disp)
            return m, nombre, disp
        except Exception as e:
            emitir(tipo='aviso', mensaje=f'Whisper no cargó en {disp.upper()}: {str(e)[:200]}')
    raise RuntimeError('No se pudo cargar Whisper')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--modelo', default='auto')
    ap.add_argument('--ffmpeg', default='ffmpeg')
    ap.add_argument('--ffprobe', default='ffprobe')
    a = ap.parse_args()

    total = duracion(a.ffprobe, a.audio)
    if not total:
        raise SystemExit('No pude leer la duración del audio.')
    emitir(tipo='inicio', duracion=total)
    modelo, nombre, disp = cargar_modelo(a.modelo)
    idioma = None
    segmentos = []
    t = 0.0
    while t < total:
        largo = min(PEDAZO, total - t)
        muestras = cargar_audio(a.ffmpeg, a.audio, ss=t, t=largo)
        try:
            segs, info = modelo.transcribe(muestras, language=idioma, vad_filter=True, beam_size=1,
                                           condition_on_previous_text=False)
            lista = list(segs)
        except Exception as e:
            if disp != 'cuda':
                raise
            emitir(tipo='aviso', mensaje=f'Whisper falló en GPU ({str(e)[:160]}); sigo en CPU.')
            modelo, nombre, disp = cargar_modelo('base')
            segs, info = modelo.transcribe(muestras, language=idioma, vad_filter=True, beam_size=1,
                                           condition_on_previous_text=False)
            lista = list(segs)
        if idioma is None:
            idioma = getattr(info, 'language', None)   # se detecta en el primer pedazo y se mantiene
        for s in lista:
            texto = s.text.strip()
            if texto:
                segmentos.append({'s': round(t + s.start, 2), 'e': round(t + s.end, 2), 't': texto})
        t += largo
        emitir(tipo='progreso', t=t, total=total)

    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump({'origen': 'whisper', 'idioma': idioma, 'modelo': nombre, 'dispositivo': disp,
                   'duracion': total, 'segmentos': segmentos}, fh, ensure_ascii=False)
    os.replace(tmp, a.out)
    emitir(tipo='fin', segmentos=len(segmentos))


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
