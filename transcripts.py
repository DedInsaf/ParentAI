"""Reject empty and degenerate speech-decoder output before tutoring."""
import re
from arithmetic_transcript import normalize_arithmetic


def validated_transcript(text):
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Не разобрал вопрос. Повтори его или напиши текстом.')
    text = text.strip()
    words = re.findall(r'[а-яёa-z0-9]+', text.lower())
    # Whisper can turn background noise into dozens of repeated words. Keep
    # ordinary short repetitions and arithmetic sequences; reject only a
    # dominant consecutive loop, never truncate it into an invented question.
    for width in range(1, 7):
        for offset in range(width):
            previous, run = None, 0
            for start in range(offset, len(words) - width + 1, width):
                block = words[start:start + width]
                run = run + width if block == previous else width
                previous = block
                if run >= max(12, width * 4) and run >= len(words) * .65:
                    raise ValueError('Не разобрал вопрос: в записи получились повторы. Повтори его или напиши текстом.')
    return normalize_arithmetic(text)
