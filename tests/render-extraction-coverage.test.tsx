import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
	CoverageMenuBlock,
	CoverageMenuBody,
	CoverageRingDetail,
	CoverageRingGlyph,
	fetchGraphRead,
	requestExtract,
	ringFill,
	type SessionCoverage,
} from "../components/extraction-coverage.tsx";

/**
 * The extraction-coverage surfaces (extraction-UX redesign, owner-locked
 * dispatch 2026-09-24): the sidebar context-menu block (numbers + the
 * manual Extract affordance) and the chat top bar's ring meter. The pure
 * folds and the presentational bodies are pinned here; the live fetch
 * chains (menu-open read, the 2s running poll, the turn-settle bump, the
 * settings signal) are Playwright's beat.
 */

function coverage(over: Partial<SessionCoverage> = {}): SessionCoverage {
	return {
		totalMessages: 12,
		coveredCount: 7,
		uncoveredCount: 5,
		coveredTokens: 30_000,
		uncoveredTokens: 2_048,
		running: false,
		lastFoldedAt: null,
		...over,
	};
}

describe("fetchGraphRead — one truth with the extraction trigger (2026-10-02)", () => {
	// The meter's denominator MUST be the number the server's
	// effectiveSettings gate waits for. The old hand-rolled fallback
	// read the raw delta and guessed `?? 4096` — a stale pre-setting-era
	// constant — so an unset budget filled the ring at half the truth
	// (owner repro: 6k shown full, extraction correctly silent at the then-
	// factory 8192). The 2026-10-13 ruling restored the factory to 4096 (more
	// frequent graph updates); the LAW is unchanged — the denominator is the
	// factory the same core resolver serves, never a hand-rolled constant.
	const stub = (payload: unknown, ok = true) => {
		const real = globalThis.fetch;
		globalThis.fetch = (async () =>
				new Response(JSON.stringify(payload), { status: ok ? 200 : 500 })) as typeof fetch;
		return () => {
			globalThis.fetch = real;
		};
	};

	it("an absent graph section denominates at the factory 4096 — never a hand-rolled constant, never a missing ring", async () => {
		const restore = stub({ settings: { version: 1 } });
		const read = await fetchGraphRead();
		restore();
		assert.deepEqual(read, { enabled: true, chunkTokens: 4096 });
	});

	it("the owner repro shape — graph section present, budget never written — is the factory", async () => {
		const restore = stub({ settings: { version: 1, graph: { enabled: true } } });
		const read = await fetchGraphRead();
		restore();
		assert.equal(read?.chunkTokens, 4096, "the record lacks the key: factory, not a stale constant");
	});

	it("first boot (settings null) resolves factory — the ring shows, at the true budget", async () => {
		const restore = stub({ settings: null });
		const read = await fetchGraphRead();
		restore();
		assert.deepEqual(read, { enabled: true, chunkTokens: 4096 });
	});

	it("a custom budget rides through verbatim", async () => {
		const restore = stub({ settings: { version: 1, graph: { enabled: true, extractionChunkTokens: 2000 } } });
		const read = await fetchGraphRead();
		restore();
		assert.equal(read?.chunkTokens, 2000);
	});

	it("fetch failure → null → no ring", async () => {
		const restore = stub({}, false);
		const read = await fetchGraphRead();
		restore();
		assert.equal(read, null);
	});
});

describe("ringFill (the donut's fold, pure)", () => {
	it("fills uncovered/chunk, clamped to [0,1]", () => {
		assert.equal(ringFill(0, 4096), 0);
		assert.equal(ringFill(2048, 4096), 0.5);
		assert.equal(ringFill(4096, 4096), 1);
		assert.equal(ringFill(999_999, 4096), 1, "past the threshold reads full, never >1");
	});

	it("a non-positive threshold reads zero (never NaN, never a fake full)", () => {
		assert.equal(ringFill(2048, 0), 0);
		assert.equal(ringFill(2048, -5), 0);
	});
});

describe("CoverageMenuBody — the context-menu block", () => {
	it("renders the uncovered numbers + the Extract affordance", () => {
		const html = renderToStaticMarkup(
			<CoverageMenuBody coverage={coverage()} extracting={false} onExtract={() => {}} />,
		);
		assert.ok(html.includes('data-testid="ctx-coverage"'), "the block carries its testid");
		assert.match(html, /2k tok uncovered/, "the unit is typed out — tok (owner refinement round)");
		assert.match(html, /5 messages unextracted/);
		assert.ok(html.includes('data-testid="ctx-extract"'), "the Extract affordance");
		assert.ok(!html.includes('disabled=""'), "an uncovered session can extract (the disabled: utilities alone don't count)");
	});

	it("fully extracted: the quiet line, Extract disabled (never a fake run)", () => {
		const html = renderToStaticMarkup(
			<CoverageMenuBody
				coverage={coverage({ uncoveredTokens: 0, uncoveredCount: 0 })}
				extracting={false}
				onExtract={() => {}}
			/>,
		);
		assert.match(html, /fully extracted/);
		assert.ok(html.includes("disabled"), "nothing to run — the button rests");
	});

	it("running: the pulse line + 'Running', not the numbers (motion is the state)", () => {
		const html = renderToStaticMarkup(
			<CoverageMenuBody coverage={coverage({ running: true })} extracting={false} onExtract={() => {}} />,
		);
		assert.ok(html.includes('data-testid="ctx-coverage-running"'));
		assert.match(html, /extracting…/);
		assert.ok(html.includes(">Running</button>"), "the affordance reads Running while in flight");
		assert.ok(html.includes("disabled"), "no double-fire");
	});

	it("optimistic (click-pending, server not yet saying running): same running shape", () => {
		const html = renderToStaticMarkup(
			<CoverageMenuBody coverage={coverage()} extracting onExtract={() => {}} />,
		);
		assert.ok(html.includes('data-testid="ctx-coverage-running"'), "the optimistic state shows at once");
		assert.match(html, />Running</);
	});
});

describe("CoverageRingGlyph — the donut", () => {
	it("half fill: the arc covers half the circumference", () => {
		const html = renderToStaticMarkup(<CoverageRingGlyph fill={0.5} running={false} />);
		const C = 2 * Math.PI * 6;
		assert.ok(html.includes(`stroke-dasharray="${0.5 * C} ${C}"`), "fill = uncovered share of the ring");
		assert.ok(html.includes("rotate(-90"), "the arc starts at 12 o'clock");
		assert.ok(!html.includes("animate-pulse"), "steady state is still");
	});

	it("empty fill renders the bare track (no arc beyond a hairline)", () => {
		const html = renderToStaticMarkup(<CoverageRingGlyph fill={0} running={false} />);
		const C = 2 * Math.PI * 6;
		assert.ok(html.includes(`stroke-dasharray="0 ${C}"`));
	});

	it("running: the whole ring pulses (motion = the working-state signal)", () => {
		const html = renderToStaticMarkup(<CoverageRingGlyph fill={0.3} running />);
		assert.ok(html.includes("animate-pulse"), "the implementer's visual call: pulse, not a spinner");
	});
});

describe("CoverageRingDetail — the popover's exact numbers", () => {
	it("carries covered/uncovered tokens, messages, the threshold, the last fold", () => {
		const html = renderToStaticMarkup(
			<CoverageRingDetail
				coverage={coverage({ lastFoldedAt: "2026-09-24T10:00:00Z" })}
				chunkTokens={4096}
			/>,
		);
		assert.match(html, /Uncovered.*2k tokens/s);
		assert.match(html, /Covered.*30k tokens/s);
		assert.match(html, /7 \/ 12/);
		assert.match(html, /Chunk threshold.*4\.1k tokens/s);
		assert.match(html, /Last extraction/);
		assert.ok(!html.includes('data-testid="coverage-ring-running"'), "idle: no status line");
	});

	it("no fold yet renders '—' (never a fake timestamp)", () => {
		const html = renderToStaticMarkup(<CoverageRingDetail coverage={coverage()} chunkTokens={4096} />);
		assert.match(html, /Last extraction.*—/s);
	});

	it("running: the extracting… status line", () => {
		const html = renderToStaticMarkup(
			<CoverageRingDetail coverage={coverage({ running: true })} chunkTokens={4096} />,
		);
		assert.ok(html.includes('data-testid="coverage-ring-running"'));
		assert.match(html, /extracting…/);
		assert.ok(!html.includes('data-testid="coverage-ring-error"'), "running hides stale errors");
	});

	it("surfaces lastError when idle and hides it while running", () => {
		const idleHtml = renderToStaticMarkup(
			<CoverageRingDetail
				coverage={coverage({ running: false, lastError: "Extraction failed. Check the server logs for details." })}
				chunkTokens={4096}
			/>,
		);
		assert.ok(idleHtml.includes('data-testid="coverage-ring-error"'));
		assert.match(idleHtml, /Extraction failed\. Check the server logs for details\./);

		const busyHtml = renderToStaticMarkup(
			<CoverageRingDetail
				coverage={coverage({ running: true, lastError: "Extraction failed. Check the server logs for details." })}
				chunkTokens={4096}
			/>,
		);
		assert.ok(!busyHtml.includes('data-testid="coverage-ring-error"'));
	});
});

describe("CoverageMenuBody — error visibility", () => {
	it("shows server lastError when idle and keeps Extract enabled for retry", () => {
		const html = renderToStaticMarkup(
			<CoverageMenuBody
				coverage={coverage({ running: false, lastError: "Extraction was rate-limited by the provider. Try again later." })}
				extracting={false}
				onExtract={() => {}}
			/>,
		);
		assert.ok(html.includes('data-testid="ctx-coverage-error"'));
		assert.match(html, /rate-limited/);
		assert.ok(!html.includes('disabled=""'), "user can retry extraction after failure");
	});

	it("prefers action error over server lastError and hides both while busy", () => {
		const errHtml = renderToStaticMarkup(
			<CoverageMenuBody
				coverage={coverage({ lastError: "Older server error" })}
				extracting={false}
				error="No model configured — set up your models first"
				onExtract={() => {}}
			/>,
		);
		assert.match(errHtml, /No model configured/);
		assert.ok(!errHtml.includes("Older server error"));

		const busyHtml = renderToStaticMarkup(
			<CoverageMenuBody
				coverage={coverage({ running: false, lastError: "Older server error" })}
				extracting
				error="Action error"
				onExtract={() => {}}
			/>,
		);
		assert.ok(!busyHtml.includes('data-testid="ctx-coverage-error"'));
	});
});

describe("requestExtract (manual extract HTTP contract)", () => {
	const stubFetch = (fn: typeof fetch) => {
		const real = globalThis.fetch;
		globalThis.fetch = fn;
		return () => {
			globalThis.fetch = real;
		};
	};

	it("maps 202, 200 started:false, 409, 503, and transport errors accurately", async () => {
		let restore = stubFetch(async () => Response.json({ started: true }, { status: 202 }));
		try {
			assert.deepEqual(await requestExtract("c1"), { ok: true, started: true, running: true });
		} finally {
			restore();
		}

		restore = stubFetch(async () => Response.json({ started: false }, { status: 200 }));
		try {
			assert.deepEqual(await requestExtract("c1"), { ok: true, started: false, running: false });
		} finally {
			restore();
		}

		restore = stubFetch(async () => Response.json({ error: "Already running" }, { status: 409 }));
		try {
			assert.deepEqual(await requestExtract("c1"), { ok: true, started: false, running: true });
		} finally {
			restore();
		}

		restore = stubFetch(async () =>
			Response.json({ error: "No model configured — set up your models first", code: "models_not_configured" }, { status: 503 }),
		);
		try {
			assert.deepEqual(await requestExtract("c1"), {
				ok: false,
				error: "No model configured — set up your models first",
			});
		} finally {
			restore();
		}

		restore = stubFetch(async () => {
			throw new Error("network down");
		});
		try {
			const res = await requestExtract("c1");
			assert.equal(res.ok, false);
			if (!res.ok) assert.ok(res.error.length > 0);
		} finally {
			restore();
		}
	});
});

describe("CoverageMenuBlock — fast failure leaves Running state cleanly", () => {
	it("exits optimistic Running state and renders error when extraction fails before coverage poll sees running:true", async () => {
		const dom = parseHTML("<html><body><div id='root'></div></body></html>");
		let coverageReads = 0;
		const globals = {
			window: dom.window,
			document: dom.document,
			HTMLElement: dom.window.HTMLElement,
			Element: dom.window.Element,
			Node: dom.window.Node,
			SVGElement: dom.window.SVGElement,
			IS_REACT_ACT_ENVIRONMENT: true,
			fetch: async (input: unknown, init?: RequestInit) => {
				const url = String(input);
				if (url === "/api/chats/chat_fast_fail" && (!init?.method || init.method === "GET")) {
					coverageReads++;
					return Response.json({
						coverage: coverage({
							running: false,
							uncoveredTokens: 2048,
							lastError: coverageReads >= 2 ? "Extraction failed. Check the server logs for details." : null,
						}),
					});
				}
				if (url === "/api/graph/coverage/extract" && init?.method === "POST") {
					return Response.json({ started: true }, { status: 202 });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
		};
		const saved = new Map(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
		for (const [k, v] of Object.entries(globals)) {
			Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
		}
		const { createRoot } = await import("react-dom/client");
		const root = createRoot(dom.document.getElementById("root")!);
		try {
			await act(async () => {
				root.render(<CoverageMenuBlock chatId="chat_fast_fail" />);
			});
			const button = dom.document.querySelector('[data-testid="ctx-extract"]') as HTMLButtonElement;
			assert.ok(button, "Extract button rendered");
			assert.equal(button.textContent, "Extract");
			assert.equal(button.disabled, false);

			await act(async () => {
				button.click();
			});
			const btnAfter = dom.document.querySelector('[data-testid="ctx-extract"]') as HTMLButtonElement;
			assert.equal(btnAfter.textContent, "Extract", "fast failure must NOT remain stuck in Running");
			assert.equal(btnAfter.disabled, false, "Extract button is re-enabled for retry");
			const errEl = dom.document.querySelector('[data-testid="ctx-coverage-error"]');
			assert.ok(errEl, "error message surfaces after fast failure");
			assert.match(errEl.textContent ?? "", /Extraction failed/);
		} finally {
			await act(async () => {
				root.unmount();
			});
			for (const [k, desc] of saved.entries()) {
				if (desc) Object.defineProperty(globalThis, k, desc);
				else delete (globalThis as Record<string, unknown>)[k];
			}
		}
	});
});