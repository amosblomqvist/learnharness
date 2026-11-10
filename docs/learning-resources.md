# Learning-resource referral prototype

Design discussion: https://github.com/amosblomqvist/learnharness/discussions/635 . This is an extracted reference implementation for maintainer feedback, not an agreed core feature or a stable plugin interface.

When the prober, teacher or practitioner needs an external explanation for a diagnosed torque difficulty, `learning_resources` can return an original OpenStax section, an active study task and a fresh unaided follow-up instruction. It uses a typed optional port injected by the server composition root; there is no new UI or learner-record field. The production composition makes this draft tool available; maintainers may prefer to move it behind future plugin infrastructure or keep using research alone.

The prototype accepts a short concept query. Its small local catalog recognizes torque, moment arm, force angle and radial force. Other queries return an empty list and an explicit coverage warning. It makes no network requests, downloads no teaching content, requires no search key, and writes no learner or graph state. Original access, language and copying limitations accompany the link. The existing teaching/practice tools still collect and assess answers; neither reading completion nor a graph proposition is an ability score.

Try the use case with a configured model: explain a torque difficulty, ask for a source, follow its study task, then return for a different problem without the source open. Exact tool choice and teaching behavior depend on the model. Offline tests exercise the native tool and registration in all three phases; no live provider or learner outcome has been validated.

## Source and attribution

Source metadata: OpenStax, *University Physics Volume 1*, section 10.6, Torque: https://openstax.org/books/university-physics-volume-1/pages/10-6-torque . The section locator and subject metadata were curated in the derivative project on 6 November 2026. This extraction does not assert that the page has been rechecked at submission time, and it does not reproduce textbook prose, illustrations or exercises. The study task and follow-up instruction are original project-authored guidance; external material retains its own terms. No affiliation or endorsement by OpenStax is implied.

Extracted and narrowed from https://github.com/ahammadshibil/exam-resource-orchestrator/tree/3bda879/learnharness under AGPL-3.0-only. That prototype includes larger catalogs and an independent Python assessment engine; neither is part of this change. No HackerTube database or its metadata is redistributed here.

## Verification

Relevant checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `node scripts/smoke-provider-runtime.mjs`, `node scripts/build-server.mjs`, and `node scripts/smoke-server.mjs`. The payload check requires both new prompt fragments. The full suite is intended for Linux/Node 26; some upstream permission/process tests are platform-sensitive on Windows.
