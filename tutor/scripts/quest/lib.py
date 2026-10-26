"""Builds src/study/content/quest.md, a boot.dev-style Python course: tiny lessons, one checked task each.

Every task's tests are generated here:
- output lessons compare the console with the expected text exactly;
- "checks" look at the code's syntax tree and tokens (so comments and strings can't fake them);
- the part under "# Don't touch below this line" must stay as the starter had it;
- "fuzz" compares the learner's function with a reference on a few hundred generated inputs;
- "wrong" answers are written into the module, and check:study proves the tests reject each one.
"""
import textwrap

D = "https://docs.python.org/3/"
TUT = D + "tutorial/"
DOCS = {
    "print": ("Python docs: print()", D + "library/functions.html#print"),
    "intro": ("Python tutorial: An informal introduction", TUT + "introduction.html"),
    "numbers": ("Python tutorial: Numbers", TUT + "introduction.html#numbers"),
    "text": ("Python tutorial: Text", TUT + "introduction.html#text"),
    "strings": ("Python tutorial: Formatted string literals", TUT + "inputoutput.html#formatted-string-literals"),
    "strmethods": ("Python docs: String methods", D + "library/stdtypes.html#string-methods"),
    "formatspec": ("Python docs: Format specification mini-language", D + "library/string.html#format-specification-mini-language"),
    "convert": ("Python docs: int()", D + "library/functions.html#int"),
    "bin": ("Python docs: bin()", D + "library/functions.html#bin"),
    "bitwise": ("Python docs: Bitwise operations on integer types", D + "library/stdtypes.html#bitwise-operations-on-integer-types"),
    "floats": ("Python tutorial: Floating-point arithmetic", TUT + "floatingpoint.html"),
    "divmod": ("Python docs: divmod()", D + "library/functions.html#divmod"),
    "none": ("Python docs: The None constant", D + "library/constants.html#None"),
    "assignment": ("Python reference: Assignment statements", D + "reference/simple_stmts.html#assignment-statements"),
    "def": ("Python tutorial: Defining functions", TUT + "controlflow.html#defining-functions"),
    "defaults": ("Python tutorial: Default argument values", TUT + "controlflow.html#default-argument-values"),
    "kwargs": ("Python tutorial: Keyword arguments", TUT + "controlflow.html#keyword-arguments"),
    "varargs": ("Python tutorial: Arbitrary argument lists", TUT + "controlflow.html#arbitrary-argument-lists"),
    "scope": ("Python tutorial: Scopes and namespaces", TUT + "classes.html#python-scopes-and-namespaces"),
    "global": ("Python reference: The global statement", D + "reference/simple_stmts.html#the-global-statement"),
    "errors": ("Python tutorial: Errors and exceptions", TUT + "errors.html"),
    "handling": ("Python tutorial: Handling exceptions", TUT + "errors.html#handling-exceptions"),
    "cleanup": ("Python tutorial: Defining clean-up actions", TUT + "errors.html#defining-clean-up-actions"),
    "userexc": ("Python tutorial: User-defined exceptions", TUT + "errors.html#user-defined-exceptions"),
    "chaining": ("Python tutorial: Exception chaining", TUT + "errors.html#exception-chaining"),
    "assert": ("Python reference: The assert statement", D + "reference/simple_stmts.html#the-assert-statement"),
    "if": ("Python tutorial: if statements", TUT + "controlflow.html#if-statements"),
    "bool": ("Python docs: Boolean operations", D + "library/stdtypes.html#boolean-operations-and-or-not"),
    "comparisons": ("Python docs: Comparisons", D + "library/stdtypes.html#comparisons"),
    "ifexp": ("Python reference: Conditional expressions", D + "reference/expressions.html#conditional-expressions"),
    "in": ("Python reference: Membership tests", D + "reference/expressions.html#membership-test-operations"),
    "truth": ("Python docs: Truth value testing", D + "library/stdtypes.html#truth-value-testing"),
    "for": ("Python tutorial: for statements", TUT + "controlflow.html#for-statements"),
    "range": ("Python tutorial: The range() function", TUT + "controlflow.html#the-range-function"),
    "break": ("Python tutorial: break and continue", TUT + "controlflow.html#break-and-continue-statements-and-else-clauses-on-loops"),
    "while": ("Python reference: The while statement", D + "reference/compound_stmts.html#the-while-statement"),
    "lists": ("Python tutorial: More on lists", TUT + "datastructures.html#more-on-lists"),
    "slices": ("Python tutorial: Lists", TUT + "introduction.html#lists"),
    "listcomp": ("Python tutorial: List comprehensions", TUT + "datastructures.html#list-comprehensions"),
    "nestedlist": ("Python tutorial: Nested list comprehensions", TUT + "datastructures.html#nested-list-comprehensions"),
    "copy": ("Python docs: copy", D + "library/copy.html"),
    "sorting": ("Python HOWTO: Sorting", D + "howto/sorting.html"),
    "loops": ("Python tutorial: Looping techniques", TUT + "datastructures.html#looping-techniques"),
    "dicts": ("Python tutorial: Dictionaries", TUT + "datastructures.html#dictionaries"),
    "mapping": ("Python docs: Mapping types (dict)", D + "library/stdtypes.html#mapping-types-dict"),
    "sets": ("Python tutorial: Sets", TUT + "datastructures.html#sets"),
    "settypes": ("Python docs: Set types", D + "library/stdtypes.html#set-types-set-frozenset"),
    "raise": ("Python tutorial: Raising exceptions", TUT + "errors.html#raising-exceptions"),
    "typing": ("Python docs: typing", D + "library/typing.html"),
    "class": ("Python tutorial: Classes", TUT + "classes.html"),
    "init": ("Python tutorial: Class objects", TUT + "classes.html#class-objects"),
    "methods": ("Python tutorial: Instance objects", TUT + "classes.html#instance-objects"),
    "repr": ("Python docs: object.__repr__()", D + "reference/datamodel.html#object.__repr__"),
    "inheritance": ("Python tutorial: Inheritance", TUT + "classes.html#inheritance"),
    "dataclass": ("Python docs: dataclasses", D + "library/dataclasses.html"),
    "field": ("Python docs: dataclasses.field", D + "library/dataclasses.html#dataclasses.field"),
    "files": ("Python tutorial: Reading and writing files", TUT + "inputoutput.html#reading-and-writing-files"),
    "with": ("Python reference: The with statement", D + "reference/compound_stmts.html#the-with-statement"),
    "main": ("Python docs: __main__", D + "library/__main__.html"),
    "json": ("Python docs: json", D + "library/json.html"),
    "unittest": ("Python docs: unittest (basic example)", D + "library/unittest.html#basic-example"),
    "math": ("Python docs: math.isclose()", D + "library/math.html#math.isclose"),
}

LESSONS = []  # (chapter, dict)


def L(ch, id, title, doc, story, assign, starter, solution, hint, expect=None, tests=None, checks=(), fuzz=None, wrong=(), project=False, extra=None, show=None):
    # show: (fixture expression, card kind), emitted as a lesson header. The app runs the expression
    # against the learner's code after Run/Submit and draws the world card; check:study runs it
    # against the solution. Cards so far: "room-bag" (a play() returning (room, bag)).
    LESSONS.append((ch, dict(kind="write", id=id, title=title, doc=doc, story=story, assign=assign, starter=starter, solution=solution, hint=hint,
                             expect=expect, tests=tests, checks=list(checks), fuzz=fuzz, wrong=list(wrong), project=project, extra=extra, show=show)))


def Q(ch, id, title, doc, story, code, answer, why):
    """A quiz lesson: read the code, type exactly what it prints."""
    LESSONS.append((ch, dict(kind="predict", id=id, title=title, doc=doc, story=story, code=code, answer=answer, why=why, project=False)))


def out(lines):
    return "\n".join(lines)


def dedent(s):
    return textwrap.dedent(s).lstrip("\n")


# ---------------------------------------------------------------- tests
MARK = "# Don't touch below this line"

PRELUDE = '''import ast, io, os, tokenize, contextlib, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "solution.py"), encoding="utf-8").read()
TREE = ast.parse(SRC)
# Code tokens only: comments and the insides of strings don't count.
TOKENS = [t.string for t in tokenize.generate_tokens(io.StringIO(SRC).readline)
          if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT)
          and t.type != getattr(tokenize, "FSTRING_MIDDLE", -1)]
NODES = list(ast.walk(TREE))

def has_token(s):
    return s in TOKENS

def has_node(kind):
    return any(type(n).__name__ == kind for n in NODES)

def calls(name):
    for n in NODES:
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == name) or (isinstance(f, ast.Attribute) and f.attr == name):
                return True
    return False

def fstring_uses(name):
    for n in NODES:
        if isinstance(n, ast.JoinedStr):
            if any(isinstance(x, ast.Name) and x.id == name for x in ast.walk(n)):
                return True
    return False

def defines(name):
    return any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name for n in NODES)

def uses_name(name):
    return any(isinstance(n, ast.Name) and n.id == name for n in NODES)

def keyword_arg(name):
    return any(isinstance(n, ast.keyword) and n.arg == name for n in NODES)

def printed(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue().rstrip()

def shown():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        runpy.run_path(os.path.join(HERE, "solution.py"), run_name="__main__")
    return buf.getvalue().rstrip()
'''

CHECKS = {
    "tok": ("has_token({a!r})", "Use `{a}` in your code.", "Don't use `{a}` here."),
    "node": ("has_node({a!r})", "Your code needs a `{label}`.", "Don't use a `{label}` here."),
    "call": ("calls({a!r})", "Call `{a}()` in your code.", "Don't call `{a}()` here."),
    "fname": ("fstring_uses({a!r})", "Put `{a}` inside an f-string: `f\"{{{a}}}\"`.", ""),
    "def": ("defines({a!r})", "Define `{a}`.", ""),
    "name": ("uses_name({a!r})", "Use the name `{a}`.", "The name `{a}` should be gone."),
    "kw": ("keyword_arg({a!r})", "Pass `{a}=` as a keyword argument.", ""),
}
NODE_LABEL = {
    "For": "for loop", "While": "while loop", "If": "if statement", "ListComp": "list comprehension", "DictComp": "dict comprehension",
    "SetComp": "set comprehension", "Try": "try block", "With": "with block", "Raise": "raise statement", "Assert": "assert statement", "Global": "global statement",
    "Return": "return statement", "IfExp": "one-line `x if cond else y`", "Slice": "slice like `[1:3]`", "AugAssign": "`+=` style update",
    "JoinedStr": "f-string", "Continue": "continue statement", "Break": "break statement", "Lambda": "lambda", "ClassDef": "class",
}


def check_tests(checks):
    out = []
    for i, c in enumerate(checks):
        msg = None
        if isinstance(c, tuple):
            c, msg = c
        neg = c.startswith("!")
        kind, a = c.lstrip("!").split(":", 1)
        expr, yes, no = CHECKS[kind]
        label = NODE_LABEL.get(a, a)
        m = msg or (no if neg else yes).format(a=a, label=label)
        cond = ("not " if neg else "") + expr.format(a=a)
        out.append("def test_code_%d():\n    assert %s, %r\n" % (i, cond, m))
    return out


def tail_test(starter):
    if MARK not in starter:
        return []
    tail = starter.split(MARK, 1)[1].strip()
    return ['''def test_protected_lines_unchanged():
    assert %r in SRC, "Keep the line %s"
    assert SRC.split(%r, 1)[1].strip() == %r, "The code under %s must stay as it was"
''' % (MARK, MARK.replace('"', "'"), MARK, tail, MARK.replace('"', "'"))]


def fuzz_test(fuzz):
    fn, ref, gen = fuzz
    return ['''import copy, random
from solution import %s as LEARNER
%s
%s
def test_many_inputs():
    r = random.Random(20261024)
    for _ in range(300):
        args = gen(r)
        want = ref(*copy.deepcopy(args))
        got = LEARNER(*copy.deepcopy(args))
        assert got == want, "%s%%r returned %%r, expected %%r" %% (tuple(args), got, want)
''' % (fn, dedent(ref), dedent(gen), fn)]


def tests_for(d):
    parts = [PRELUDE]
    if d["tests"]:
        parts.append(dedent(d["tests"]))
    else:
        parts.append("EXPECTED = %r\n" % d["expect"])
        parts.append('''def test_console():
    got = shown()
    assert got == EXPECTED, "The console shows:\\n" + got + "\\n\\nExpected:\\n" + EXPECTED
''')
    if d.get("extra"):
        parts.append(dedent(d["extra"]))
    parts += tail_test(d["starter"])
    parts += check_tests(d["checks"])
    if d["fuzz"]:
        parts += fuzz_test(d["fuzz"])
    return "\n".join(parts)


def fence(code, lang="python"):
    code = code.rstrip("\n")
    assert "```" not in code
    return "```%s\n%s\n```" % (lang, code)


def emit(chapters, title, header):
    o = ["# " + title] + header
    for cid, t, outc in chapters:
        o.append("stage: %s | %s | %s" % (cid, t, outc))
    o.append("")
    ids = [d["id"] for _, d in LESSONS]
    dup = {i for i in ids if ids.count(i) > 1}
    assert not dup, dup
    order = [c for c, _, _ in chapters]
    lessons = sorted(LESSONS, key=lambda x: order.index(x[0]))  # stable: file order within a chapter
    prev = None
    for cid, d in lessons:
        o.append("## " + d["title"])
        o.append("id: " + d["id"])
        o.append("stage: " + cid)
        if prev:
            o.append("needs: " + prev)
        o.append("minutes: %d" % (15 if d["project"] else 5))
        # The story line sits under the title, like boot.dev's opening line.
        o.append("goal: " + d["story"])
        title_, url = DOCS[d["doc"]]
        o.append("source: %s | %s" % (title_, url))
        if d.get("show"):
            o.append("show: %s -> %s" % (d["show"][0], d["show"][1]))
        if d["project"]:
            o.append("project: true")
        o.append("")
        o.append("### Assignment")
        o.append("")
        if d["kind"] == "write":
            o.append(d["assign"])
            o.append("")
            o.append("::: write lang=python")
            o.append("task: Press **Run** to see the console, and **Submit** to check your code.")
            o.append("starter:")
            o.append(fence(d["starter"]))
            o.append("tests:")
            o.append(fence(tests_for(d)))
            o.append("solution:")
            o.append(fence(d["solution"]))
            for why, code in d["wrong"]:
                o.append("wrong: " + why)
                o.append(fence(code))
            o.append("hint: " + d["hint"])
            o.append(":::")
        else:
            o.append("What does this code print? Trace it line by line, then type the console output exactly.")
            o.append("")
            o.append("::: predict lang=python")
            o.append("q: What does this print?")
            o.append("code:")
            o.append(fence(d["code"]))
            o.append("answer:")
            o.append(fence(d["answer"], ""))
            o.append("why: " + d["why"])
            o.append(":::")
        o.append("")
        prev = d["id"]
    return "\n".join(o)
