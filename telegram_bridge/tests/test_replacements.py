import unittest

from telegram_bridge.replacements import apply_replacements


class ReplacementTests(unittest.TestCase):
    def test_combined_phrase_handles_hidden_format_chars(self) -> None:
        self.assertEqual(
            apply_replacements("星辰社\u200c区 xcsq.me", {"星辰社区 xcsq.me": "猛a社"}),
            "猛a社",
        )

    def test_split_rules_ignore_hidden_chars_and_case(self) -> None:
        self.assertEqual(
            apply_replacements(
                "星辰社\u200c区 Xcsq.me",
                {"星辰社区": "猛a社", "xcsq.me": "猛A社"},
            ),
            "猛a社 猛A社",
        )


if __name__ == "__main__":
    unittest.main()
