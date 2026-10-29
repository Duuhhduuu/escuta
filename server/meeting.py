"""Lógica de reunião sem Whisper nem rede: modelos de ata, prompts, junção dos
dois canais e divisão de transcrição longa. Fica fora do server.py para poder
ser testada sem GPU (test_meeting.py).

Os modelos de ata ficam em templates/ (um .json por modelo).
"""
import difflib
import json
import os

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")

# Quem fala em cada canal da gravação: a extensão põe o microfone à esquerda e o
# áudio da aba (os outros participantes) à direita.
WHO_MIC = "voce"
WHO_TAB = "outros"
WHO_LABEL = {WHO_MIC: "Você", WHO_TAB: "Participantes"}

LANGUAGES = {
    "pt": "português do Brasil",
    "en": "inglês",
    "es": "espanhol",
    "auto": "o mesmo idioma da transcrição",
}

FORMATS = ("paragraph", "list", "string")


def load_templates(directory=TEMPLATES_DIR):
    """{id: modelo}. O id é o nome do arquivo sem .json; arquivo inválido é ignorado."""
    found = {}
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return found
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as fh:
                data = json.load(fh)
            validate(data)
        except (OSError, ValueError) as exc:
            print(f"[escuta] modelo {name} ignorado: {exc}", flush=True)
            continue
        found[name[: -len(".json")]] = data
    return found


def validate(data):
    if not isinstance(data, dict) or not data.get("name"):
        raise ValueError("falta o nome")
    sections = data.get("sections")
    if not isinstance(sections, list) or not sections:
        raise ValueError("falta ao menos uma seção")
    for section in sections:
        if not section.get("title") or not section.get("instruction"):
            raise ValueError("toda seção precisa de title e instruction")
        if section.get("format") not in FORMATS:
            raise ValueError(f"formato inválido em '{section['title']}'")


def public_list(templates):
    return [{"id": key, "name": t["name"], "description": t.get("description", "")} for key, t in templates.items()]


def structure(template):
    """O esqueleto em Markdown que o modelo de linguagem preenche."""
    lines = ["# <Título da reunião>", ""]
    for section in template["sections"]:
        lines += [f"## {section['title']}", ""]
    return "\n".join(lines)


def section_instructions(template):
    lines = ["- **Título principal (`# ...`):** leia a transcrição inteira e crie um título curto e descritivo."]
    for section in template["sections"]:
        lines.append(f"- **Seção '{section['title']}':** {section['instruction'].rstrip('.')}.")
        item = section.get("item_format") or section.get("example_item_format")
        if item:
            lines.append(f"  - Os itens desta seção seguem este formato:\n```\n{item}\n```")
    return "\n".join(lines)


def minutes_prompt(template, language="pt", notes=False):
    idioma = LANGUAGES.get(language, LANGUAGES["pt"])
    rules = [
        f"Escreva em {idioma}.",
        "Use apenas o que está na transcrição e nas anotações. Não invente nomes, datas, números nem decisões.",
        "Mantenha nomes, números, datas e horários exatamente como foram ditos.",
        "Se uma seção não tiver conteúdo, escreva _Nada a registrar._",
        "A transcrição marca quem fala: 'Você' é quem gravou e 'Participantes' são os outros. "
        "Quando não houver nomes, use esses rótulos.",
        "Os horários entre colchetes ([mm:ss]) vêm da transcrição; use-os onde o modelo pedir referência.",
    ]
    if notes:
        rules.append(
            "Depois da transcrição vêm as 'Anotações de quem gravou', escritas durante a reunião. Não são falas: "
            "use-as para acertar a grafia de nomes e termos e para dar destaque ao que a pessoa marcou como importante."
        )
    rules.append("Responda só com o Markdown da ata, sem comentários antes ou depois.")
    numbered = "\n".join(f"{i}. {rule}" for i, rule in enumerate(rules, 1))
    return (
        "Você é um redator experiente de atas de reunião. Preencha o modelo em Markdown abaixo "
        "com base na transcrição que o usuário enviar.\n\n"
        f"Regras:\n{numbered}\n\n"
        f"Instruções por seção:\n{section_instructions(template)}\n\n"
        f"Estrutura do modelo:\n\n{structure(template)}"
    )


NOTES_PROMPT = (
    "Você recebe um trecho de uma transcrição de reunião. Extraia anotações em tópicos curtos: "
    "assuntos, decisões, tarefas (com responsável e prazo, se ditos), números, datas, nomes e "
    "dúvidas em aberto. Mantenha o horário [mm:ss] de cada ponto. Não invente nada. "
    "Responda só com os tópicos, no mesmo idioma da transcrição."
)


# ---- transcrição ------------------------------------------------------------------


def stamp(seconds):
    total = int(seconds)
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def format_transcript(segments):
    """'[01:23] Você: texto', uma linha por trecho."""
    return "\n".join(
        f"[{stamp(seg['start'])}] {WHO_LABEL.get(seg['who'], seg['who'])}: {seg['text'].strip()}"
        for seg in segments
        if seg["text"].strip()
    )


# O Whisper, diante de um trecho quase mudo, "escuta" frases de fim de vídeo. Numa janela
# de poucos segundos isso acontece bastante; na gravação inteira o VAD já segura a maioria.
HALLUCINATIONS = ("Legendas pela comunidade", "Amara.org", "Obrigado por assistir", "Inscreva-se no canal")


def clean_live(segments):
    """Trechos de uma janela ao vivo que valem mostrar: tira vazio, silêncio com palpite e frase de fim de vídeo."""
    keep = []
    for seg in segments:
        text = seg["text"].strip()
        if not text:
            continue
        if seg.get("no_speech", 0) > 0.6 and seg.get("logprob", 0) < -1.0:
            continue
        # Compara dos dois lados já sem pontuação nem maiúscula: "Amara.org" e "amaraorg" são a mesma coisa.
        if any(_norm(h) in _norm(text) for h in HALLUCINATIONS):
            continue
        keep.append({"start": seg["start"], "end": seg["end"], "text": text})
    return keep


def _overlap(a, b):
    return max(0.0, min(a["end"], b["end"]) - max(a["start"], b["start"]))


def _norm(text):
    return " ".join("".join(c for c in text.lower() if c.isalnum() or c.isspace()).split())


def merge_channels(mic, tab):
    """Junta os trechos dos dois canais em ordem de tempo.

    Sem fone, o microfone também ouve o alto-falante e repete o que a outra pessoa
    disse. Um trecho do microfone que cai em cima de um da aba com texto quase igual
    é eco e sai; o que sobra é o que você disse de fato.
    """
    out = [{**seg, "who": WHO_TAB} for seg in tab if seg["text"].strip()]
    for seg in mic:
        if not seg["text"].strip():
            continue
        mine = _norm(seg["text"])
        echo = any(
            _overlap(seg, other) >= 0.4 * min(seg["end"] - seg["start"], other["end"] - other["start"])
            and difflib.SequenceMatcher(None, mine, _norm(other["text"])).ratio() >= 0.75
            for other in tab
            if other["end"] >= seg["start"] - 1 and other["start"] <= seg["end"] + 1
        )
        if not echo:
            out.append({**seg, "who": WHO_MIC})
    out.sort(key=lambda s: (s["start"], s["who"]))
    return out


def chunk_lines(text, limit):
    """Divide em pedaços de até `limit` caracteres sem cortar no meio de uma linha."""
    chunks, current, size = [], [], 0
    for line in text.split("\n"):
        # Uma linha maior que o limite (fala muito longa) é partida, senão nunca caberia.
        while len(line) > limit:
            head, line = line[:limit], line[limit:]
            if current:
                chunks.append("\n".join(current))
                current, size = [], 0
            chunks.append(head)
        if size + len(line) + 1 > limit and current:
            chunks.append("\n".join(current))
            current, size = [], 0
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks
