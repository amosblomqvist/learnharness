# Mandarin Tutor

React Native + Expo (SDK 58) app for Android. Its backend is the LearnHarness
Next.js server in the repo root. For now it's a single-user dev setup: the
phone reaches `next dev` on your laptop over the home Wi-Fi.

## Getting started

### 1. Prerequisites

- Node.js and npm (the same version you use for the repo root).
- The harness working on the laptop: `npm install` in the repo root, API keys
  in `auth.json` or `.env.local`, and models picked in the web UI settings.
- For a real phone: the **Expo Go** app from the Play Store, with the phone
  on the same Wi-Fi as the laptop.
- For the emulator: the Android SDK in `~/Android/Sdk` with an AVD (e.g. `lh_pixel`).

### 2. Start the harness (backend)

From the repo root:

```bash
npm run dev            # http://localhost:3000, also reachable on the LAN
```

Check it from another device: `http://<laptop-LAN-IP>:3000` should load the web UI.

### 3. Configure the app

```bash
cd mobile
npm install
cp .env.example .env.local
```

Edit `.env.local` and set your laptop's LAN IP:

```
EXPO_PUBLIC_SERVER_URL=http://192.168.0.139:3000
```

Find the IP with `ip -4 addr` (Linux). The value is baked in when the bundle
is built, so after you change it, restart Expo with `npx expo start --clear`.

### 4. Run the app

```bash
npx expo start
```

- **Phone:** open Expo Go and scan the QR code, or enter `exp://<laptop-LAN-IP>:8081`.
- **Emulator:** start it with a window, then press `a` in the Expo terminal:

  ```bash
  ~/Android/Sdk/emulator/emulator -avd lh_pixel -no-audio -gpu swiftshader_indirect &
  ```

  `swiftshader_indirect` (software GPU) avoids the host-GPU crashes seen with the
  default renderer, but it uses a lot of CPU. Close the emulator when you're done.

You should see the Learn tab listing your harness sessions.

### 5. Checks before committing

Install the git hook once per clone (run from the repo root; needs
[pre-commit](https://pre-commit.com)):

```bash
pre-commit install
```

Each commit then runs Prettier, `expo lint` and `tsc` on mobile, and ESLint
and typecheck on root files (`.pre-commit-config.yaml`). When Prettier
rewrites a file, the commit stops: re-stage the file and commit again.
To run the checks by hand:

```bash
pre-commit run --all-files   # from the repo root
npm run format               # in mobile/: format all files
npx expo-doctor              # dependency / config sanity
```

Manual feature tests live in [TESTING.md](TESTING.md). Update it along with
each feature.

Add packages with `npx expo install <pkg>`, not `npm install`, so the
versions match SDK 58. See `AGENTS.md` for Expo conventions.

> **Warning:** don't run the repo-root `npm test` against your real data. Some
> tests write into `./data` (chats, jobs, settings). Isolate them:
> `LH_DATA_DIR=$(mktemp -d)/data LH_AUTH_FILE=$(mktemp -d)/auth.json npm test`

## How it fits together

- `src/app/`: screens (Expo Router). `(tabs)/` holds Learn, Review, Progress
  and Profile; `chat/[id].tsx` is a lesson.
- The chat reuses the web client's session state machine
  (`../components/session-core.ts`) and the pure core (`../src/core`) through
  the `@web/session-core` and `@core` aliases. Send, streaming (SSE), reattach
  and question grading therefore follow the same protocol as the web UI.
- `metro.config.js` lets Metro bundle those repo-root files. It maps the
  server-only `node:crypto` to a stub that throws (`src/shims/node-crypto.ts`).
- `src/lib/server.ts`: `apiFetch` / `apiJson` against `EXPO_PUBLIC_SERVER_URL`.

## Troubleshooting

- **"Something went wrong… [runtime not ready] … EventEmitter of undefined"**
  right after the emulator boots: this is an Expo Go startup race, not a code
  bug. Force-stop Expo Go and open the app again, or use Reload in the dev menu.
- **Network request failed / empty list:** check that `npm run dev` is running,
  that the IP in `.env.local` is current (restart with `--clear` after
  changing it), and that the phone is on the same Wi-Fi with no firewall
  blocking port 3000.
- **Sending fails with "models not configured":** pick models in the web UI
  (the model pickers next to Dictate, or Settings).
- **VS Code freezes while the emulator runs:** CPU load from the software GPU.
  Click "Wait", or use a real phone.

---

## Product notes

Learn a language through the place you call home.

This gives room to expand from Taipei to Paris, Tokyo, Berlin and beyond without changing the product concept.


Yes. I think this is actually the stronger product concept.

The map is just the interface. The real product is a language-learning experience generated from the person's entire context: who they are, what they like, what they do, where they live and what they want to achieve.

The app shouldn't teach everyone the same Mandarin lesson about ordering food. It should teach each person Mandarin through situations that are relevant to their own life.
The concept: Context-driven language learning
Learn a language through your life.
1. Build a personal context profile
The app understands several dimensions of the learner:
Who you are

Background, native language, profession, age range, current language level.
What you love

Hobbies, sports, music, technology, food, travel, culture and personal interests.
Where you are

Country, city, neighbourhood, places you visit, local culture and environment.
What you do

Work, studies, professional vocabulary, daily routines and social interactions.
What you want

Goals, motivations, upcoming events, travel plans, relationships and desired fluency.
How you learn

Current proficiency, strengths, weaknesses, mistakes, preferred learning formats and progress.
2. Combine all the context to generate lessons
For example, imagine a French software engineer living in Taipei who enjoys running, robotics, hiking and electronic music.

The app could generate:









Running in Taipei

Talk about training, pace, marathon preparation and running with local friends.

Interests + city + social life











Talking about your work

Explain your job, discuss AI and robotics, and communicate with Taiwanese colleagues.

Profession + language goals











Planning a hiking trip

Discuss routes, weather, transport and weekend plans with friends.

Interests + geography + practical life











Going out in Taipei

Talk about music, invite friends, discuss events and meet new people.

Interests + culture + relationships



3. The learning engine
The personalization system should connect four things:
Personal context

Interests · Work · City · Goals · Lifestyle

Language proficiency

Level · Vocabulary · Grammar · Weaknesses

Personalized lesson generation

Relevant topics · Appropriate difficulty · Natural expressions

Learning and feedback

Listen · Speak · Read · Practise · Remember

Continuously update the learner's profile

4. The map becomes one of several interfaces
I would not make the map mandatory for every lesson.
- Map: explore your city and discover contextual learning opportunities.
- Daily learning: receive lessons adapted to your current interests and level.
- Conversations: practise realistic situations with an AI tutor.
- Vocabulary: build a personal collection of expressions encountered during learning.
- Progress: see how your language abilities evolve.
5. The real differentiator
Most language apps personalize bas




# Chapter

- Taking the youbike.
- Going to the Bank
- Night Market.
- Going to the massage.
- Going to the dentist.
- Going to the 