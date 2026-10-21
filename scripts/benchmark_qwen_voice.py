#!/usr/bin/env python3
"""Run one private Qwen3-TTS voice-clone benchmark on CPU."""
import argparse
import json
import resource
import time
from pathlib import Path


DEFAULT_REFERENCE_TEXT = (
    "Сегодня мы спокойно разберём задание по шагам. Сначала прочитаем условие, "
    "затем найдём главное и подумаем, с чего лучше начать. Не торопись, говори "
    "ясно и делай небольшие паузы."
)


def generation_budget(text):
    return max(192, min(384, len(text) * 3))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--reference-text", default=DEFAULT_REFERENCE_TEXT)
    parser.add_argument("--x-vector-only", action="store_true")
    parser.add_argument(
        "--text",
        default="Отлично, ты идёшь верным путём. Давай сделаем следующий шаг вместе.",
    )
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--max-new-tokens", type=int)
    args = parser.parse_args()

    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    torch.set_num_threads(max(1, args.threads))
    torch.set_num_interop_threads(1)
    started = time.monotonic()
    model = Qwen3TTSModel.from_pretrained(
        args.model,
        device_map="cpu",
        dtype=torch.float32,
        attn_implementation="sdpa",
    )
    loaded = time.monotonic()
    prompt = model.create_voice_clone_prompt(
        ref_audio=args.reference,
        ref_text=None if args.x_vector_only else args.reference_text,
        x_vector_only_mode=args.x_vector_only,
    )
    prepared = time.monotonic()
    wavs, sample_rate = model.generate_voice_clone(
        text=args.text,
        language="Russian",
        voice_clone_prompt=prompt,
        do_sample=True,
        top_k=50,
        top_p=1.0,
        temperature=.9,
        repetition_penalty=1.05,
        subtalker_dosample=True,
        subtalker_top_k=50,
        subtalker_top_p=1.0,
        subtalker_temperature=.9,
        max_new_tokens=args.max_new_tokens or generation_budget(args.text),
    )
    finished = time.monotonic()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output, wavs[0], sample_rate)
    duration = len(wavs[0]) / sample_rate
    print(json.dumps({
        "model_load_seconds": round(loaded - started, 2),
        "prompt_seconds": round(prepared - loaded, 2),
        "generation_seconds": round(finished - prepared, 2),
        "audio_seconds": round(duration, 2),
        "realtime_factor": round((finished - prepared) / max(duration, .01), 2),
        "max_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "sample_rate": sample_rate,
        "output": str(output),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
