# Security policy

LearnHarness stores API keys, sign-in tokens, chats, and learning records on your machine, and its agent reads files and fetches web content on your behalf. If you find a way to abuse any of that, please tell us privately so a fix can ship before the details are public.

## Reporting a vulnerability

**Do not open a public issue, pull request, or Discord post for a security problem.**

Report it through GitHub's private vulnerability reporting:
[Security → Report a vulnerability](https://github.com/amosblomqvist/learnharness/security/advisories/new).

If that page is unavailable, message a maintainer on [Discord](https://discord.gg/5tCHHQEB2e) and ask for a private channel. Do not include any details in that first message.

A useful report includes:

- the LearnHarness version and your OS;
- what an attacker can do and what they need first (a web page the agent reads, a file the learner opens, network access, and so on);
- steps to reproduce, or a proof of concept;
- any fix or mitigation you have in mind.

## Security contacts

- [@amosblomqvist](https://github.com/amosblomqvist)
- [@IsaacZhangg](https://github.com/IsaacZhangg)

Use the private reporting process above for vulnerability reports. Do not report security details through public mentions.

## What to expect

These are targets, not guarantees:

| Step | Target |
| --- | --- |
| Acknowledge your report | within 7 days |
| Initial assessment (confirmed or not, severity) | within 14 days |
| Fix released and advisory published | within 90 days of the report |

The fix is developed privately in a GitHub security advisory. We will keep you updated, agree on a disclosure date with you, and credit you in the published advisory unless you prefer to stay anonymous. A CVE can be requested through GitHub when one is warranted.

## Supported versions

Only the latest release receives security fixes. The desktop app updates itself, so fixes reach users through a new release. If you run from source, update to the latest `main` or the latest release tag.

## Scope

In scope:

- the desktop app (Electron shell, window, and IPC);
- the local API server, whether started by the desktop app or run from source;
- the agent and its tools, including prompt injection from web pages, PDFs, or other content that leads to reading, changing, or sending your data;
- rendered content such as demos, figures, and markdown;
- the update and release pipeline.

Out of scope:

- attacks that already require running code as your OS user;
- bugs in third-party model or service providers themselves (report those to the provider);
- automated scanner output without a demonstrated impact on LearnHarness.
