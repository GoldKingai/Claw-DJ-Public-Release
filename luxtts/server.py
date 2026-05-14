"""
LuxTTS Microservice — FastAPI wrapper around LuxTTS (ZipVoice-based)
Provides the REST API that LLM Gateway's luxtts provider calls.

Start with:
    python server.py
    # or: uvicorn server:app --host 127.0.0.1 --port 5002

Voices:
    Drop reference WAV/MP3 files into the voices/ directory.
    The filename (without extension) becomes the voice_id.
    Example: voices/ayla.wav → voice_id "ayla"
"""

from __future__ import annotations

import base64
import io
import os
import tempfile
from pathlib import Path
from threading import Lock
from typing import Optional

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("LUXTTS_PORT", 5002))
HOST = os.environ.get("LUXTTS_HOST", "127.0.0.1")
DEVICE = os.environ.get("LUXTTS_DEVICE", "cuda")  # cuda | cpu | mps
THREADS = int(os.environ.get("LUXTTS_THREADS", 4))   # cpu thread count
MODEL_PATH = os.environ.get("LUXTTS_MODEL", "YatharthS/LuxTTS")
VOICES_DIR = Path(os.environ.get("LUXTTS_VOICES_DIR", Path(__file__).parent / "voices"))

# ---------------------------------------------------------------------------
# Model + voice cache (loaded once at startup)
# ---------------------------------------------------------------------------

print(f"[LuxTTS] Loading model {MODEL_PATH!r} on {DEVICE}...")
from zipvoice.luxvoice import LuxTTS  # noqa: E402 (import after config)

_tts = LuxTTS(MODEL_PATH, device=DEVICE, threads=THREADS)
_voice_cache: dict[str, dict] = {}   # voice_id → encoded_prompt dict
_cache_lock = Lock()
print("[LuxTTS] Model ready.")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wav_extension(path: Path) -> bool:
    return path.suffix.lower() in {".wav", ".mp3", ".flac", ".ogg", ".m4a"}


def _load_voice(voice_id: str) -> dict:
    """Return cached encoded prompt for a voice, loading on first access."""
    with _cache_lock:
        if voice_id in _voice_cache:
            return _voice_cache[voice_id]

    # Find the voice file
    wav_path: Optional[Path] = None
    for ext in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
        candidate = VOICES_DIR / f"{voice_id}{ext}"
        if candidate.exists():
            wav_path = candidate
            break

    if wav_path is None:
        raise HTTPException(
            status_code=404,
            detail=f"Voice '{voice_id}' not found. Add {voice_id}.wav to {VOICES_DIR}/",
        )

    encoded = _tts.encode_prompt(str(wav_path))
    with _cache_lock:
        _voice_cache[voice_id] = encoded
    return encoded


def _encode_speaker_wav_bytes(wav_bytes: bytes) -> dict:
    """Encode a raw WAV/audio buffer (e.g. from base64 upload) into a prompt dict."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav_bytes)
        tmp_path = tmp.name
    try:
        return _tts.encode_prompt(tmp_path)
    finally:
        os.unlink(tmp_path)


def _to_wav_bytes(wav_tensor, sample_rate: int = 48000) -> bytes:
    """Convert LuxTTS output tensor to WAV bytes."""
    audio = wav_tensor.numpy().squeeze()
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="LuxTTS", version="1.0.0")


class SynthesizeRequest(BaseModel):
    text: str
    voice_id: Optional[str] = None
    speaker_wav: Optional[str] = None   # base64-encoded audio bytes
    language: Optional[str] = "en"
    num_steps: Optional[int] = 4
    guidance_scale: Optional[float] = 3.0
    t_shift: Optional[float] = 0.5
    speed: Optional[float] = 1.0


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_PATH, "device": DEVICE}


@app.get("/voices")
def list_voices():
    voices = []
    if VOICES_DIR.is_dir():
        for f in sorted(VOICES_DIR.iterdir()):
            if f.is_file() and _wav_extension(f):
                voice_id = f.stem
                voices.append({
                    "id": voice_id,
                    "name": voice_id.replace("_", " ").title(),
                    "category": "cloned",
                    "description": f"Voice cloned from {f.name}",
                })
    return {"voices": voices}


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    # Resolve encoded voice prompt
    if req.speaker_wav:
        # Caller provided raw audio as base64
        try:
            wav_bytes = base64.b64decode(req.speaker_wav)
        except Exception:
            raise HTTPException(status_code=400, detail="speaker_wav must be valid base64")
        encoded = _encode_speaker_wav_bytes(wav_bytes)
    elif req.voice_id:
        encoded = _load_voice(req.voice_id)
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide voice_id (preset) or speaker_wav (base64 audio) for voice cloning.",
        )

    # Synthesize
    wav_tensor = _tts.generate_speech(
        text=req.text,
        encode_dict=encoded,
        num_steps=req.num_steps or 4,
        guidance_scale=req.guidance_scale or 3.0,
        t_shift=req.t_shift or 0.5,
        speed=req.speed or 1.0,
    )

    wav_bytes = _to_wav_bytes(wav_tensor, sample_rate=48000)
    return Response(content=wav_bytes, media_type="audio/wav")


@app.delete("/voices/{voice_id}/cache")
def evict_voice_cache(voice_id: str):
    """Force re-encode a voice on next use (e.g. after replacing the WAV file)."""
    with _cache_lock:
        removed = _voice_cache.pop(voice_id, None)
    return {"evicted": removed is not None, "voice_id": voice_id}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
