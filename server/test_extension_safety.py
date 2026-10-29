#!/usr/bin/env python3
"""Guarda contra um defeito que já aconteceu: o painel que a extensão injeta na página da
reunião não aparecia no Google Meet porque dock.js montava o HTML com innerHTML. O Meet exige
Trusted Types ("This document requires 'TrustedHTML' assignment") e tem CSP de estilo restrita;
uma atribuição dessas lança erro e o painel some, sem aviso.

Isto não substitui testar no navegador, mas pega a causa óbvia na hora:

    python server/test_extension_safety.py
"""
import os
import re
import unittest

EXT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension")

# Scripts que rodam DENTRO da página dos outros (content scripts e injetados).
INJECTED = ["dock.js", "content.js", "page-hook.js"]

# Sinks que o Trusted Types barra ou que a CSP de estilo da página recusa.
UNSAFE = [
    (r"\.innerHTML\s*=", "innerHTML"),
    (r"\.outerHTML\s*=", "outerHTML"),
    (r"insertAdjacentHTML", "insertAdjacentHTML"),
    (r"document\.write\s*\(", "document.write"),
    (r"\beval\s*\(", "eval"),
    (r"new\s+Function\s*\(", "new Function"),
    (r"setAttribute\(\s*['\"]style['\"]", 'setAttribute("style")'),
    (r"\.style\.cssText\s*=", "style.cssText"),
    (r"\.srcdoc\s*=", "srcdoc"),
]


def read(name):
    with open(os.path.join(EXT, name), encoding="utf-8") as fh:
        return fh.read()


def code_only(source):
    """Sem comentários: o próprio dock.js explica o defeito citando innerHTML."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return "\n".join(re.sub(r"(^|\s)//.*$", "", line) for line in source.split("\n"))


class InjectedScripts(unittest.TestCase):
    def test_no_trusted_types_or_csp_sinks(self):
        for name in INJECTED:
            code = code_only(read(name))
            for pattern, label in UNSAFE:
                with self.subTest(arquivo=name, sink=label):
                    self.assertIsNone(re.search(pattern, code), f"{name} usa {label}: o Google Meet bloqueia isso")

    def test_dock_styles_do_not_depend_on_inline_style_elements_first(self):
        # A folha construída por código tem que ser a primeira escolha; <style> é só reserva.
        code = read("dock.js")
        self.assertLess(code.index("adoptedStyleSheets"), code.index('createElement("style")'))

    def test_dock_is_a_closed_shadow_root_with_an_iframe_to_live(self):
        code = read("dock.js")
        self.assertIn('mode: "closed"', code)
        self.assertIn("live.html?dock=1", code)

    def test_live_page_is_web_accessible_for_the_iframe(self):
        import json

        manifest = json.loads(read("manifest.json"))
        resources = [r for entry in manifest["web_accessible_resources"] for r in entry["resources"]]
        self.assertIn("live.html", resources)
        # só o necessário (o painel e as fontes do cartão no WhatsApp): o resto não fica exposto às páginas
        self.assertEqual(resources, ["live.html", "fonts/*.woff2"])
        for needed in ("scripting", "activeTab", "tabCapture", "offscreen"):
            self.assertIn(needed, manifest["permissions"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
