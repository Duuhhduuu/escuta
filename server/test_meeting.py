#!/usr/bin/env python3
"""Testes da lógica de reunião. Não precisam de Whisper, GPU nem rede.

    python server/test_meeting.py
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import meeting  # noqa: E402


def seg(start, end, text, who=None):
    return {"start": start, "end": end, "text": text, **({"who": who} if who else {})}


class Templates(unittest.TestCase):
    def test_all_shipped_templates_are_valid(self):
        templates = meeting.load_templates()
        self.assertGreaterEqual(len(templates), 6)
        self.assertIn("reuniao", templates)
        self.assertIn("aula", templates)

    def test_invalid_template_is_skipped_not_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            open(os.path.join(tmp, "ruim.json"), "w", encoding="utf-8").write('{"name": "x", "sections": []}')
            open(os.path.join(tmp, "quebrado.json"), "w", encoding="utf-8").write("{nao e json")
            open(os.path.join(tmp, "bom.json"), "w", encoding="utf-8").write(
                '{"name": "Bom", "sections": [{"title": "A", "instruction": "faça", "format": "list"}]}'
            )
            self.assertEqual(list(meeting.load_templates(tmp)), ["bom"])

    def test_missing_folder_is_empty(self):
        self.assertEqual(meeting.load_templates("/nao/existe"), {})

    def test_prompt_lists_every_section_and_instruction(self):
        template = meeting.load_templates()["reuniao"]
        prompt = meeting.minutes_prompt(template, "pt")
        for section in template["sections"]:
            self.assertIn(section["title"], prompt)
        self.assertIn("português do Brasil", prompt)
        for section in template["sections"]:
            self.assertIn(section["instruction"].rstrip("."), prompt)  # a instrução de cada seção vai junto

    def test_notes_rule_only_when_there_are_notes(self):
        template = meeting.load_templates()["reuniao"]
        sem = meeting.minutes_prompt(template, "pt")
        com = meeting.minutes_prompt(template, "pt", notes=True)
        self.assertNotIn("Anotações de quem gravou", sem)
        self.assertIn("Anotações de quem gravou", com)
        # a numeração das regras continua sem buracos nos dois casos
        for prompt in (sem, com):
            numbers = [int(line.split(".")[0]) for line in prompt.split(chr(10)) if line[:1].isdigit() and line[1:3] == ". "]
            self.assertEqual(numbers, list(range(1, len(numbers) + 1)))

    def test_language_is_respected(self):
        template = meeting.load_templates()["reuniao"]
        self.assertIn("inglês", meeting.minutes_prompt(template, "en"))
        self.assertIn("mesmo idioma", meeting.minutes_prompt(template, "auto"))
        self.assertIn("português do Brasil", meeting.minutes_prompt(template, "xx"))  # desconhecido cai no padrão


class Transcript(unittest.TestCase):
    def test_stamp(self):
        self.assertEqual(meeting.stamp(5), "00:05")
        self.assertEqual(meeting.stamp(83.9), "01:23")
        self.assertEqual(meeting.stamp(3725), "1:02:05")

    def test_format_uses_labels_and_skips_empty(self):
        text = meeting.format_transcript(
            [seg(1, 2, " Oi ", "voce"), seg(3, 4, "   ", "outros"), seg(65, 70, "Olá", "outros")]
        )
        self.assertEqual(text, "[00:01] Você: Oi\n[01:05] Participantes: Olá")


class Live(unittest.TestCase):
    def test_keeps_real_speech_and_trims(self):
        out = meeting.clean_live([{"start": 0.0, "end": 2.0, "text": " Bom dia a todos. ", "no_speech": 0.01, "logprob": -0.2}])
        self.assertEqual(out, [{"start": 0.0, "end": 2.0, "text": "Bom dia a todos."}])

    def test_drops_empty_and_silence_guesses(self):
        out = meeting.clean_live(
            [
                {"start": 0, "end": 1, "text": "   "},
                {"start": 1, "end": 2, "text": "Obrigado.", "no_speech": 0.9, "logprob": -1.8},
            ]
        )
        self.assertEqual(out, [])

    def test_unsure_but_speech_is_kept(self):
        # no_speech alto sozinho não basta: precisa também de pouca confiança no texto.
        out = meeting.clean_live([{"start": 0, "end": 2, "text": "Sim", "no_speech": 0.7, "logprob": -0.3}])
        self.assertEqual(len(out), 1)

    def test_drops_end_of_video_phrases(self):
        out = meeting.clean_live(
            [
                {"start": 0, "end": 2, "text": "Legendas pela comunidade Amara.org", "no_speech": 0.1, "logprob": -0.5},
                {"start": 2, "end": 4, "text": "Subtitles by the Amara.org community", "no_speech": 0.1, "logprob": -0.5},
            ]
        )
        self.assertEqual(out, [])

    def test_missing_scores_do_not_break(self):
        self.assertEqual(len(meeting.clean_live([{"start": 0, "end": 1, "text": "ok"}])), 1)


class Merge(unittest.TestCase):
    def test_orders_by_time_and_labels_channels(self):
        out = meeting.merge_channels(
            [seg(10, 12, "Pode ser amanhã.")],
            [seg(0, 5, "Vamos marcar a reunião?"), seg(20, 25, "Fechado então.")],
        )
        self.assertEqual([(s["who"], s["start"]) for s in out], [("outros", 0), ("voce", 10), ("outros", 20)])

    def test_echo_of_the_other_side_is_dropped(self):
        # Sem fone o microfone repete o que saiu no alto-falante, com pequenas diferenças.
        out = meeting.merge_channels(
            [seg(0.2, 5.1, "vamos marcar a reuniao para amanha as dez")],
            [seg(0, 5, "Vamos marcar a reunião para amanhã às dez?")],
        )
        self.assertEqual([s["who"] for s in out], ["outros"])

    def test_same_time_but_different_words_is_kept(self):
        # Os dois falaram ao mesmo tempo: não é eco, é interrupção.
        out = meeting.merge_channels(
            [seg(1, 4, "Desculpa, posso falar uma coisa?")],
            [seg(0, 5, "Então o orçamento do trimestre ficou em cinquenta mil.")],
        )
        self.assertEqual(sorted(s["who"] for s in out), ["outros", "voce"])

    def test_same_words_far_apart_is_kept(self):
        out = meeting.merge_channels([seg(100, 103, "Pode ser amanhã")], [seg(0, 3, "Pode ser amanhã")])
        self.assertEqual(len(out), 2)

    def test_empty_channels(self):
        self.assertEqual(meeting.merge_channels([], []), [])
        self.assertEqual([s["who"] for s in meeting.merge_channels([], [seg(0, 1, "oi")])], ["outros"])


class Chunking(unittest.TestCase):
    def test_short_text_is_one_chunk(self):
        self.assertEqual(meeting.chunk_lines("a\nb", 100), ["a\nb"])

    def test_splits_on_line_boundaries(self):
        lines = [f"linha {i:03d}" for i in range(50)]
        chunks = meeting.chunk_lines("\n".join(lines), 100)
        self.assertGreater(len(chunks), 3)
        self.assertTrue(all(len(c) <= 100 for c in chunks))
        self.assertEqual("\n".join(chunks).split("\n"), lines)  # nada perdido nem repetido

    def test_one_giant_line_is_cut(self):
        chunks = meeting.chunk_lines("x" * 250, 100)
        self.assertEqual([len(c) for c in chunks], [100, 100, 50])


class Ask(unittest.TestCase):
    def test_message_has_context_history_and_question(self):
        msg = meeting.ask_message(
            "Quem cobra o time?",
            "[01:00] Você: eu cobro o time",
            minutes="# Reunião\n\n## Decisões\n- X",
            notes="Prazo é quinta",
            history=[{"role": "user", "content": "Oi"}, {"role": "assistant", "content": "Olá"}],
        )
        for piece in ("Ata da reunião", "Anotações de quem gravou", "Prazo é quinta", "[01:00] Você", "Pessoa: Oi", "Assistente: Olá", "Quem cobra o time?"):
            self.assertIn(piece, msg)
        self.assertLess(msg.index("Transcrição"), msg.index("Conversa até aqui"))
        self.assertTrue(msg.rstrip().endswith("Quem cobra o time?"))

    def test_long_transcript_keeps_start_and_end(self):
        text = "COMECO " + "x" * 50_000 + " FIM"
        clipped = meeting.clip_middle(text, 1000)
        self.assertLessEqual(len(clipped), 1100)
        self.assertTrue(clipped.startswith("COMECO"))
        self.assertTrue(clipped.endswith("FIM"))
        self.assertIn("omitido", clipped)
        self.assertEqual(meeting.clip_middle("curto", 1000), "curto")

    def test_history_is_cleaned_and_capped(self):
        history = [{"role": "user", "content": f"p{i}"} for i in range(30)] + [{"role": "x", "content": "ruim"}, "lixo", {"role": "user", "content": "  "}]
        turns = meeting.clean_history(history)
        self.assertEqual(len(turns), meeting.ASK_MAX_HISTORY)
        self.assertEqual(turns[-1]["content"], "p29")
        self.assertNotIn("ruim", [t["content"] for t in turns])

    def test_prompt_follows_language_and_forbids_inventing(self):
        self.assertIn("português do Brasil", meeting.ask_prompt("pt"))
        self.assertIn("inglês", meeting.ask_prompt("en"))
        self.assertIn("Não invente", meeting.ask_prompt())


if __name__ == "__main__":
    unittest.main(verbosity=2)
