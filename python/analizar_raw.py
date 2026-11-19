#!/usr/bin/env python3
"""
analizar_raw.py — 1Studio · canal de gaming

Recorre Gaming/Raw y, por cada video:
  · mide la duración (ffprobe)
  · mide el pico y el volumen medio (volumedetect) y los 3 segundos más fuertes (astats)
  · transcribe el audio con faster-whisper (CUDA si hay GPU NVIDIA, si no CPU)

Escribe un JSON con los resultados (--out) y va imprimiendo eventos JSON por stdout
para que server.js muestre el progreso. Las transcripciones se guardan en caché
(--cache) para que volver a analizar sea instantáneo si el clip no cambió.

Uso:
  python analizar_raw.py --raw Gaming/Raw --out .cache/analisis_raw.json [--modelo auto|base|small]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

VIDEO_EXT = ('.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi')
CREATE_NO_WINDOW = 0x08000000 if os.name == 'nt' else 0

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def emitir(**kw):
    print(json.dumps(kw, ensure_ascii=True), flush=True)


def correr(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace',
                          creationflags=CREATE_NO_WINDOW)


# ───────────────────────── Audio / duración ─────────────────────────
def duracion(ffprobe, f):
    r = correr([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f])
    try:
        return round(float(r.stdout.strip()), 2)
    except ValueError:
        return None


def tiene_audio(ffprobe, f):
    r = correr([ffprobe, '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', f])
    return bool(r.stdout.strip())


def analizar_audio(ffmpeg, f):
    """Pico/medio global (volumedetect) + nivel pico por cada segundo (astats)."""
    filtro = ('volumedetect,aresample=16000,asetnsamples=n=16000:p=0,'
              'astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.Peak_level')
    r = correr([ffmpeg, '-hide_banner', '-nostats', '-i', f, '-vn', '-sn', '-dn', '-af', filtro, '-f', 'null', '-'])
    log = r.stderr

    def num(patron):
        m = re.search(patron, log)
        if not m or m.group(1) in ('-inf', 'inf'):
            return None
        return round(float(m.group(1)), 1)

    pico = num(r'max_volume:\s*(-?[\d.]+|-?inf) dB')
    medio = num(r'mean_volume:\s*(-?[\d.]+|-?inf) dB')

    segundos = []
    t = None
    for linea in log.splitlines():
        m = re.search(r'pts_time:\s*([\d.]+)', linea)
        if m:
            t = float(m.group(1))
            continue
        m = re.search(r'Peak_level=(-?[\d.]+|-?inf)', linea)
        if m and t is not None and 'inf' not in m.group(1):
            segundos.append((t, float(m.group(1))))
            t = None

    # Los 3 segundos más fuertes, separados al menos 3 s entre sí
    picos = []
    for ts, nivel in sorted(segundos, key=lambda x: x[1], reverse=True):
        if all(abs(ts - p['t']) >= 3 for p in picos):
            picos.append({'t': round(ts, 1), 'db': round(nivel, 1)})
        if len(picos) == 3:
            break
    picos.sort(key=lambda p: p['t'])
    return pico, medio, picos


# ───────────────────────── Whisper ─────────────────────────
def cargar_audio(ffmpeg, f, sr=16000, ss=None, t=None):
    """Decodifica con FFmpeg a mono 16 kHz float32 (lo que espera Whisper).
    Así no dependemos del lector de audio de faster-whisper (PyAV), que cambia entre versiones:
    p. ej. faster-whisper 1.2 + PyAV 19 falla con "open() got an unexpected keyword argument 'metadata_errors'"."""
    import numpy as np
    corte = (['-ss', f'{ss:.3f}'] if ss else []) + (['-t', f'{t:.3f}'] if t else [])
    r = subprocess.run([ffmpeg, '-nostdin', '-v', 'error', *corte, '-i', f, '-vn', '-sn', '-dn', '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'],
                       capture_output=True, creationflags=CREATE_NO_WINDOW)
    if r.returncode != 0:
        raise RuntimeError('FFmpeg no pudo leer el audio: ' + r.stderr.decode('utf-8', 'replace')[-300:])
    return np.frombuffer(r.stdout, dtype=np.float32).copy()


def preparar_dlls_nvidia():
    """En Windows, agrega al buscador de DLLs las librerías CUDA instaladas con pip (nvidia-cublas/cudnn)."""
    if os.name != 'nt':
        return
    try:
        import nvidia  # paquete de espacio de nombres de nvidia-*-cu12
        for base in list(getattr(nvidia, '__path__', [])):
            for sub in os.listdir(base):
                carpeta = os.path.join(base, sub, 'bin')
                if os.path.isdir(carpeta):
                    os.add_dll_directory(carpeta)
                    os.environ['PATH'] = carpeta + os.pathsep + os.environ.get('PATH', '')
    except Exception:
        pass


def hay_cuda():
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


class Transcriptor:
    def __init__(self, modelo_pedido, ffmpeg='ffmpeg'):
        self.modelo_pedido = modelo_pedido
        self.ffmpeg = ffmpeg
        self.modelo = None
        self.dispositivo = None
        self.nombre = None
        self.disponible = True
        try:
            import faster_whisper  # noqa: F401
        except Exception:
            self.disponible = False

    def _cargar(self, dispositivo):
        from faster_whisper import WhisperModel
        nombre = self.modelo_pedido if self.modelo_pedido in ('base', 'small') else ('small' if dispositivo == 'cuda' else 'base')
        emitir(tipo='modelo', modelo=nombre, dispositivo=dispositivo)
        compute = 'float16' if dispositivo == 'cuda' else 'int8'
        self.modelo = WhisperModel(nombre, device=dispositivo, compute_type=compute)
        self.dispositivo, self.nombre = dispositivo, nombre

    def asegurar(self):
        if self.modelo is not None:
            return
        preparar_dlls_nvidia()
        if hay_cuda():
            try:
                self._cargar('cuda')
                return
            except Exception as e:
                emitir(tipo='aviso', mensaje=f'CUDA no disponible para Whisper ({str(e)[:160]}); uso CPU.')
        self._cargar('cpu')

    def transcribir(self, f):
        self.asegurar()
        try:
            return self._transcribir(f)
        except Exception as e:
            if self.dispositivo == 'cuda':
                # Típico en Windows: faltan cuDNN/cuBLAS → reintenta en CPU
                emitir(tipo='aviso', mensaje=f'Falló Whisper en GPU ({str(e)[:160]}); reintento en CPU.')
                self.modelo = None
                self._cargar('cpu')
                return self._transcribir(f)
            raise

    def _transcribir(self, f):
        segmentos, info = self.modelo.transcribe(cargar_audio(self.ffmpeg, f), beam_size=5, vad_filter=True,
                                                 vad_parameters={'min_silence_duration_ms': 500})
        segs = [{'ini': round(s.start, 1), 'fin': round(s.end, 1), 'texto': s.text.strip()}
                for s in segmentos if s.text.strip()]
        return segs, getattr(info, 'language', None)


# ───────────────────────── Principal ─────────────────────────
def main():
    ap = argparse.ArgumentParser(description='Analiza Gaming/Raw para Claude')
    ap.add_argument('--raw', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--cache', default=None)
    ap.add_argument('--modelo', default='auto', choices=['auto', 'base', 'small'])
    ap.add_argument('--ffmpeg', default='ffmpeg')
    ap.add_argument('--ffprobe', default='ffprobe')
    args = ap.parse_args()

    archivos = sorted(f for f in os.listdir(args.raw)
                      if f.lower().endswith(VIDEO_EXT) and not f.startswith('.')
                      and os.path.isfile(os.path.join(args.raw, f)))
    n = len(archivos)
    emitir(tipo='inicio', n=n)

    cache = {}
    if args.cache and os.path.exists(args.cache):
        try:
            with open(args.cache, encoding='utf-8') as fh:
                cache = json.load(fh)
        except Exception:
            cache = {}

    tr = Transcriptor(args.modelo, args.ffmpeg)
    if not tr.disponible:
        emitir(tipo='aviso', mensaje='faster-whisper no está instalado: el análisis sigue sin transcripción '
                                     '(instálalo con: pip install faster-whisper).')

    clips = []
    for i, nombre in enumerate(archivos, 1):
        f = os.path.join(args.raw, nombre)
        emitir(tipo='progreso', i=i, n=n, archivo=nombre, fase='midiendo audio')
        st = os.stat(f)
        clip = {'archivo': nombre, 'tamano': st.st_size, 'duracion': duracion(args.ffprobe, f),
                'pico_db': None, 'medio_db': None, 'picos': [], 'idioma': None, 'segmentos': []}

        con_audio = tiene_audio(args.ffprobe, f)
        if con_audio:
            clip['pico_db'], clip['medio_db'], clip['picos'] = analizar_audio(args.ffmpeg, f)

        if con_audio and tr.disponible:
            emitir(tipo='progreso', i=i, n=n, archivo=nombre, fase='transcribiendo')
            clave = f'{nombre}|{st.st_size}|{int(st.st_mtime)}|{args.modelo}'
            if clave in cache:
                clip['segmentos'], clip['idioma'] = cache[clave]['segmentos'], cache[clave]['idioma']
            else:
                try:
                    clip['segmentos'], clip['idioma'] = tr.transcribir(f)
                    cache[clave] = {'segmentos': clip['segmentos'], 'idioma': clip['idioma']}
                except Exception as e:
                    clip['transcripcion_error'] = str(e)[:200]
                    emitir(tipo='aviso', mensaje=f'No pude transcribir {nombre}: {str(e)[:160]}')
        elif con_audio and not tr.disponible:
            clip['transcripcion_error'] = 'faster-whisper no instalado'

        clips.append(clip)
        emitir(tipo='progreso', i=i, n=n, archivo=nombre, fase='listo')

    if args.cache:
        vigentes = {f'{c["archivo"]}|' for c in clips}
        cache = {k: v for k, v in cache.items() if any(k.startswith(p) for p in vigentes)}
        os.makedirs(os.path.dirname(os.path.abspath(args.cache)), exist_ok=True)
        with open(args.cache, 'w', encoding='utf-8') as fh:
            json.dump(cache, fh, ensure_ascii=False)

    resultado = {
        'generado': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'whisper': tr.disponible,
        'modelo': tr.nombre,
        'dispositivo': tr.dispositivo,
        'clips': clips,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    tmp = args.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(resultado, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, args.out)
    emitir(tipo='fin', salida=args.out, n=n)


if __name__ == '__main__':
    main()
