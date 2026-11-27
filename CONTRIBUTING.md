# Contributing to LearnHarness

Bug reports, focused fixes, documentation, reviews, and testing are welcome. LearnHarness is a maintainer-led project with a deliberate core learning experience.

## Project direction

Discuss meaningful changes to the project’s vision, teaching methodology, agent behavior, core architecture, or major workflows with maintainers **before implementation**. New features, integrations, and storage-format changes also need discussion first.

A fix restores intended behavior; changing what the intended behavior should be is a design proposal. If that behavior is unclear, discuss it first. A fix that requires major architectural or storage changes still needs agreement on the approach.

Plugins are the intended home for optional capabilities that do not belong in core. The plugin infrastructure is still under development, so discuss the use case rather than assuming a stable extension point exists.

## Before starting

Check existing issues, PRs, and the [public work board](https://github.com/users/amosblomqvist/projects/2) for related work. **In progress** means someone is already working on the problem; coordinate before starting a parallel implementation. A board item is not, by itself, agreement to implement a proposal.

- [Issues](https://github.com/amosblomqvist/learnharness/issues): concrete bugs and agreed implementation work.
- [Discussions](https://github.com/amosblomqvist/learnharness/discussions): feature ideas and substantial design proposals. Explain the problem, proposed behavior, and relevant alternatives.
- [Discord](https://discord.gg/5tCHHQEB2e): quick questions and conversation. Record actionable proposals and decisions on GitHub so others can find the context.

## Pull requests

**Keep each PR focused on one coherent problem.** Include the tests and documentation needed for that change, but leave unrelated fixes, refactors, dependency updates, and formatting changes for separate PRs. Follow the existing architecture and conventions.

Use **clear, precise, concise language**. Explain:

- The problem, with a link to the relevant issue or discussion if one exists.
- What changed and why it addresses the problem.
- How you verified it, including important limitations and anything untested.

Avoid unnecessary jargon, lengthy boilerplate, and unsupported claims. Distinguish observed behavior from hypotheses.

We judge contributions by their results, not the tools used to produce them. AI-assisted and manually written contributions follow the same standards; disclosure of AI assistance is not required. You are responsible for the accuracy of the description, implementation, tests, and documentation.

### Verification

Run relevant checks and add regression coverage where useful. Briefly describe what you actually tested and any important limitations—for example, whether you used a real provider or mocked responses.

See the [development guide](docs/development.md) for setup and check commands, and the [architecture reference](docs/architecture.md) for runtime boundaries.

## Bug reports

Include the app version and relevant environment, what you did, what you expected, and what happened. Add the provider/model when relevant and a minimal example, screenshot, or redacted error if possible. Note whether the problem repeats and any workaround you found. You do not need to know the root cause.

Do not publish credentials, tokens, private learning records, or private course materials—or use them as test fixtures. Prefer synthetic or shareable examples.

## Review and credit

Maintainers decide project direction and what is accepted. Review may lead to revisions, narrower scope, further discussion, or a decision not to proceed. Passing tests does not, by itself, establish that a proposed behavior belongs in the product.

Where suitable, we build on contributors’ implementations and work through revisions with their authors. We may integrate a contribution with finishing changes while preserving authorship and appropriate credit; adopting part of a PR is not acceptance of the whole proposal.

A PR does not guarantee acceptance or inclusion in a particular release. Integration and publication are separate; consult the [work board](https://github.com/users/amosblomqvist/projects/2) and [releases](https://github.com/amosblomqvist/learnharness/releases) for current status.

**Interested in contributing regularly?** If you’d like to help maintain LearnHarness, review and finish fixes, or support other contributors, email me at [contribute@learnharness.ai](mailto:contribute@learnharness.ai). Tell me a little about your interests and how you’d like to help.

LearnHarness is licensed under [AGPL-3.0](LICENSE).
