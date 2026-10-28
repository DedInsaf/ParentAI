import unittest
from transcripts import validated_transcript


class TranscriptTests(unittest.TestCase):
    def test_decoder_loops_are_rejected_instead_of_becoming_a_question(self):
        for text in ['Спасибо. ' * 77, 'Да, НЕТ! ' * 12,
                     'Спасибо за просмотр. ' * 12,
                     'Пожалуйста, помоги. ' + 'спасибо ' * 40]:
            with self.subTest(text=text[:30]), self.assertRaises(ValueError):
                validated_transcript(text)

    def test_ordinary_questions_short_repetitions_and_math_are_preserved(self):
        for text in ['Спасибо, спасибо!', 'Да да да',
                     'Один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать']:
            self.assertEqual(validated_transcript(' ' + text + ' '), text)

    def test_empty_and_invalid_output_is_rejected(self):
        for text in [None, '', '   ', {}, []]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                validated_transcript(text)
