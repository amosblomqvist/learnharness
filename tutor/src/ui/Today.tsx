// Today: the start of a study session. What's due for review (across every goal), where each goal
// picks up, questions still waiting on you, and a few honest numbers.
import type { GoalSummary } from "../api"
import * as I from "../icons"

export type ReviewInfo = {
  stats: { due: number; dueSoon: number; total: number; nextDue: number | null; reviewedWeek: number; retention: number | null; streak: number }
  due: { goalId: string; nodeId: string; title: string; goalTitle: string }[]
}

export function Today(props: {
  reviews: ReviewInfo | null
  goals: GoalSummary[]
  waiting: { conv: string; title: string }[]
  busy: boolean
  onReview: () => void
  onTeach: (goalId: string, nodeId: string) => void
  onGoal: (goalId: string) => void
  onGo: (conv: string) => void
  onNewGoal: () => void
}) {
  const { reviews, goals, waiting } = props
  const st = reviews?.stats
  const due = reviews?.due ?? []
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
  const active = goals.filter((g) => !g.drafting && g.total > 0 && g.done < g.total)
  const shown = due.slice(0, 10)
  return (
    <section className="today">
      <header className="today-head">
        <div>
          <span className="goal-kicker">Today</span>
          <h1>{date}</h1>
        </div>
      </header>
      <div className="today-body">
        {!!waiting.length && (
          <div className="tcard waiting">
            <div className="tc-h">
              <span className="live-dot waiting" /> Waiting for you
            </div>
            {waiting.map((w) => (
              <button key={w.conv} className="tc-row" onClick={() => props.onGo(w.conv)}>
                <span>A question is open in {w.title}</span>
                <I.ArrowRight size={13} />
              </button>
            ))}
          </div>
        )}

        <div className="tcard review">
          <div className="tc-h">
            <I.Clock size={14} /> Review
          </div>
          {st && st.due > 0 ? (
            <>
              <p className="tc-big">
                <b>{st.due}</b> {st.due === 1 ? "idea is" : "ideas are"} due · about {Math.max(2, Math.round(st.due * 1.5))} min
              </p>
              <div className="due-chips">
                {shown.map((d) => (
                  <span key={`${d.goalId}:${d.nodeId}`} title={d.goalTitle}>
                    {d.title}
                  </span>
                ))}
                {due.length > shown.length && <span className="more">+{due.length - shown.length}</span>}
              </div>
              <button className="btn primary" disabled={props.busy} onClick={props.onReview} title="One fresh question per due idea, then you're done">
                Start review · {st.due} <I.ArrowRight size={13} />
              </button>
            </>
          ) : (
            <p className="tc-quiet">
              {st?.total
                ? `Nothing due. ${st.nextDue ? `Next review ${relDay(st.nextDue)}` : ""}${st.dueSoon ? ` · ${st.dueSoon} this week` : ""}.`
                : "Nothing to review yet. Ideas join the schedule when they turn solid on a goal's map, and come back just before you'd forget them."}
            </p>
          )}
        </div>

        <div className="tcard">
          <div className="tc-h">
            <I.Target size={14} /> Continue
          </div>
          {active.length ? (
            active.map((g, i) => (
              <div key={g.id} className="tc-goal">
                <button className="tc-goal-t" onClick={() => props.onGoal(g.id)}>
                  <b>{g.title}</b>
                  <span className="tbar">
                    <i style={{ width: `${(g.done / g.total) * 100}%` }} />
                  </span>
                  <span className="n">
                    {g.done}/{g.total}
                  </span>
                </button>
                {g.next && (
                  <button className={`btn${i === 0 ? " primary" : ""}`} disabled={props.busy} onClick={() => props.onTeach(g.id, g.next!.id)} title="Open the map and start this node">
                    {g.next.status === "learning" ? "Continue" : "Next"}: {g.next.title}
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="tc-quiet">
              No goal in progress.{" "}
              <button className="linkish" onClick={props.onNewGoal}>
                Start one
              </button>{" "}
              (or follow the product engineer path).
            </p>
          )}
        </div>

        {st && st.total > 0 && (
          <div className="tstats">
            <div>
              <b>{st.total}</b>
              <span>ideas solid</span>
            </div>
            <div>
              <b>{st.streak}</b>
              <span>day streak</span>
            </div>
            <div>
              <b>{st.reviewedWeek}</b>
              <span>reviews this week</span>
            </div>
            <div title="Share of reviews in the last 30 days you got right (needs 5 or more)">
              <b>{st.retention === null ? "–" : `${Math.round(st.retention * 100)}%`}</b>
              <span>remembered (30 d)</span>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function relDay(t: number): string {
  const d = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5)
  return d <= 1 ? "tomorrow" : d < 7 ? `in ${d} days` : `on ${new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
}
