// Spaced reviews across all your goals. When a node turns solid (or known), it gets a review
// card scheduled with FSRS, the algorithm modern Anki uses: after a lesson it comes back in about
// 3 days, then 2 weeks, then 2 months, sooner whenever you miss it. A review session asks a fresh
// question on each due node (never the same card twice), and record_review moves its schedule.
// One JSON file in userData.
import { app } from "electron"
import fs from "node:fs"
import path from "node:path"
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card } from "ts-fsrs"
import type { Goal, StrategyNode } from "./goals"
import { watchOut } from "./notes"

export type ReviewRating = "again" | "hard" | "good" | "easy"
export type ReviewLog = { at: number; rating: ReviewRating; sure?: boolean; note?: string }
export type ReviewCard = { goalId: string; nodeId: string; goalTitle: string; title: string; summary: string; check?: string; card: Card; log: ReviewLog[]; created: number }
export type ReviewStats = { due: number; dueSoon: number; total: number; nextDue: number | null; reviewedWeek: number; retention: number | null; streak: number }

// No 10-minute learning steps: a node reaches its first review having just been taught and checked.
const scheduler = fsrs(generatorParameters({ enable_fuzz: true, enable_short_term: false, request_retention: 0.9, maximum_interval: 365 }))
const RATING: Record<ReviewRating, Rating.Again | Rating.Hard | Rating.Good | Rating.Easy> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy }

const file = () => path.join(app.getPath("userData"), "reviews.json")
const key = (goalId: string, nodeId: string) => `${goalId}:${nodeId}`

type Store = { cards: Record<string, ReviewCard> }
let cache: Store | null = null
let listener: (() => void) | null = null
export const onReviewsChanged = (fn: () => void) => (listener = fn)

function load(): Store {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Store
    for (const c of Object.values(raw.cards)) {
      c.card.due = new Date(c.card.due)
      if (c.card.last_review) c.card.last_review = new Date(c.card.last_review)
    }
    cache = raw
  } catch {
    cache = { cards: {} }
  }
  return cache
}
function save(): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(load()))
  listener?.()
}

// Keep the review cards in step with a goal's map: solid/known nodes have one, others don't.
export function syncGoal(g: Goal): void {
  const s = load()
  let changed = false
  const nodes = new Map((g.strategy?.nodes ?? []).map((n) => [n.id, n]))
  for (const [k, c] of Object.entries(s.cards)) {
    if (c.goalId !== g.id) continue
    const n = nodes.get(c.nodeId)
    if (!n || n.status === "todo" || n.status === "learning") {
      delete s.cards[k]
      changed = true
    } else if (c.title !== n.title || c.goalTitle !== g.title || c.summary !== n.summary) {
      Object.assign(c, { title: n.title, goalTitle: g.title, summary: n.summary, check: n.check })
      changed = true
    }
  }
  for (const n of nodes.values()) {
    if ((n.status !== "solid" && n.status !== "known") || s.cards[key(g.id, n.id)]) continue
    s.cards[key(g.id, n.id)] = newCard(g, n)
    changed = true
  }
  if (changed) save()
}

function newCard(g: Goal, n: StrategyNode): ReviewCard {
  const now = new Date()
  // Just learned and checked: a first "good". Knew it already: "easy", so it comes back later.
  const first = scheduler.next(createEmptyCard(now), now, n.status === "known" ? Rating.Easy : Rating.Good)
  return { goalId: g.id, nodeId: n.id, goalTitle: g.title, title: n.title, summary: n.summary, check: n.check, card: first.card, log: [], created: now.getTime() }
}

export function dropGoal(goalId: string): void {
  const s = load()
  const before = Object.keys(s.cards).length
  for (const [k, c] of Object.entries(s.cards)) if (c.goalId === goalId) delete s.cards[k]
  if (Object.keys(s.cards).length !== before) save()
}

// Due now (end of today counts: reviewing in the evening what's due tonight is fine).
export function dueCards(limit = 40): ReviewCard[] {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return Object.values(load().cards)
    .filter((c) => c.card.due.getTime() <= end.getTime())
    .sort((a, b) => a.card.due.getTime() - b.card.due.getTime())
    .slice(0, limit)
}

export function recordReview(goalId: string, nodeId: string, rating: ReviewRating, sure?: boolean, note?: string): { ok: boolean; text: string } {
  const s = load()
  const c = s.cards[key(goalId, nodeId)]
  if (!c) return { ok: false, text: `No review card for ${goalId}:${nodeId}. Use the goal and node ids from the due list.` }
  const now = new Date()
  c.card = scheduler.next(c.card, now, RATING[rating]).card
  c.log.push({ at: now.getTime(), rating, sure, note: note?.slice(0, 300) })
  save()
  const days = Math.max(1, Math.round((c.card.due.getTime() - now.getTime()) / 864e5))
  return { ok: true, text: `Recorded "${c.title}": ${rating}. It comes back in ${days} day${days === 1 ? "" : "s"}.` }
}

export function reviewStats(): ReviewStats {
  const cards = Object.values(load().cards)
  const now = Date.now()
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  const logs = cards.flatMap((c) => c.log)
  const month = logs.filter((l) => l.at > now - 30 * 864e5)
  // Days in a row (ending today or yesterday) with at least one review.
  const days = new Set(logs.map((l) => new Date(l.at).toDateString()))
  let streak = 0
  const d = new Date()
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1)
  while (days.has(d.toDateString())) {
    streak++
    d.setDate(d.getDate() - 1)
  }
  const future = cards.map((c) => c.card.due.getTime()).filter((t) => t > end.getTime())
  return {
    due: cards.filter((c) => c.card.due.getTime() <= end.getTime()).length,
    dueSoon: cards.filter((c) => c.card.due.getTime() > end.getTime() && c.card.due.getTime() <= end.getTime() + 7 * 864e5).length,
    total: cards.length,
    nextDue: future.length ? Math.min(...future) : null,
    reviewedWeek: logs.filter((l) => l.at > now - 7 * 864e5).length,
    retention: month.length >= 5 ? month.filter((l) => l.rating !== "again").length / month.length : null,
    streak
  }
}

// For the review session's prompt.
export function dueForPrompt(cards: ReviewCard[]): string {
  return cards
    .map((c) => {
      const last = c.log[c.log.length - 1]
      const missed = watchOut(c.goalId, c.nodeId)
      return `- goal ${c.goalId} · node ${c.nodeId} · "${c.title}" (${c.goalTitle}): ${c.summary}${c.check ? ` Check: ${c.check}` : ""}${last ? ` Last time: ${last.rating}${last.note ? ` (${last.note})` : ""}.` : " First review."}${missed.length ? `\n  Mistakes they made in lessons: ${missed.map((x) => `"${x}"`).join("; ")}` : ""}`
    })
    .join("\n")
}
