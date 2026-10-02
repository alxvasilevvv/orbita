"""Оборачивает статичный русский текст JSX и атрибуты placeholder/aria-label/title в t().
Запуск: python3 scripts/i18n-wrap.py src/ui/screens/core.tsx ...  (идемпотентно)."""
import re
import sys

CYR = re.compile(r"[А-Яа-яЁё]")
# Текст JSX между > или } и < или {, без кавычек, обратных кавычек, = ; и комментариев.
TEXT = re.compile(r"(?<=[>}])([^<>{}\"'`=;*\n]*[А-Яа-яЁё][^<>{}\"'`=;*\n]*)(?=[<{])")
ATTR = re.compile(r'\b(placeholder|aria-label|title|label)="([^"]*[А-Яа-яЁё][^"]*)"')


def wrap_text(m: re.Match) -> str:
    raw = m.group(1)
    core = raw.strip()
    if not core or not CYR.search(core):
        return raw
    lead = raw[: len(raw) - len(raw.lstrip())]
    trail = raw[len(raw.rstrip()):]
    esc = core.replace("\\", "\\\\").replace('"', '\\"')
    return f'{lead}{{t("{esc}")}}{trail}'


for path in sys.argv[1:]:
    src = open(path, encoding="utf-8").read()
    out_lines = []
    for line in src.split("\n"):
        s = line.lstrip()
        if s.startswith("//") or s.startswith("/*") or s.startswith("*") or s.startswith("import "):
            out_lines.append(line)
            continue
        line = ATTR.sub(lambda m: f'{m.group(1)}={{t("{m.group(2)}")}}', line)
        line = TEXT.sub(wrap_text, line)
        out_lines.append(line)
    open(path, "w", encoding="utf-8").write("\n".join(out_lines))
    print("wrapped", path)
