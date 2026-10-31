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


class Goal(unittest.TestCase):
    def test_goal_adds_a_section_and_the_verdict_rules(self):
        template = meeting.load_templates()["reuniao"]
        sem = meeting.minutes_prompt(template, "pt")
        com = meeting.minutes_prompt(template, "pt", goal="Fechar o contrato com a Padaria Central")
        self.assertNotIn(meeting.GOAL_TITLE, sem)
        self.assertIn(f"## {meeting.GOAL_TITLE}", com)
        self.assertIn("Fechar o contrato com a Padaria Central", com)
        for piece in ("Parcialmente", "Como melhorar na próxima", "O que faltou", "Reunião padrão"):
            self.assertIn(piece, com)
        # o objetivo vem antes das seções do modelo
        self.assertLess(com.index(f"## {meeting.GOAL_TITLE}"), com.index("## Em uma frase"))

    def test_goal_is_cleaned(self):
        self.assertEqual(meeting.clean_goal("  Fechar \n  contrato «já» "), "Fechar contrato já")
        self.assertEqual(len(meeting.clean_goal("x" * 900)), 500)
        self.assertEqual(meeting.clean_goal(None), "")

    def test_chat_message_carries_the_goal(self):
        msg = meeting.ask_message("Alcançamos?", "[00:10] Você: oi", goal="Fechar o contrato")
        self.assertIn("Objetivo que a pessoa definiu", msg)
        self.assertIn("Fechar o contrato", msg)
        self.assertNotIn("Objetivo que a pessoa definiu", meeting.ask_message("x", "y"))

    def test_sales_and_alignment_templates_exist(self):
        found = meeting.load_templates()
        self.assertIn("venda", found)
        self.assertIn("alinhamento", found)


class Accuracy(unittest.TestCase):
    """Defeitos vistos no log de uma chamada real: murmúrios realimentando o prompt e voz baixa."""

    def test_prompt_drops_fillers_and_repeats(self):
        dirty = "Vai, tem que ver o contrato aí, né? Hum-hum. Hum-hum. Hum-hum. Tchau. Tchau. Você me passa aí."
        out = meeting.prompt_tail(dirty)
        self.assertNotIn("Hum", out)
        self.assertEqual(out.count("Tchau"), 1)
        self.assertIn("Você me passa aí", out)

    def test_prompt_is_limited_and_tolerates_empty(self):
        self.assertEqual(meeting.prompt_tail(""), "")
        self.assertEqual(meeting.prompt_tail(None), "")
        self.assertLessEqual(len(meeting.prompt_tail("Frase longa de teste. " * 40)), 220)

    def test_filler_only_segments_are_not_shown(self):
        out = meeting.clean_live(
            [
                {"start": 0, "end": 1, "text": " Hum-hum. ", "no_speech": 0.1, "logprob": -0.2},
                {"start": 1, "end": 2, "text": "Uhum", "no_speech": 0.1, "logprob": -0.2},
                {"start": 2, "end": 4, "text": "Hum, deixa eu ver o contrato.", "no_speech": 0.1, "logprob": -0.2},
            ]
        )
        self.assertEqual([s["text"] for s in out], ["Hum, deixa eu ver o contrato."])

    def test_quiet_voice_is_boosted_loud_voice_is_not(self):
        self.assertGreater(meeting.speech_gain(0.01, 0.2), 4)
        self.assertEqual(meeting.speech_gain(0.1, 0.5), 1.0)  # já está num bom volume
        self.assertEqual(meeting.speech_gain(0.0005, 0.01), 1.0)  # ruído de fundo: não amplifica
        self.assertEqual(meeting.speech_gain(0.0, 0.0), 1.0)

    def test_gibberish_is_not_shown(self):
        seg = lambda t: {"start": 0, "end": 2, "text": t, "no_speech": 0.1, "logprob": -0.2}
        lixo = ["kAWSKAWSKAWSK", "AAAAAAAAAA", "Xkjzzzqwrt", "bhgfdsk ploiuy", "kawskawskawsk"]
        for t in lixo:
            self.assertEqual(meeting.clean_live([seg(t)]), [], t)

    def test_brands_acronyms_and_normal_speech_are_not_gibberish(self):
        for t in ["Vou mandar no WhatsApp", "Abre o PowerPoint e o iPhone", "A API do CRM caiu", "Transporte e monstro de planilha", "O Wi-Fi está ótimo, né?"]:
            self.assertFalse(meeting.looks_gibberish(t), t)

    def test_provisional_text_only_passes_with_confidence(self):
        confident = {"start": 0, "end": 2, "text": "E sobre o prazo da integração", "no_speech": 0.05, "logprob": -0.3}
        unsure = {"start": 0, "end": 2, "text": "E sobre o prazo da integração", "no_speech": 0.05, "logprob": -1.1}
        noisy = {"start": 0, "end": 2, "text": "E sobre o prazo da integração", "no_speech": 0.6, "logprob": -0.3}
        first_word = {"start": 0, "end": 2, "text": "Então", "no_speech": 0.05, "logprob": -0.3}
        tiny = {"start": 0, "end": 2, "text": "é", "no_speech": 0.05, "logprob": -0.3}
        self.assertEqual(len(meeting.clean_live([confident], "pt", True)), 1)
        self.assertEqual(meeting.clean_live([unsure], "pt", True), [])
        self.assertEqual(meeting.clean_live([noisy], "pt", True), [])
        # a primeira palavra da frase já aparece: era isso que fazia o provisório demorar
        self.assertEqual(len(meeting.clean_live([first_word], "pt", True)), 1)
        self.assertEqual(meeting.clean_live([tiny], "pt", True), [])
        # o texto definitivo é menos rígido: o mesmo trecho incerto ainda vale
        self.assertEqual(len(meeting.clean_live([unsure], "pt", False)), 1)

    def test_sounds_are_shown_as_sounds_not_as_garbage(self):
        seg = lambda t, a, b=-0.2, n=0.1: {"start": a, "end": a + 1, "text": t, "no_speech": n, "logprob": b}
        out = meeting.live_segments([seg("Hum-hum.", 0), seg("kAWSKAWSKAWSK", 2), seg("Tosse", 4), seg("Fechamos o orçamento", 6)])
        self.assertEqual([(s["text"], bool(s.get("sound"))) for s in out], [("hum", True), ("ruído", True), ("tosse", True), ("Fechamos o orçamento", False)])

    def test_invented_phrases_are_not_sounds(self):
        seg = lambda t: {"start": 0, "end": 1, "text": t, "no_speech": 0.1, "logprob": -0.2}
        self.assertEqual(meeting.live_segments([seg("Thank you."), seg("Legendas pela comunidade Amara.org"), seg(meeting.LIVE_SEED)]), [])

    def test_the_provisional_text_never_shows_sounds(self):
        seg = {"start": 0, "end": 1, "text": "Hum-hum.", "no_speech": 0.1, "logprob": -0.2}
        self.assertEqual(meeting.live_segments([seg], "pt", True), [])

    def test_background_noise_is_not_boosted(self):
        # ruído de fundo amplificado vira "fala" para o Whisper: o filme de "eai eai eai" sem ninguém falando
        self.assertEqual(meeting.speech_gain(0.003, 0.05), 1.0)

    def test_repeated_words_are_not_speech(self):
        seg = lambda t: {"start": 0, "end": 2, "text": t, "no_speech": 0.1, "logprob": -0.2}
        out = meeting.clean_live([seg("Eai eai eai"), seg("Tá tá tá tá"), seg("Sim, sim, eu concordo com isso"), seg("Fechamos o orçamento")])
        self.assertEqual([s["text"] for s in out], ["Sim, sim, eu concordo com isso", "Fechamos o orçamento"])

    def test_boost_never_clips_and_is_capped(self):
        gain = meeting.speech_gain(0.01, 0.6)
        self.assertLessEqual(0.6 * gain, 0.95 + 1e-9)
        self.assertLessEqual(meeting.speech_gain(0.003, 0.004), 12.0)

    def test_english_noise_is_dropped_in_portuguese_calls(self):
        seg = lambda t: {"start": 0, "end": 2, "text": t, "no_speech": 0.1, "logprob": -0.2}
        out = meeting.clean_live([seg("Thank you."), seg("Thanks for watching!"), seg("Bom dia, vamos começar."), seg("Fechei o contrato com o time")])
        self.assertEqual([s["text"] for s in out], ["Bom dia, vamos começar.", "Fechei o contrato com o time"])

    def test_english_is_kept_when_the_call_is_not_portuguese(self):
        out = meeting.clean_live([{"start": 0, "end": 2, "text": "Thank you for the update.", "no_speech": 0.1, "logprob": -0.2}], "en")
        self.assertEqual(len(out), 1)

    def test_portuguese_with_a_few_english_words_is_kept(self):
        # reunião de trabalho mistura termos em inglês: não pode virar "ruído"
        t = "Vamos fazer o deploy do feature na sexta e revisar o pull request"
        self.assertFalse(meeting.looks_english(t))

    def test_the_seed_prompt_is_never_shown_as_speech(self):
        out = meeting.clean_live([{"start": 0, "end": 2, "text": meeting.LIVE_SEED, "no_speech": 0.1, "logprob": -0.2}])
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
