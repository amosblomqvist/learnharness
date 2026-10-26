import json
import os
import subprocess
import sys
import uuid

ROOT = os.environ["PROJECT_ROOT"]
TMP = os.environ["TEST_TMP"]
SCRIPT = os.path.join(ROOT, "questlog.py")


def fresh():
    return os.path.join(TMP, "quests-%s.json" % uuid.uuid4().hex)


def run(path, *args, cwd=None):
    argv = [sys.executable, SCRIPT] + (["--file", path] if path else []) + list(args)
    r = subprocess.run(argv, capture_output=True, text=True, cwd=cwd or TMP, timeout=10)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def test_the_script_exists():
    assert os.path.exists(SCRIPT), "Make a file called questlog.py in the project folder"


def test_add_and_list():
    f = fresh()
    assert run(f, "add", "Slay rats", "20") == (0, "Added: Slay rats (20 gold)", "")
    run(f, "add", "Find the key", "500")
    code, out, _ = run(f, "list")
    assert code == 0
    assert out == "[ ] Slay rats - 20 gold\n[ ] Find the key - 500 gold"


def test_empty_list_and_missing_file():
    code, out, _ = run(fresh(), "list")
    assert (code, out) == (0, "No quests yet.")


def test_done_and_stats():
    f = fresh()
    run(f, "add", "Slay rats", "20")
    run(f, "add", "Find the key", "500")
    assert run(f, "done", "Slay rats")[:2] == (0, "Completed: Slay rats. +20 gold")
    assert run(f, "list")[1] == "[x] Slay rats - 20 gold\n[ ] Find the key - 500 gold"
    assert run(f, "stats")[1] == "2 quests, 1 done, 20 gold earned, 500 gold waiting"


def test_stats_when_empty():
    assert run(fresh(), "stats")[1] == "0 quests, 0 done, 0 gold earned, 0 gold waiting"


def test_file_format():
    f = fresh()
    run(f, "add", "Slay rats", "20")
    run(f, "done", "Slay rats")
    assert json.load(open(f)) == {"quests": [{"name": "Slay rats", "gold": 20, "done": True}]}


def test_reads_a_file_it_did_not_write():
    f = fresh()
    json.dump({"quests": [{"name": "Old quest", "gold": 7, "done": True}]}, open(f, "w"))
    assert run(f, "list")[1] == "[x] Old quest - 7 gold"


def test_default_file_is_in_the_current_folder():
    here = os.path.join(TMP, "cwd-%s" % uuid.uuid4().hex)
    os.makedirs(here)
    run(None, "add", "Herbs", "5", cwd=here)
    assert os.path.exists(os.path.join(here, "quests.json")), "Without --file, use quests.json in the current folder"


def test_bad_gold():
    f = fresh()
    for bad in ("lots", "-5", "2.5"):
        code, out, err = run(f, "add", "Greedy", bad)
        assert code == 2, "add with gold %r should exit 2, not %r" % (bad, code)
        assert err.splitlines()[-1] == "error: gold must be a whole number"
        assert out == ""
    assert not os.path.exists(f), "A failed add must not create or change the file"


def test_duplicate():
    f = fresh()
    run(f, "add", "Slay rats", "20")
    assert run(f, "add", "Slay rats", "99") == (1, "", "error: quest already exists: Slay rats")
    assert run(f, "list")[1] == "[ ] Slay rats - 20 gold"


def test_done_errors():
    f = fresh()
    run(f, "add", "Slay rats", "20")
    assert run(f, "done", "Ghost") == (1, "", "error: no such quest: Ghost")
    run(f, "done", "Slay rats")
    assert run(f, "done", "Slay rats") == (1, "", "error: already done: Slay rats")


def test_usage():
    code, out, err = run(fresh())
    assert code == 2 and err, "With no command, print a usage message to stderr and exit 2"
    code, out, err = run(fresh(), "dance")
    assert code == 2 and err


def test_importable_without_running():
    r = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, %r); import questlog" % ROOT], capture_output=True, text=True, cwd=TMP, timeout=10)
    assert r.returncode == 0 and r.stdout == "", "Importing questlog should not run the program: use if __name__ == '__main__'"
