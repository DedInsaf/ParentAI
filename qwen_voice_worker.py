"""One bounded Qwen3-TTS CPU worker using the existing voice-engine protocol."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time


def generation_budget(text):
    """Bound CPU time while leaving enough 12 Hz audio tokens for a phrase."""
    return max(192, min(384, len(text) * 3))


def create_voice_prompt(model, reference):
    """Clone identity without letting reference words leak into new speech."""
    return model.create_voice_clone_prompt(
        ref_audio=str(reference), ref_text=None, x_vector_only_mode=True)


def load_model():
    import torch
    from qwen_tts import Qwen3TTSModel

    torch.set_num_threads(max(1, min(2, os.cpu_count() or 1)))
    torch.set_num_interop_threads(1)
    model_path = os.getenv(
        "PARENTAI_QWEN_MODEL",
        str(Path(__file__).resolve().parent / "data/models/qwen3-tts-0.6b-base"),
    )
    return Qwen3TTSModel.from_pretrained(
        model_path, device_map="cpu", dtype=torch.float32,
        attn_implementation="sdpa",
    )


def serve(directory):
    import numpy as np
    import soundfile as sf
    from lipsync import timeline
    from runtime import atomic_json

    directory = Path(directory)
    model = load_model()
    atomic_json(directory / "ready.json", {"ok": True, "device": "cpu", "provider": "qwen"})
    cached_key = None
    cached_prompt = None
    last_activity = time.monotonic()
    idle_seconds = max(15, int(os.getenv("PARENTAI_QWEN_IDLE_SECONDS", "45")))

    while True:
        requests = sorted(directory.glob("*.request.json"), key=lambda path: path.stat().st_mtime)
        if not requests:
            if time.monotonic() - last_activity > idle_seconds:
                return
            time.sleep(.08)
            continue
        request = requests[0]
        value = json.loads(request.read_text(encoding="utf-8"))
        request.unlink(missing_ok=True)
        output = Path(value["output"])
        output.mkdir(exist_ok=True)
        manifest = {"state": "speaking", "chunks": []}
        try:
            references = value.get("references", value.get("reference"))
            if isinstance(references, str):
                references = [references]
            references = [Path(path) for path in references or []]
            if not references:
                raise ValueError("Не найден образец голоса родителя.")
            reference = references[0]
            digest = hashlib.sha256(reference.read_bytes()).digest()
            if digest != cached_key:
                # ICL mode can leak the tail of the reference recording into
                # the new reply. Speaker-vector mode trades a little likeness
                # for reliably speaking the requested text.
                cached_prompt = create_voice_prompt(model, reference)
                cached_key = digest
            text = str(value.get("text") or "").strip()
            if not text:
                manifest["state"] = "done"
                atomic_json(output / "stream.json", manifest)
                last_activity = time.monotonic()
                continue
            wavs, sample_rate = model.generate_voice_clone(
                text=text, language="Russian", voice_clone_prompt=cached_prompt,
                # Greedy decoding frequently became monotonous, garbled or
                # failed to emit EOS. These are the Qwen authors' generation
                # defaults and give the codec predictor natural variation.
                do_sample=True, top_k=50, top_p=1.0, temperature=.9,
                repetition_penalty=1.05,
                subtalker_dosample=True, subtalker_top_k=50,
                subtalker_top_p=1.0, subtalker_temperature=.9,
                max_new_tokens=generation_budget(text),
            )
            audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            if not len(audio) or not np.isfinite(audio).all():
                raise ValueError("Qwen вернул пустое аудио.")
            sf.write(output / "chunk-0.wav", audio, sample_rate)
            sf.write(output / "phrase-0.wav", audio, sample_rate)
            manifest["chunks"].append({
                "file": "chunk-0.wav",
                "cues": timeline(output / "chunk-0.wav", text),
            })
            manifest["state"] = "done"
            atomic_json(output / "stream.json", manifest)
            last_activity = time.monotonic()
        except Exception as exc:
            manifest.update(
                state="error",
                error=f"Qwen не смог озвучить ответ: {str(exc)[:180]}",
            )
            atomic_json(output / "stream.json", manifest)


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--serve":
        raise SystemExit("usage: qwen_voice_worker.py --serve DIRECTORY")
    target = Path(sys.argv[2])
    try:
        serve(target)
    except Exception as exc:
        from runtime import atomic_json
        atomic_json(target / "fatal.json", {"error": str(exc)[:300], "provider": "qwen"})
        raise
