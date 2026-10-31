# Test checklist

Manual test cases, one section per feature. Update this file in the same
commit as the feature: add cases for new behavior, and re-run the affected
cases before marking a phase done.

**Status:** ✅ pass · ❌ fail · ⏳ not run yet · 🚫 blocked (reason in Notes)
**Setup for every case:** harness running (`npm run dev` in the repo root),
app open in Expo Go (see README → Getting started).

Automated checks run on every commit through pre-commit (Prettier, expo lint,
tsc for mobile; ESLint and typecheck for root). They are not listed here.

## Phase 0: App shell

| ID | Case | Steps | Expected | Status | Last run | Notes |
|---|---|---|---|---|---|---|
| SH-1 | App launches | Open the app in Expo Go | Learn tab shows, no error screen | ✅ | 2026-10-31 | Emulator. The first launch after a cold boot can hit the "runtime not ready" startup race; Reload fixes it |
| SH-2 | Four tabs | Tap Learn, Review, Progress, Profile | Each tab opens with its title; Review/Progress/Profile are placeholders | ⏳ | | |
| SH-3 | Server URL from env | Set `EXPO_PUBLIC_SERVER_URL`, then `npx expo start --clear` | App talks to that server | ✅ | 2026-10-31 | 192.168.0.139:3000 |
| SH-4 | Server unreachable | Stop `npm run dev`, pull to refresh on Learn | Error message shows in the list, app doesn't crash | ⏳ | | |

## Phase 0: Lessons (session list)

| ID | Case | Steps | Expected | Status | Last run | Notes |
|---|---|---|---|---|---|---|
| LS-1 | List sessions | Open Learn | Harness sessions listed, newest first | ✅ | 2026-10-31 | |
| LS-2 | Session status | Session with an unanswered question | Row shows "Question waiting" | ✅ | 2026-10-31 | |
| LS-3 | Busy status | Open a list while a turn runs | Row shows "Working…" | ⏳ | | |
| LS-4 | Pull to refresh | Create a session on the web, pull down on Learn | New session appears | ⏳ | | |
| LS-5 | Start a lesson | Type a topic in "What do you want to learn?", send | Session created, chat opens, the opening message is sent once | ✅ | 2026-10-31 | Phone, "Try sommes" |
| LS-6 | List refreshes after a turn | Finish a turn, go back to Learn | Row's date/status updated | ⏳ | | |

## Phase 0: Chat

| ID | Case | Steps | Expected | Status | Last run | Notes |
|---|---|---|---|---|---|---|
| CH-1 | Load a session | Tap a session | Title in header, full transcript rendered | ✅ | 2026-10-31 | |
| CH-2 | Chinese text | Session containing Traditional characters | Characters render correctly | ✅ | 2026-10-31 | |
| CH-3 | Markdown | Assistant reply with bold, lists, code | Formatted, not raw markdown | ⏳ | | |
| CH-4 | Send + stream | Type a message, send | User bubble appears at once, reply streams in, then settles | ✅ | 2026-10-31 | Phone. First failed with "property 'crypto' doesn't exist"; fixed by the expo-crypto polyfill |
| CH-5 | Reattach | Leave the chat mid-turn, come back | Live reply resumes from where it was | ⏳ | | |
| CH-6 | Steer mid-turn | Send while the tutor is replying | Message added to the running turn ("Add to this turn…") | ⏳ | | |
| CH-7 | Turn error + retry | Make a turn fail (e.g. no model configured) | Red error bar; Retry re-runs | ⏳ | | |
| CH-8 | Tool activity chips | Turn uses a non-question tool | Quiet chip with the activity label | ⏳ | | |
| CH-9 | No raw `$` | Open "I want to improve my Chinese" (old message with `$yòu$`) | Pinyin shows as plain text, no `$`; real LaTeX (e.g. `\sum`) stays raw | ✅ | 2026-10-31 | Emulator. New turns: prompts now forbid LaTeX |

## Phase 0: Question dock

| ID | Case | Steps | Expected | Status | Last run | Notes |
|---|---|---|---|---|---|---|
| QD-1 | Quiz renders | Open a session with a pending quiz | Question, shuffled options, "I don't know", confidence stops, thinking field | ✅ | 2026-10-31 | |
| QD-2 | Stable shuffle | Reopen the same pending quiz | Same option order | ⏳ | | Seeded by toolCallId |
| QD-3 | Quiz answer | Pick an option, set confidence, Submit | Answered card shows answer, Correct/Not quite, explanation; tutor continues | ⏳ | | Costs an LLM turn |
| QD-4 | "I don't know" | Pick "I don't know", Submit | Confidence hidden; answer recorded as don't-know | ⏳ | | |
| QD-5 | Multi-select quiz | Quiz with multiSelect | Checkboxes; correct only when the exact set is picked | ⏳ | | |
| QD-6 | Ask with Other | ask_user_question, pick "Other…", type | Free-text field shows; answer sent as other | ⏳ | | |
| QD-9 | Ask answer | Pick an option on an ask_user_question, Submit | Answered card shows the choice; tutor continues | ✅ | 2026-10-31 | Phone, "Try sommes" (two asks) |
| QD-7 | Text answer | explain/recall question | Single "Your answer" field; Submit disabled while empty | ⏳ | | |
| QD-8 | Answers match web | Answer on mobile, open the session on web | Web shows the same answered card | ⏳ | | |

## Known issues

| Issue | Status |
|---|---|
| LaTeX in teacher output shows raw (`$háishi$`) | Fixed 2026-10-31: prompts forbid LaTeX; the app unwraps `$…$` around plain text. Real math (`$$\sum…$$`) still shows raw: no math rendering on mobile |
| Stale "Thinking…" row / "Working…" chip on an old settled turn | Open |
| Release APK will block plain-http LAN server | Phase 5: allow cleartext in build config |
