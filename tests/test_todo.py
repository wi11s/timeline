import todo


def test_add_done_remove():
    t = todo.add([], "milk")
    t = todo.add(t, "eggs")
    todo.done(t, 1)
    assert todo.render(t) == "1. [x] milk\n2. [ ] eggs"
    todo.remove(t, 1)
    assert todo.render(t) == "1. [ ] eggs"


def test_empty():
    assert todo.render([]) == "nothing to do."


def test_cli(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    todo.main(["add", "buy", "milk"])
    todo.main(["done", "1"])
    assert capsys.readouterr().out.strip().endswith("1. [x] buy milk")
