# CI/CD
id: cicd
blurb: Pipelines that test every change and ship the good ones: GitHub Actions workflows, matrices and caches, jobs that depend on jobs, secrets and OIDC, images, environments and safe deploys.
why: Once you can write code, run it on Linux and package it in a container, CI/CD is what makes it a team habit: every push is tested the same way, and a release is a button, not a ritual. SRE and cloud jobs read and fix these pipelines every week.
stage: pipelines | Pipelines | Turn every push into a test run that fails fast and says why.
stage: ship | Shipping safely | Give a pipeline only the access it needs, build the image once, and deploy in steps you can undo.

## What continuous integration is
id: ci-why
stage: pipelines
needs: git/remotes
minutes: 30
goal: Say what CI is for, and write a check script that stops at the first failure.
source: GitHub Docs: Understanding GitHub Actions | https://docs.github.com/en/actions/get-started/understand-github-actions
source: Martin Fowler: Continuous Integration | https://martinfowler.com/articles/continuousIntegration.html

Two people branch from `main` on Monday. Each works for two weeks, and each branch passes its own tests. On the Friday of the second week both merge, and nothing works: one renamed a function the other started calling in six new places. Neither change was wrong. They were only wrong together, and nobody found out until the cost of finding out was a lost day.

Continuous integration is the habit that makes that day small. Everyone merges into the mainline often, at least daily, and every merge is checked by an automated build that runs the tests. If the build fails, fixing it is the team's first job. The tool is not the point: a CI server that runs on long-lived branches that merge monthly is not continuous integration. The point is that "does it work with everyone else's code?" is answered in minutes, many times a day, while the change is still small and fresh in your head.

### What a pipeline does

A pipeline is the script that runs on each push. It usually installs dependencies, runs a linter, runs the tests, and sometimes builds an artifact such as a package or a container image. It runs on a clean machine, a **runner**, not on your laptop. That matters: a clean machine has none of the files you forgot to commit, none of the packages you installed by hand last year, and none of the environment variables in your shell profile. "It works on my machine" stops being an argument when the machine that decides is the same for everyone.

On GitHub the pipeline is a **workflow**: a YAML file in `.github/workflows/`. An **event**, such as a push or a pull request, triggers it. A workflow has **jobs**, and each job runs on its own fresh runner. A job is a list of **steps**, and each step either runs a shell command or uses an **action**, which is a reusable step someone published, such as checking out the repository.

### A failure must fail

The most common broken pipeline is one that is always green. A step runs three commands, the second one fails, the third one succeeds, and the step reports the exit code of the last command: success. The tests failed and the build is green. Shells do this by default. A bash script carries on after a failing command unless you tell it not to.

```bash
set -euo pipefail
```

`-e` stops the script at the first command that fails. `-u` makes a reference to an unset variable an error instead of an empty string, which catches typos like `$TAG` for `$TAGS`. `-o pipefail` makes a pipeline fail if any command in it fails, not only the last: without it, `pytest | tee log.txt` succeeds whenever `tee` does. GitHub's `run:` steps on Linux already use `bash -e`, but scripts you call from a step do not inherit that, so put the line at the top of every script.

### Where it breaks

A flaky test, one that fails one run in twenty, teaches everyone to press "re-run" without reading the log. Then a real failure gets re-run too. Fix or quarantine flaky tests quickly. A pipeline that takes forty minutes teaches people to batch changes, which brings back the big Friday merge. Keep the feedback fast: run the quick checks first, and split slow suites so they run in parallel.

::: quiz
q: A team runs a CI server on every branch, but feature branches live for a month before they merge. What is missing for this to be continuous integration?
- A faster CI server, so each branch's build finishes sooner
+ Merging into the mainline often, so the combined code is what gets tested
- Running the tests twice, once on the branch and once on main
- A rule that only one branch may be open at a time
why: CI checks the integrated code. A month-long branch is tested alone, and the integration problems wait for the merge. The tool runs builds; the practice of merging often is what makes them useful.
:::

::: shell
task: `check.sh` runs three checks, and the second one fails, yet the script exits 0, so CI would show it as green. Add one line at the top of `check.sh` (below the `#!`) so the script stops at the first failing command, treats unset variables as errors, and fails a pipeline when any part of it fails. Then run `bash check.sh; echo "exit=$?"`.
file: check.sh
```bash
#!/usr/bin/env bash
echo "lint: ok"
grep -q "def test_" tests.py   # the tests are missing, so this fails
echo "all checks passed"
```
file: tests.py
```python
# no tests yet
```
verify:
```bash
head -3 check.sh | grep -Eq '^set -(euo pipefail|eu -o pipefail|e -u -o pipefail|ueo pipefail)' || { echo "check.sh doesn't start with set -euo pipefail"; exit 1; }
if bash check.sh >/dev/null 2>&1; then echo "check.sh still exits 0"; exit 1; fi
bash check.sh 2>/dev/null | grep -q "all checks passed" && { echo "the script ran past the failing check"; exit 1; }
exit 0
```
solution:
```bash
sed -i.bak '1a\
set -euo pipefail
' check.sh && rm check.sh.bak
bash check.sh; echo "exit=$?"
```
hint: The line is `set -euo pipefail`, on line 2, right under `#!/usr/bin/env bash`. You can edit the file with `sed`, or rewrite it with `printf` or a heredoc.
:::

::: card
q: What do `-e`, `-u` and `-o pipefail` each do in `set -euo pipefail`?
answer: `-e` stops the script at the first failing command. `-u` makes an unset variable an error instead of an empty string. `-o pipefail` makes a pipeline fail when any command in it fails, not only the last one.
:::

## A first GitHub Actions workflow
id: gha-workflow
stage: pipelines
needs: ci-why, python/pytest
minutes: 35
goal: Write a workflow that runs the tests on every push and pull request.
source: GitHub Docs: Workflow syntax for GitHub Actions | https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
source: GitHub Docs: Building and testing Python | https://docs.github.com/en/actions/tutorials/build-and-test-code/python

A workflow is one YAML file. The file's location is part of the contract: GitHub only looks in `.github/workflows/` on the branch that the event happened on. The name of the file does not matter, but its keys do, and a typo in a key is often not an error, just a setting that silently does nothing.

```yaml
name: tests
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - run: pip install -r requirements.txt
      - run: pytest -q
```

Read it top to bottom. `on` lists the events. A push to `main` runs it, and so does every pull request, whatever branch it targets. `jobs` is a mapping from a job id, here `test`, to the job. `runs-on` picks the runner image; `ubuntu-latest` is a fresh Linux virtual machine that GitHub hosts and throws away afterwards.

The runner starts empty. That is why the first step is `actions/checkout`: without it there is no code on the machine, and `pytest` finds nothing. `uses:` runs an action, which is a step someone else wrote. The `@v4` after the name pins a version. `with:` passes inputs to the action, and `setup-python` takes the Python version you want. `run:` runs a shell command. Each `run` is a fresh shell, but every step of a job shares the same working directory on the same machine, so the files from checkout and the packages from `pip install` are there for the next step.

### YAML that bites

Quote version numbers. `python-version: 3.10` is the number 3.1 to YAML, and you get Python 3.1, which does not exist on the runner. `"3.10"` is a string and means what you wrote. Indentation is structure. A step that is indented one level too little is no longer in `steps`. A key at the wrong level, such as `runs-on` under `steps`, is a validation error at best.

### When it runs, and on what

The push trigger and the pull request trigger test different code. A push runs on the commit you pushed. A pull request runs on a merge of your branch into the target branch, so it catches the case where your branch passes but the combination with `main` does not. That is exactly the integration question from the last lesson.

`workflow_dispatch:` adds a "Run workflow" button in the Actions tab, which is handy for a job you want to start by hand. `schedule:` with a `cron:` line runs it on a timer, in UTC, which is how teams run a nightly suite or a weekly dependency check.

::: config lang=yaml
task: Finish this workflow so it runs on pushes to `main` and on every pull request, checks the code out, sets up Python `"3.13"` (quoted), installs `requirements.txt`, and runs `pytest -q`.
starter:
```yaml
name: tests
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pytest -q
```
check: name = tests | The workflow is called tests
check: on.push.branches has main | It runs on pushes to main
check: on exists | It has triggers
check: jobs.test.runs-on = ubuntu-latest | The job runs on ubuntu-latest
check: jobs.test.steps[0].uses ~ /^actions\/checkout@/ | The first step checks the code out
check: jobs.test.steps[1].uses ~ /^actions\/setup-python@/ | The second step sets up Python
check: jobs.test.steps[1].with.python-version = "3.13" | Python is "3.13", quoted so YAML keeps it a string
check: jobs.test.steps[2].run ~ /pip install -r requirements\.txt/ | Then it installs requirements.txt
check: jobs.test.steps[-1].run = pytest -q | The last step runs pytest -q
solution:
```yaml
name: tests
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - run: pip install -r requirements.txt
      - run: pytest -q
```
hint: Add `pull_request:` under `on`, at the same indentation as `push:`. Steps run in order: `uses: actions/checkout@v4`, then `uses: actions/setup-python@v5` with a `with:` block, then the two `run:` steps.
:::

::: quiz
q: A workflow sets `python-version: 3.10` without quotes. What does setup-python receive?
- "3.10", because version numbers are always strings in workflows
+ The number 3.1, because YAML reads 3.10 as a float, so it asks for Python 3.1
- An error from YAML, because versions must be quoted
- The newest 3.x release, because the patch part is dropped
why: YAML parses unquoted 3.10 as the float 3.1. The action is then asked for a version that does not exist. Quote every version.
:::

::: card
q: Why does a pull_request run test something a push run of the same branch does not?
answer: A pull_request run checks out a merge of the branch into the target branch, so it tests your change combined with the latest target. A push run tests only the commit you pushed.
:::

## Matrices, caches, and fast feedback
id: gha-matrix
stage: pipelines
needs: gha-workflow, python/comprehensions
minutes: 40
goal: Test across versions with a matrix, cache dependencies, and know what a cache key decides.
source: GitHub Docs: Running variations of jobs in a workflow | https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations
source: GitHub Docs: Dependency caching reference | https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching

A library promises to work on Python 3.12 and 3.13, on Linux and macOS. Four combinations. Copying the job four times works until someone edits three of them. A **matrix** writes the job once and lets GitHub expand it.

```yaml
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        python: ["3.12", "3.13"]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
      - run: pytest -q
```

Each key under `matrix` is a list, and the job runs once for every combination: the cartesian product. `${{ matrix.os }}` is an **expression**, filled in per combination. `exclude:` removes combinations you do not need, and `include:` adds extra ones or adds a key to some of them. By default `fail-fast` is true: the first failing combination cancels the rest. That saves runner minutes but hides information. With `fail-fast: false` you see that only macOS on 3.13 fails, which is usually the most useful sentence in the whole log.

### Caching

Every run starts on a clean machine, so every run downloads the same packages again. A cache saves a directory at the end of a run and restores it at the start of the next. `setup-python` can do this for pip with `cache: pip`. The general tool is `actions/cache`, which takes a `path` and a `key`.

The key decides everything. If the key matches a saved cache exactly, it is restored. A good key includes what the cached content depends on, usually a hash of the lock file: `pip-${{ runner.os }}-${{ hashFiles('requirements.txt') }}`. When the requirements change, the hash changes, the key misses, and the run installs fresh and saves a new cache. A key without the hash restores stale packages forever. A key with something that changes every run, such as the commit SHA, never hits at all.

### Fast feedback

Order the work so the cheapest check that can fail runs first. A lint step that takes ten seconds should fail before a test suite that takes ten minutes. Split jobs that do not depend on each other, because separate jobs run in parallel on separate runners. The goal is a red build within a few minutes of the push, while you still remember what you changed.

::: write lang=python
task: |
  A CI matrix runs a job once for every combination of its lists. Write `expand(matrix)` that returns the combinations as a list of dicts, in the order GitHub lists them: the first key changes slowest. An optional `"exclude"` key holds a list of partial dicts; drop every combination that matches all the keys of any one of them.
starter:
```python
def expand(matrix):
    return [matrix]
```
tests:
```python
from solution import expand

# wrong answer tested: return [matrix], one job with lists instead of one job per combination
def test_product_order():
    m = {"os": ["ubuntu", "macos"], "py": ["3.12", "3.13"]}
    assert expand(m) == [
        {"os": "ubuntu", "py": "3.12"},
        {"os": "ubuntu", "py": "3.13"},
        {"os": "macos", "py": "3.12"},
        {"os": "macos", "py": "3.13"},
    ]

def test_exclude_partial():
    m = {"os": ["ubuntu", "macos"], "py": ["3.12", "3.13"], "exclude": [{"os": "macos", "py": "3.12"}]}
    assert {"os": "macos", "py": "3.12"} not in expand(m)
    assert len(expand(m)) == 3

def test_exclude_by_one_key():
    m = {"os": ["ubuntu", "macos"], "py": ["3.12", "3.13"], "exclude": [{"os": "macos"}]}
    assert expand(m) == [{"os": "ubuntu", "py": "3.12"}, {"os": "ubuntu", "py": "3.13"}]

def test_single_list():
    assert expand({"py": ["3.13"]}) == [{"py": "3.13"}]
```
solution:
```python
from itertools import product

def expand(matrix):
    excludes = matrix.get("exclude", [])
    keys = [k for k in matrix if k != "exclude"]
    combos = [dict(zip(keys, values)) for values in product(*(matrix[k] for k in keys))]
    return [c for c in combos if not any(all(c.get(k) == v for k, v in ex.items()) for ex in excludes)]
```
hint: `itertools.product(*lists)` gives every combination with the first list changing slowest, which is the order you need. `dict(zip(keys, values))` turns one combination into a dict. A combination is excluded when every key of some exclude dict has the same value in it.
:::

::: quiz
q: A cache step uses `key: pip-${{ github.sha }}`. What happens?
- The cache is restored on every run, because the SHA is always set
+ It never hits: every commit has a new SHA, so every run saves a cache nobody restores
- It hits only when requirements.txt changes
- It works like hashFiles('requirements.txt'), since the SHA covers every file
why: A key must change exactly when the cached content should change. The commit SHA changes on every push, so nothing is ever restored. Hash the lock file instead.
:::

::: card
q: What does `fail-fast: false` give you in a matrix, and what does it cost?
answer: Every combination runs to the end even after one fails, so you see exactly which combinations break. It costs runner minutes on the combinations that would have been cancelled.
:::

## Jobs that depend on jobs
id: gha-needs
stage: pipelines
needs: gha-matrix
minutes: 40
goal: Order jobs with needs, pass files between them as artifacts, and gate a job with if.
source: GitHub Docs: Using jobs in a workflow | https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs
source: GitHub Docs: Store and share data with workflow artifacts | https://docs.github.com/en/actions/tutorials/store-and-share-data

Jobs in a workflow run at the same time unless you say otherwise. That is the fast default, and it is wrong for a release: you want to build once, test what you built, and deploy only if the tests passed. `needs:` turns the jobs into a graph.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python -m build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: dist
      - run: pip install *.whl && pytest -q
  deploy:
    needs: [build, test]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: echo "deploying"
```

`needs: build` means `test` waits for `build` and is skipped if `build` fails. A list waits for all of them. Each job runs on its own fresh runner, so files do not travel from one job to the next by themselves. An **artifact** is how they do: `upload-artifact` stores a directory with the run, and `download-artifact` fetches it in a later job. That is how "build once, test what you built" is made real. Rebuilding in each job tests a different build from the one you deploy.

### Conditions

`if:` decides whether a job or a step runs. It is an expression over the run's **contexts**: `github.ref` is the branch or tag, `github.event_name` is the trigger, and functions such as `success()`, `failure()` and `always()` look at what happened before. `if: github.ref == 'refs/heads/main'` keeps a pull request from deploying. `if: failure()` on a step runs it only when an earlier step failed, which is the place for "upload the logs" or "post to the channel".

A job that is skipped by its `if` counts as skipped, not failed, and jobs that need it are skipped too. A branch-protection rule that requires a check to pass must therefore name a job that always runs, or a skipped job can leave a pull request waiting forever.

### The graph is the plan

When a pipeline grows, read its `needs` as a graph. The order the jobs can run in is a topological order of that graph: every job after the jobs it needs. Jobs with no edge between them run in parallel. A cycle, a job that needs a job that needs it, is an error the workflow cannot start with.

::: write lang=python
task: |
  Write `run_order(jobs)` where `jobs` maps each job name to the list of jobs it needs. Return the job names in an order that runs every job after everything it needs. When several jobs are ready at once, take them alphabetically. Raise `ValueError` if a job needs a job that doesn't exist, or if the needs form a cycle.
starter:
```python
def run_order(jobs):
    return list(jobs)
```
tests:
```python
from solution import run_order

def raises_value_error(jobs):
    try:
        run_order(jobs)
    except ValueError:
        return True
    return False

# wrong answer tested: return list(jobs), the file order, which runs deploy before test here
def test_chain():
    assert run_order({"deploy": ["test"], "test": ["build"], "build": []}) == ["build", "test", "deploy"]

def test_parallel_alphabetical():
    jobs = {"build": [], "lint": [], "test": ["build"], "deploy": ["lint", "test"]}
    assert run_order(jobs) == ["build", "lint", "test", "deploy"]

def test_unknown_need():
    assert raises_value_error({"deploy": ["tset"]})

def test_cycle():
    assert raises_value_error({"a": ["b"], "b": ["a"]})
```
solution:
```python
def run_order(jobs):
    for name, needs in jobs.items():
        for n in needs:
            if n not in jobs:
                raise ValueError(f"{name} needs {n}, which doesn't exist")
    done = []
    left = dict(jobs)
    while left:
        ready = sorted(name for name, needs in left.items() if all(n in done for n in needs))
        if not ready:
            raise ValueError("the needs form a cycle: " + ", ".join(sorted(left)))
        name = ready[0]
        done.append(name)
        del left[name]
    return done
```
hint: Repeat: find the jobs whose needs are all done, take the alphabetically first one, mark it done. If jobs are left but none is ready, there is a cycle. Check for unknown names before you start.
:::

::: config lang=yaml
task: Make `test` wait for `build`, and make `deploy` wait for both and run only on the `main` branch (`github.ref == 'refs/heads/main'`).
starter:
```yaml
name: release
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: python -m build
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pytest -q
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploying
```
check: jobs.test.needs ~ /build/ | test needs build
check: jobs.deploy.needs has build | deploy needs build
check: jobs.deploy.needs has test | deploy needs test
check: jobs.deploy.if ~ /github\.ref\s*==\s*'refs\/heads\/main'/ | deploy runs only on main
check: jobs.build.needs missing | build needs nothing
solution:
```yaml
name: release
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: python -m build
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: pytest -q
  deploy:
    needs: [build, test]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: echo deploying
```
hint: `needs:` takes one job id or a list in brackets. `if:` sits at the job level, next to `runs-on`, and the branch name in the comparison is in single quotes.
:::

::: quiz
q: `build` writes `dist/app.whl`, and `test` (with `needs: build`) runs `pip install dist/app.whl`. The install fails with "file not found". Why?
- needs: makes test run before build
+ Each job runs on a fresh runner, so build's files aren't there unless build uploads them as an artifact and test downloads it
- The wheel must be committed to the repository for the second job to see it
- Jobs share a disk, but dist/ is cleaned between jobs
why: needs only orders the jobs. Every job starts on a clean machine. upload-artifact and download-artifact carry files from one job to another.
:::

## Secrets, permissions, and OIDC
id: gha-oidc
stage: ship
needs: gha-needs, cloud/iam
minutes: 40
goal: Give a workflow least-privilege permissions, and reach AWS with a short-lived OIDC role instead of stored keys.
source: GitHub Docs: Security hardening with OpenID Connect | https://docs.github.com/en/actions/concepts/security/openid-connect
source: GitHub Docs: Controlling permissions for GITHUB_TOKEN | https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/control-jobs-and-steps
source: GitHub Docs: Security hardening for GitHub Actions | https://docs.github.com/en/actions/reference/security/secure-use

A deploy job needs to talk to AWS. The quick way is to make an IAM user, create an access key, and paste it into the repository's secrets as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. It works, and it is a long-lived password that can do whatever the user can do, from anywhere, until someone remembers to rotate it. Keys like that leak through logs, forks and laptops, and they are a favourite target.

### OpenID Connect: no stored key

With **OIDC**, the workflow proves who it is instead of holding a secret. When a job asks, GitHub issues a short-lived signed token that says, roughly, "this is a run of repository `acme/api`, on branch `main`, in environment `production`". In AWS you create an IAM role that trusts GitHub's identity provider, with a condition on those claims: only this repository, only this branch. The job exchanges the token for temporary credentials for that role, valid for about an hour. Nothing is stored in GitHub, and a stolen log contains nothing reusable.

```yaml
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy
          aws-region: eu-central-1
      - run: aws s3 sync site/ s3://acme-site
```

`id-token: write` lets the job request the OIDC token. It does not let the job write anything else. The trust policy's condition on the `sub` claim, such as `repo:acme/api:ref:refs/heads/main`, is what stops another repository, or another branch of yours, from assuming the role. A role that trusts every repository under the provider is a role for everyone on GitHub.

### GITHUB_TOKEN and permissions

Every run gets a `GITHUB_TOKEN` for the repository itself. What it may do depends on the repository's default setting, which on older repositories is read and write. Set `permissions:` at the top of the workflow to exactly what it needs, usually `contents: read`, and widen it per job: `packages: write` for the job that pushes an image, `id-token: write` for the job that deploys. Once you list any permission, every permission you did not list is none.

### Secrets that remain

Some things are still secrets: a third-party API token, a signing key. Store them as repository or environment secrets and read them as `${{ secrets.NAME }}`. GitHub masks them in logs, but a masked secret can still leak if a step base64-encodes it or writes it to an artifact. Workflows triggered by pull requests from forks don't get your secrets at all, which is the reason a fork's pull request cannot run your deploy. Do not work around that with `pull_request_target` and a checkout of the fork's code: that hands untrusted code your secrets.

::: config lang=yaml
task: This deploy workflow uses stored access keys. Switch it to OIDC: give the workflow `id-token: write` and `contents: read` permissions, and replace the two key inputs with `role-to-assume: arn:aws:iam::123456789012:role/gha-deploy`. Keep the region.
starter:
```yaml
name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: eu-central-1
      - run: aws s3 sync site/ s3://acme-site
```
check: permissions.id-token = write | The workflow may request an OIDC token
check: permissions.contents = read | The token can only read the repository
check: jobs.deploy.steps[1].with.role-to-assume = arn:aws:iam::123456789012:role/gha-deploy | It assumes the deploy role
check: jobs.deploy.steps[1].with.aws-access-key-id missing | No stored access key id
check: jobs.deploy.steps[1].with.aws-secret-access-key missing | No stored secret key
check: jobs.deploy.steps[1].with.aws-region = eu-central-1 | The region is unchanged
solution:
```yaml
name: deploy
on:
  push:
    branches: [main]
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy
          aws-region: eu-central-1
      - run: aws s3 sync site/ s3://acme-site
```
hint: `permissions:` is a top-level key, next to `on` and `jobs`. In the action's `with:` block, delete the two key lines and add `role-to-assume:`.
:::

::: quiz
q: An IAM role trusts GitHub's OIDC provider with no condition on the `sub` claim. What can assume it?
- Only workflows in the repository that created the role
+ A workflow in any repository on GitHub that requests a token for that audience
- Nothing, because a role without conditions is disabled
- Only workflows running on the main branch
why: The provider vouches for every GitHub repository. The condition on sub (repo, branch, environment) is what narrows trust to yours. Without it, anyone's workflow can get your credentials.
:::

::: card
q: Once a workflow lists one permission under `permissions:`, what happens to the permissions it didn't list?
answer: They become none. Listing permissions switches GITHUB_TOKEN from the repository default to exactly what you listed, so list everything the jobs need, and widen it per job where only one job needs more.
:::

## Build the image once
id: gha-images
stage: ship
needs: gha-oidc, containers/registries
minutes: 35
goal: Build and push a container image tagged with the commit, so the image you tested is the image you deploy.
source: GitHub Docs: Publishing Docker images | https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images
source: Docker Docs: GitHub Actions | https://docs.docker.com/build/ci/github-actions/

A deploy that runs `docker build` on the production host builds a new image every time. It can pull a newer base image, a newer package, a different result. The image that passed the tests is gone. The rule is to build once, in CI, give the image a name that cannot move, push it to a registry, and deploy that exact name.

```yaml
permissions:
  contents: read
  packages: write
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/api:${{ github.sha }}
```

`setup-buildx-action` turns on BuildKit, which the build action uses. `login-action` signs in to the GitHub Container Registry with the run's own token, which is why the job needs `packages: write`. `build-push-action` builds the Dockerfile at the repository root and pushes the tag.

### Tags that do not move

The tag is `${{ github.sha }}`, the full commit hash. It names one commit forever, so "which code is running?" has an exact answer, and a rollback is a deploy of the previous SHA. `latest` is the opposite: every push moves it, two hosts pulling it a minute apart can run different code, and nobody can tell which. It's fine to also push a friendly tag such as `main` or `v1.4.2` for people, but deploy by the SHA, or better by the image's **digest** (`@sha256:…`), which identifies the bytes themselves.

### Faster builds

Each run starts on a clean machine with an empty build cache, so every layer rebuilds. `build-push-action` can save and load BuildKit's cache with `cache-from: type=gha` and `cache-to: type=gha,mode=max`, which keeps it in the Actions cache. The Dockerfile's layer order still matters most: copy the dependency list and install before copying the source, so a code change does not reinstall every package.

::: config lang=yaml
task: Finish the image job. Let it push packages, log in to `ghcr.io`, and build and push the image tagged `ghcr.io/acme/api:${{ github.sha }}`, not `latest`.
starter:
```yaml
name: image
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/api:latest
```
check: permissions.packages = write | The job may push to the registry
check: permissions.contents = read | It can still only read the repository
check: jobs.image.steps[uses=docker/login-action@v3].with.registry = ghcr.io | It logs in to ghcr.io
check: jobs.image.steps[uses=docker/build-push-action@v6].with.push = true | The build pushes
check: jobs.image.steps[uses=docker/build-push-action@v6].with.tags ~ /^ghcr\.io\/acme\/api:\$\{\{\s*github\.sha\s*\}\}$/ | The tag is the commit SHA
solution:
```yaml
name: image
on:
  push:
    branches: [main]
permissions:
  contents: read
  packages: write
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/api:${{ github.sha }}
```
hint: Add `packages: write` under `permissions`. Put a `docker/login-action@v3` step before the build, with `registry`, `username` and `password` under `with:`. Change the tag to end in `${{ github.sha }}`.
:::

::: quiz
q: Two servers deploy `ghcr.io/acme/api:latest` a minute apart, and a push lands in between. What runs?
- The same image on both, because latest is resolved once per workflow
+ Possibly different code on each server, because latest moved between the two pulls
- An error on the second server, because latest is locked during a push
- The older image on both, because registries cache latest for an hour
why: A tag is a movable pointer. latest moves on every push, so two pulls can get two images. Deploy by commit SHA or digest so every server runs the same bytes.
:::

## Environments and safe deploys
id: gha-deploys
stage: ship
needs: gha-images
minutes: 40
goal: Deploy through an environment with approval and one deploy at a time, and decide when a canary is safe to promote.
source: GitHub Docs: Managing environments for deployment | https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
source: DORA: Software delivery performance metrics | https://dora.dev/guides/dora-metrics-four-keys/

A deploy is the moment a pipeline touches users. Two things go wrong in practice: two deploys run at once and leave the system half one version and half the other, and a bad version reaches every user before anyone notices. GitHub gives you tools for the first; deployment strategy handles the second.

### Environments

`environment: production` on a job ties it to an **environment** you configure in the repository settings. An environment can require a reviewer to approve before the job starts, restrict which branches may deploy to it, and hold its own secrets, so the production database password is only visible to jobs that deploy to production, after approval. The OIDC token also carries the environment, so an AWS role can trust "production of this repository" and nothing else.

`concurrency:` gives runs a group name. Only one run in a group is active at a time. With `cancel-in-progress: false`, a new deploy waits for the current one to finish instead of interrupting it halfway, which is what you want for production. For a pull request's test run, `cancel-in-progress: true` is the opposite trade: a newer push makes the older run pointless.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    concurrency:
      group: deploy-production
      cancel-in-progress: false
    steps:
      - run: ./deploy.sh ghcr.io/acme/api:${{ github.sha }}
```

### Strategies

A **rolling** deploy replaces instances a few at a time, so capacity stays up, and for a while both versions serve traffic. **Blue/green** runs the new version beside the old one and switches the traffic at once, so a rollback is switching back. A **canary** sends a small share of the traffic, say 5%, to the new version, compares its error rate and latency with the old version's, and only then promotes it to everyone. It needs enough requests to compare: ten requests with one error says nothing; ten thousand do.

### Measuring delivery

DORA's research reduces delivery performance to a few numbers: how often you deploy, how long a commit takes to reach production, how often a deploy causes a failure, and how long it takes to recover from one. Teams that deploy small changes often do better on all of them at once. Speed and stability are not a trade-off; small, frequent, reversible deploys are how you get both.

::: write lang=python
task: |
  Write `canary_decision(canary_errors, canary_requests, base_errors, base_requests, margin=0.01, min_requests=1000)`. Return `"wait"` while the canary has served fewer than `min_requests` requests. Otherwise compare error rates (errors divided by requests): return `"rollback"` if the canary's rate is more than `margin` above the baseline's rate, and `"promote"` if it isn't.
starter:
```python
def canary_decision(canary_errors, canary_requests, base_errors, base_requests, margin=0.01, min_requests=1000):
    return "promote"
```
tests:
```python
from solution import canary_decision

# wrong answer tested: always "promote", which ships a canary with 5x the errors
def test_wait_for_traffic():
    assert canary_decision(1, 10, 10, 10_000) == "wait"

def test_rollback_when_worse():
    assert canary_decision(50, 1000, 10, 10_000) == "rollback"

def test_promote_when_close():
    assert canary_decision(12, 1000, 100, 10_000) == "promote"

def test_margin_is_respected():
    assert canary_decision(30, 1000, 100, 10_000, margin=0.03) == "promote"
    assert canary_decision(30, 1000, 100, 10_000, margin=0.01) == "rollback"

def test_no_baseline_errors():
    assert canary_decision(0, 2000, 0, 10_000) == "promote"
```
solution:
```python
def canary_decision(canary_errors, canary_requests, base_errors, base_requests, margin=0.01, min_requests=1000):
    if canary_requests < min_requests:
        return "wait"
    canary_rate = canary_errors / canary_requests
    base_rate = base_errors / base_requests if base_requests else 0.0
    return "rollback" if canary_rate > base_rate + margin else "promote"
```
hint: Check the request count first. Then work out both rates as errors divided by requests, and compare the canary's rate with the baseline's rate plus the margin.
:::

::: config lang=yaml
task: Make the deploy job use the `production` environment, and put it in a concurrency group `deploy-production` that queues a new deploy instead of cancelling the running one.
starter:
```yaml
name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
```
check: jobs.deploy.environment = production | The job deploys to the production environment
check: jobs.deploy.concurrency.group = deploy-production | Deploys share one concurrency group
check: jobs.deploy.concurrency.cancel-in-progress = false | A new deploy waits instead of cancelling the running one
solution:
```yaml
name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    concurrency:
      group: deploy-production
      cancel-in-progress: false
    steps:
      - run: ./deploy.sh
```
hint: Both keys sit at the job level, next to `runs-on`. `concurrency:` is a mapping with `group:` and `cancel-in-progress:`.
:::

::: card
q: What are DORA's measures of software delivery performance?
answer: Deployment frequency, lead time for changes (commit to production), change failure rate (how often a deploy causes a failure), and how long it takes to recover from a failed deployment.
:::

## Project: a pipeline for the API
id: p-pipeline
stage: ship
needs: gha-deploys
minutes: 60
project: true
goal: Write the whole pipeline: test on two Python versions, build and push the image once, and deploy it to production through OIDC.
source: GitHub Docs: Workflow syntax for GitHub Actions | https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax

Put the module together. The API from the containers project needs one workflow, `.github/workflows/ci.yml`, that a new teammate can read top to bottom:

1. On every push and pull request, a `test` job runs `pytest -q` on Python `"3.12"` and `"3.13"` with a matrix, with `fail-fast: false`.
2. An `image` job, after `test`, builds the image and pushes it to `ghcr.io/acme/api:${{ github.sha }}`.
3. A `deploy` job, after `image` and only on `main`, runs in the `production` environment, in the `deploy-production` concurrency group, assumes `arn:aws:iam::123456789012:role/gha-deploy` with OIDC, and runs `./deploy.sh ghcr.io/acme/api:${{ github.sha }}`.

Keep the token tight: the workflow's `permissions` are `contents: read`; the image job adds `packages: write`, and the deploy job adds `id-token: write`. A job-level `permissions:` replaces the workflow-level one for that job, so list `contents: read` there too.

::: config lang=yaml
task: Write `ci.yml` as described in the lesson.
starter:
```yaml
name: ci
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pytest -q
```
check: on.pull_request exists | It runs on pull requests (an empty pull_request: is enough)
check: permissions.contents = read | The workflow token reads only
check: jobs.test.strategy.fail-fast = false | Every Python version reports
check: jobs.test.strategy.matrix.python = ["3.12", "3.13"] | The matrix tests "3.12" and "3.13" (key: python)
check: jobs.test.steps[1].with.python-version ~ /\$\{\{\s*matrix\.python\s*\}\}/ | setup-python uses the matrix version
check: jobs.test.steps[-1].run = pytest -q | The test job ends with pytest -q
check: jobs.image.needs ~ /test/ | The image job waits for the tests
check: jobs.image.permissions.packages = write | The image job may push packages
check: jobs.image.permissions.contents = read | The image job still reads the repository
check: jobs.image.steps[uses=docker/build-push-action@v6].with.tags ~ /^ghcr\.io\/acme\/api:\$\{\{\s*github\.sha\s*\}\}$/ | The image is tagged with the commit
check: jobs.deploy.needs ~ /image/ | Deploy waits for the image
check: jobs.deploy.if ~ /refs\/heads\/main/ | Deploy runs only on main
check: jobs.deploy.environment = production | Deploy uses the production environment
check: jobs.deploy.concurrency.group = deploy-production | One deploy at a time
check: jobs.deploy.permissions.id-token = write | Deploy may request an OIDC token
check: jobs.deploy.steps[uses=aws-actions/configure-aws-credentials@v4].with.role-to-assume = arn:aws:iam::123456789012:role/gha-deploy | Deploy assumes the role with OIDC
check: jobs.deploy.steps[-1].run ~ /\.\/deploy\.sh ghcr\.io\/acme\/api:\$\{\{\s*github\.sha\s*\}\}/ | Deploy ships the image it built
solution:
```yaml
name: ci
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        python: ["3.12", "3.13"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
      - run: pip install -r requirements.txt
      - run: pytest -q
  image:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/api:${{ github.sha }}
  deploy:
    needs: image
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    concurrency:
      group: deploy-production
      cancel-in-progress: false
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy
          aws-region: eu-central-1
      - run: ./deploy.sh ghcr.io/acme/api:${{ github.sha }}
```
hint: Build it one job at a time and press Check after each: the checks are in the order of the lesson's list. The second step of the test job is setup-python with `python-version: ${{ matrix.python }}`.
:::
