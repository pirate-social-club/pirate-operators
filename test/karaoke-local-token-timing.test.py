"""Boundary checks using synthetic token timings. No recognizer or model is loaded."""
import runpy
import unittest
from pathlib import Path

helper = runpy.run_path(str(Path(__file__).resolve().parents[1] / "harness/karaoke-local-tokens.py"))
append_word = helper["append_word"]
NativeFailure = helper["NativeFailure"]


class NativeTokenTimingTest(unittest.TestCase):
    def test_intersects_only_a_measured_boundary_tick(self):
        words = []
        append_word(words, [(b"fixture", 40, 100, 0.9)], 95 * 32 + 16)
        self.assertEqual([(word["startMs"], word["endMs"]) for word in words], [(40, 95)])

    def test_rejects_wider_overrun_and_unmeasured_intervals(self):
        for start, end in [(-10, 80), (50, 40), (40, 40), (40, 110), (100, 100)]:
            with self.subTest(start=start, end=end):
                with self.assertRaises(NativeFailure) as error:
                    append_word([], [(b"fixture", start, end, 0.9)], 95 * 32 + 16)
                self.assertEqual(error.exception.code, 69)


if __name__ == "__main__":
    unittest.main()
