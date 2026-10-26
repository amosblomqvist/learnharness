// The world card: what a lesson's function did to the place, drawn as a room instead of data.

// One card is one moment in the game: where Sam stands, what's on the floor, what he carries,
// and what was just said to him. Every field except room is optional: a lesson's function
// returns what it returns, and the adapter takes what's there.
export type World = {
  room: string // room id as the lesson's function returns it ("hall")
  exits?: string[] // directions, in the order the fixture offers
  items?: string[] // on the floor, in the room's order
  bag?: string[]
  said?: string // the last line the game said about this place
}

// A lesson declares `show: play(["go cellar", "take axe"]) -> room-bag`: run the expression
// against the solution, then adapt what came back into a card. The adapter is shared by the
// Python course (play returns (room, bag)) and the TypeScript course (step returns events),
// so both languages get the same picture.
export function toCard(kind: string, v: unknown): World | null {
  if (v === null || v === undefined) return null
  if (kind === "room-bag") return roomBag(v)
  if (kind === "events") return events(v)
  return null
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x.trim() ? x : undefined
}

function strs(x: unknown): string[] | undefined {
  return Array.isArray(x)
    ? x.filter((i): i is string => typeof i === "string" && i.trim() !== "").map((i) => i.trim())
    : undefined
}

// One line of what was said: the course's `said` is a list of strings, but a plain string is
// accepted so a simpler game fits without a new adapter.
function saidOf(x: unknown): string | undefined {
  if (Array.isArray(x)) {
    const s = strs(x)?.join(" ")
    return s || undefined
  }
  return typeof x === "string" && x.trim() ? x : undefined
}

// Python's play returns (room, bag): a list whose first element is the room and second the bag.
// Anything that looks like {room, bag} works too, so a smarter game fits without a new adapter.
function roomBag(v: unknown): World | null {
  if (Array.isArray(v) && v.length === 2 && Array.isArray(v[1])) {
    const room = str(v[0])
    if (!room) return null
    return { room, bag: strs(v[1]) ?? [] }
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    const room = str(o.room ?? o.roomId ?? o.id)
    if (!room) return null
    return { room, exits: strs(o.exits ?? o.doors), items: strs(o.items ?? o.floor), bag: strs(o.bag), said: str(o.said ?? o.says) }
  }
  return null
}

// The TypeScript reducer returns a list of events ({kind, roomId, ...}): the card is the last
// place mentioned, the bag from "took" minus "dropped", and the text of the last thing said.
function events(v: unknown): World | null {
  if (!Array.isArray(v) || !v.length) return null
  const es = v.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
  let room: string | undefined
  let bag: string[] = []
  let exits: string[] | undefined
  let said: string | undefined
  for (const e of es) {
    const r = str(e.roomId ?? e.room)
    if (r) {
      if (e.kind === "moved" || e.kind === "look") room = r
      else room ??= r
    }
    if (e.kind === "took" && str(e.item)) bag.push(String(e.item))
    if (e.kind === "dropped" && str(e.item)) bag = bag.filter((i) => i !== e.item)
    if (e.kind === "look") {
      exits = strs(e.exits) ?? exits
      said = saidOf(e.said) ?? said
    }
    if (e.kind === "refused" || e.kind === "said") said = saidOf(e.said) ?? said
  }
  return room ? { room, exits, bag: bag.length ? bag : undefined, said } : null
}
