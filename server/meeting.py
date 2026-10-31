"""Lógica de reunião sem Whisper nem rede: modelos de ata, prompts, junção dos
dois canais e divisão de transcrição longa. Fica fora do server.py para poder
ser testada sem GPU (test_meeting.py).

Os modelos de ata ficam em templates/ (um .json por modelo).
"""
import difflib
import json
import os
import re

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


GOAL_TITLE = "Objetivo da reunião"


def clean_goal(goal):
    """O objetivo que a pessoa escreveu, em uma linha e sem aspas que confundiriam o pedido."""
    text = " ".join(str(goal or "").split())
    return text.replace("«", "").replace("»", "")[:500]


def structure(template, goal=""):
    """O esqueleto em Markdown que o modelo de linguagem preenche."""
    lines = ["# <Título da reunião>", ""]
    if goal:
        lines += [f"## {GOAL_TITLE}", ""]
    for section in template["sections"]:
        lines += [f"## {section['title']}", ""]
    return "\n".join(lines)


def goal_instruction(goal, kind):
    return (
        f"- **Seção '{GOAL_TITLE}':** a pessoa definiu este objetivo: «{goal}». "
        "Comece com uma só palavra, Sim, Parcialmente ou Não, seguida de ponto, dizendo se a reunião o alcançou. "
        "Em seguida, em 2 ou 3 frases, mostre o que foi dito que comprova isso, com o horário. "
        "Depois escreva duas listas curtas: 'O que faltou' (omita se nada faltou) e 'Como melhorar na próxima', "
        f"com 2 a 3 sugestões práticas, específicas para uma reunião do tipo «{kind}» e baseadas no que aconteceu. "
        "Nada de elogio genérico."
    )


def section_instructions(template, goal=""):
    lines = ["- **Título principal (`# ...`):** leia a transcrição inteira e crie um título curto e descritivo."]
    if goal:
        lines.append(goal_instruction(goal, template.get("name", "reunião")))
    for section in template["sections"]:
        lines.append(f"- **Seção '{section['title']}':** {section['instruction'].rstrip('.')}.")
        item = section.get("item_format") or section.get("example_item_format")
        if item:
            lines.append(f"  - Os itens desta seção seguem este formato:\n```\n{item}\n```")
    return "\n".join(lines)


def minutes_prompt(template, language="pt", notes=False, goal=""):
    goal = clean_goal(goal)
    idioma = LANGUAGES.get(language, LANGUAGES["pt"])
    rules = [
        f"Escreva em {idioma}.",
        "Use apenas o que está na transcrição e nas anotações. Não invente nomes, datas, números nem decisões.",
        "Mantenha nomes, números, datas e horários exatamente como foram ditos.",
        "Se uma seção não tiver conteúdo, escreva _Nada a registrar._",
        "A transcrição marca quem fala, pelo nome da pessoa quando ele é conhecido. Sem nome, 'Você' é quem gravou "
        "e 'Participantes' são os outros. Use os nomes da transcrição, principalmente em quem faz o quê.",
        "Os horários entre colchetes ([mm:ss]) vêm da transcrição; use-os onde o modelo pedir referência.",
    ]
    if notes:
        rules.append(
            "Depois da transcrição vêm as 'Anotações de quem gravou', escritas durante a reunião. Não são falas: "
            "use-as para acertar a grafia de nomes e termos e para dar destaque ao que a pessoa marcou como importante."
        )
    if goal:
        rules.append("Julgue o objetivo com honestidade, só pelo que a transcrição mostra. Se a conversa não chegou lá, diga Não ou Parcialmente.")
    rules.append("Responda só com o Markdown da ata, sem comentários antes ou depois.")
    numbered = "\n".join(f"{i}. {rule}" for i, rule in enumerate(rules, 1))
    return (
        "Você é um redator experiente de atas de reunião. Preencha o modelo em Markdown abaixo "
        "com base na transcrição que o usuário enviar.\n\n"
        f"Regras:\n{numbered}\n\n"
        f"Instruções por seção:\n{section_instructions(template, goal)}\n\n"
        f"Estrutura do modelo:\n\n{structure(template, goal)}"
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
        f"[{stamp(seg['start'])}] {seg.get('speaker') or WHO_LABEL.get(seg['who'], seg['who'])}: {seg['text'].strip()}"
        for seg in segments
        if seg["text"].strip()
    )


# ---- perguntas sobre uma reunião já gravada ----------------------------------------------

ASK_MAX_QUESTION = 2000
ASK_MAX_HISTORY = 12  # trocas anteriores que entram no pedido; o resto a pessoa já leu
ASK_MAX_TURN = 4000


def ask_prompt(language="pt"):
    idioma = LANGUAGES.get(language, LANGUAGES["pt"])
    return (
        "Você ajuda a pessoa a entender uma reunião que ela gravou. "
        f"Responda em {idioma}, de forma direta e curta.\n\n"
        "Regras:\n"
        "1. Use só o que está na ata, nas anotações e na transcrição. Se a resposta não estiver lá, "
        "diga que a reunião não trata disso. Não invente.\n"
        "2. Ao citar uma fala, indique o horário entre colchetes, como [12:40].\n"
        "3. A transcrição marca quem fala pelo nome quando ele é conhecido; sem nome, 'Você' é quem gravou e 'Participantes' são os outros.\n"
        "4. Listas só quando a pergunta pedir (decisões, tarefas, prazos). Sem introdução do tipo \"Claro!\"."
    )


def clip_middle(text, limit):
    """Se passar do limite, fica o começo e o fim, que é onde a reunião abre e fecha os assuntos."""
    if limit <= 0 or len(text) <= limit:
        return text if limit > 0 else ""
    half = limit // 2
    return f"{text[:half]}\n[... trecho do meio omitido por ser longo ...]\n{text[-half:]}"


def clean_history(history):
    """Só pares válidos {role, content}, os mais recentes e com tamanho contido."""
    turns = []
    for item in history or []:
        if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"):
            continue
        content = str(item.get("content") or "").strip()[:ASK_MAX_TURN]
        if content:
            turns.append({"role": item["role"], "content": content})
    return turns[-ASK_MAX_HISTORY:]


def ask_message(question, transcript, minutes="", notes="", history=None, limit=20_000, goal=""):
    """O pedido que vai ao modelo: contexto da reunião, conversa até aqui e a pergunta."""
    question = str(question or "").strip()[:ASK_MAX_QUESTION]
    parts = []
    goal = clean_goal(goal)
    if goal:
        parts.append(f"Objetivo que a pessoa definiu para a reunião:\n{goal}")
    if minutes:
        parts.append(f"Ata da reunião:\n{minutes.strip()}")
    if notes:
        parts.append(f"Anotações de quem gravou:\n{notes.strip()}")
    used = sum(len(p) for p in parts)
    parts.append(f"Transcrição:\n{clip_middle(transcript, max(limit - used, 2000))}")
    turns = clean_history(history)
    if turns:
        said = "\n".join(f"{'Pessoa' if t['role'] == 'user' else 'Assistente'}: {t['content']}" for t in turns)
        parts.append(f"Conversa até aqui:\n{said}")
    parts.append(f"Pergunta da pessoa:\n{question}")
    return "\n\n".join(parts)


# O Whisper, diante de um trecho quase mudo, "escuta" frases de fim de vídeo. Numa janela
# de poucos segundos isso acontece bastante; na gravação inteira o VAD já segura a maioria.
HALLUCINATIONS = ("Legendas pela comunidade", "Amara.org", "Obrigado por assistir", "Inscreva-se no canal")


# Murmúrios que o Whisper escreve onde só há respiração ou "uhum" ao fundo. Sozinhos não dizem nada e,
# quando voltam como dica da janela seguinte, puxam mais deles: a janela vira uma fila de "Hum-hum".
FILLERS = {"hum", "humhum", "hmm", "hm", "uhum", "uhm", "ahn", "aham", "mhm", "mm", "mmm"}


def _is_filler(text):
    words = _norm(text).replace("-", " ").split()
    return bool(words) and all(w.replace(" ", "") in FILLERS for w in words)


def prompt_tail(text, limit=220):
    """O fim da fala anterior, que serve de dica ao Whisper, sem murmúrios nem frases repetidas em fila.
    Dica suja realimenta o erro: um "Hum-hum." no prompt gera outro na janela seguinte."""
    sentences = []
    for sentence in re.split(r"(?<=[.!?…])\s+", (text or "").strip()):
        if not sentence or _is_filler(sentence):
            continue
        if sentences and _norm(sentences[-1]) == _norm(sentence):
            continue
        sentences.append(sentence)
    return " ".join(sentences)[-limit:].strip()


def speech_gain(rms, peak, target=0.08, cap=8.0):
    """Ganho para a voz baixa chegar ao Whisper num volume em que ele acerta mais.
    Não amplifica ruído de fundo (rms baixo: aumentá-lo faz o Whisper "ouvir" fala onde não há), nem
    passa do limite e nem estoura o pico."""
    if rms < 0.004 or peak <= 0 or rms >= target:
        return 1.0
    gain = min(cap, target / rms, 0.95 / peak)
    return gain if gain >= 1.2 else 1.0


# Primeira dica do Whisper, antes de haver fala anterior: mantém o idioma e o tom de conversa de trabalho.
LIVE_SEED = "Conversa de trabalho em português do Brasil."

_EN = {"the", "you", "and", "thank", "thanks", "for", "watching", "this", "that", "is", "are", "with", "have", "it", "of", "to", "in", "i"}
_PT = {"de", "que", "o", "a", "e", "não", "nao", "é", "um", "uma", "para", "com", "eu", "você", "voce", "tá", "ta", "né", "ne", "do", "da", "em", "os", "as", "se", "mas", "por", "foi", "tem", "já", "ja", "isso"}


def looks_english(text):
    """Janela com ruído que o Whisper 'traduz' para inglês ("Thank you."). Só vale quando a conversa é em português."""
    words = [w for w in _norm(text).split() if w]
    if not words:
        return False
    en = sum(w in _EN for w in words)
    pt = sum(w in _PT for w in words)
    return (en >= 2 and en > pt) or (en >= 1 and pt == 0 and len(words) <= 4)


def is_repetition(text):
    """Uma ou duas palavras repetidas em fila ("eai eai eai"): é o que o Whisper escreve em cima de ruído."""
    words = _norm(text).split()
    return len(words) >= 3 and len(set(words)) <= max(1, len(words) // 3)


def clean_live(segments, language="pt"):
    """Trechos de uma janela ao vivo que valem mostrar: tira vazio, murmúrio, silêncio com palpite e frase de fim de vídeo."""
    keep = []
    for seg in segments:
        text = seg["text"].strip()
        if not text or _is_filler(text) or is_repetition(text):
            continue
        if language == "pt" and (looks_english(text) or _norm(LIVE_SEED) in _norm(text)):
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
