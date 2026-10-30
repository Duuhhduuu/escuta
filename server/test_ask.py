#!/usr/bin/env python3
"""Testes da rota de perguntas sobre uma reunião (answer_question), sem modelo nem rede.

    python server/test_ask.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402


class AnswerQuestion(unittest.TestCase):
    def setUp(self):
        self.seen = {}
        self._complete = server.complete

        def fake(system, user, model, timeout):
            self.seen.update(system=system, user=user, model=model)
            return "  Resposta [01:00].  "

        server.complete = fake

    def tearDown(self):
        server.complete = self._complete

    def test_sends_context_history_and_question_and_trims_the_answer(self):
        out = server.answer_question(
            {
                "question": "Quem cobra o time?",
                "segments": [{"who": "voce", "start": 60, "end": 63, "text": "eu cobro o time"}],
                "minutes": "# T\n\n## Decisões\n- A",
                "history": [{"role": "user", "content": "oi"}],
            }
        )
        self.assertEqual(out, {"answer": "Resposta [01:00]."})
        self.assertIn("[01:00] Você: eu cobro o time", self.seen["user"])
        self.assertIn("Pessoa: oi", self.seen["user"])
        self.assertTrue(self.seen["user"].rstrip().endswith("Quem cobra o time?"))
        self.assertIn("Não invente", self.seen["system"])

    def test_rejects_empty_question_or_empty_meeting(self):
        for bad in ({}, {"question": "  ", "minutes": "x"}, {"question": "x"}):
            with self.assertRaises(server.ApiError):
                server.answer_question(bad)


if __name__ == "__main__":
    unittest.main()
