"""tiny json-backed todo cli."""
import argparse
import json
import sys
from pathlib import Path

DB = Path(".todos.json")


def load(db=DB):
    return json.loads(db.read_text()) if db.exists() else []


def save(todos, db=DB):
    db.write_text(json.dumps(todos, indent=2))


def add(todos, text):
    todos.append({"text": text, "done": False})
    return todos


def done(todos, n):
    todos[n - 1]["done"] = True
    return todos


def remove(todos, n):
    todos.pop(n - 1)
    return todos


def render(todos):
    if not todos:
        return "nothing to do."
    return "\n".join(
        f"{i}. [{'x' if t['done'] else ' '}] {t['text']}"
        for i, t in enumerate(todos, 1)
    )


def main(argv=None):
    p = argparse.ArgumentParser(prog="todo")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("ls")
    sub.add_parser("add").add_argument("text", nargs="+")
    sub.add_parser("done").add_argument("n", type=int)
    sub.add_parser("rm").add_argument("n", type=int)
    a = p.parse_args(argv)

    todos = load()
    try:
        if a.cmd == "add":
            save(add(todos, " ".join(a.text)))
        elif a.cmd == "done":
            save(done(todos, a.n))
        elif a.cmd == "rm":
            save(remove(todos, a.n))
    except IndexError:
        sys.exit(f"no todo #{a.n}")
    print(render(load()))


if __name__ == "__main__":
    main()
