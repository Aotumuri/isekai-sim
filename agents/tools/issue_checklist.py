"""Edit task markers in the Markdown of a GitHub issue."""

import re

QUOTE = re.compile(r" {0,3}>[ \t]?")
FENCE = re.compile(r"(?P<ticks>`{3,})[^`]*|(?P<tildes>~{3,}).*")
LIST = re.compile(r"([-+*]|[0-9]{1,9}[.)])([ \t]+)(?=\S)")
TASK = re.compile(r"\[(?P<check>[ xX])\][ \t]+(?P<text>\S.*)")


def task_positions(body):
    offset = 0
    parents = []
    fence = None
    quote_depth = 0
    for line in body.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        start = offset
        offset += len(line)
        depth = 0
        while (fence is None or depth < quote_depth) and (match := QUOTE.match(content)):
            depth += 1
            start += match.end()
            content = content[match.end():]
        if depth != quote_depth:
            parents.clear()
            fence = None
            quote_depth = depth
        if not content.strip():
            continue
        indent = len(re.match(r"[ \t]*", content)[0].expandtabs(4))
        marker = content.lstrip(" \t")
        start += len(content) - len(marker)
        if fence:
            char, length, base = fence
            if indent >= base:
                if indent <= base + 3 and re.fullmatch(re.escape(char) + r"{%d,}[ \t]*" % length, marker):
                    fence = None
                continue
            fence = None
        while parents and indent < parents[-1]:
            parents.pop()
        base = parents[-1] if parents else 0
        if indent > base + 3:
            continue
        if match := LIST.match(marker):
            padding = len(match[0].expandtabs(4)) - len(match[1])
            parents.append(indent + len(match[1]) + (padding if padding <= 4 else 1))
            if padding > 4:
                continue
            base = parents[-1]
            marker = marker[match.end():]
            start += match.end()
            if task := TASK.fullmatch(marker):
                yield task["text"].rstrip(" \t"), start + task.start("check")
        if opening := FENCE.fullmatch(marker):
            run = opening["ticks"] or opening["tildes"]
            fence = (run[0], len(run), base)


def check_tasks(body, tasks):
    matches = {task: [] for task in tasks}
    if not matches:
        return body
    for task, position in task_positions(body):
        if task in matches:
            matches[task].append(position)
    for task, positions in matches.items():
        if len(positions) != 1:
            problem = "not found" if not positions else "ambiguous"
            raise ValueError(f"Checklist item {problem}: {task!r}")
    characters = list(body)
    for (position,) in matches.values():
        if characters[position] == " ":
            characters[position] = "x"
    return "".join(characters)
