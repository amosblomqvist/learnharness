/**
 * The phone build's app root: the same providers and page components as
 * app/layout.tsx + app/**\/page.tsx, with each page's server-side reads
 * (settings record, chat record) replaced by fetches to the on-device
 * `/api/*` backend. Every navigation re-reads, like the desktop's dynamic
 * pages.
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { resolveSettings, slotsConfigured, type LhMessage, type UserSettings } from "@/src/core";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { Home } from "@/components/home";
import { NewSession } from "@/components/new-session";
import { Chat } from "@/components/chat";
import { LocationProvider, navigate, useLocation } from "./navigation.tsx";

type ChatRecordView = {
	id: string;
	title: string;
	kind?: "teach" | "practice";
	messages: LhMessage[];
	turnInFlight?: boolean;
	turnError?: string;
	compacting?: boolean;
};

type Page =
	| { kind: "loading" }
	| { kind: "home"; configured: boolean; rendering: boolean }
	| { kind: "new"; configured: boolean; mode: "teach" | "practice" }
	| { kind: "chat"; configured: boolean; chat: ChatRecordView; prompt?: string }
	| { kind: "missing" };

async function readSettings(): Promise<UserSettings | null> {
	const res = await fetch("/api/settings");
	return ((await res.json()) as { settings: UserSettings | null }).settings;
}

async function load(pathname: string, search: string): Promise<Page> {
	const params = new URLSearchParams(search);
	const record = await readSettings();
	const configured = slotsConfigured(record?.models);
	if (pathname === "/" || pathname === "") {
		return { kind: "home", configured, rendering: resolveSettings(record ?? null).graph.rendering };
	}
	if (pathname === "/chat/new") return { kind: "new", configured, mode: params.get("mode") === "practice" ? "practice" : "teach" };
	const chat = /^\/chat\/([^/]+)$/.exec(pathname);
	if (chat) {
		const res = await fetch(`/api/chats/${chat[1]}`);
		if (!res.ok) return { kind: "missing" };
		return { kind: "chat", configured, chat: (await res.json()) as ChatRecordView, prompt: params.get("prompt") ?? undefined };
	}
	if (pathname === "/settings") {
		navigate("/chat/new", "replace");
		return { kind: "loading" };
	}
	return { kind: "missing" };
}

function Pages() {
	const { pathname, search } = useLocation();
	const [page, setPage] = useState<Page>({ kind: "loading" });
	useEffect(() => {
		let live = true;
		load(pathname, search).then(
			(next) => live && setPage(next),
			(err) => {
				console.error("[app] page load failed:", err);
				if (live) setPage({ kind: "missing" });
			},
		);
		return () => {
			live = false;
		};
	}, [pathname, search]);

	switch (page.kind) {
		case "loading":
			return null;
		case "home":
			return <Home initialConfigured={page.configured} rendering={page.rendering} />;
		case "new":
			return <NewSession key={page.mode} initialConfigured={page.configured} mode={page.mode} />;
		case "chat":
			return (
				<Chat
					key={page.chat.id}
					chatId={page.chat.id}
					title={page.chat.title}
					kind={page.chat.kind ?? "teach"}
					initialMessages={page.chat.messages}
					initialError={page.chat.turnError}
					initialConfigured={page.configured}
					initialPrompt={page.prompt}
					initiallyInFlight={page.chat.turnInFlight === true}
					initiallyCompacting={page.chat.compacting === true}
				/>
			);
		case "missing":
			return <Missing />;
	}
}

function Missing() {
	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
			<p>This page doesn’t exist on this device.</p>
			<button className="underline" onClick={() => navigate("/")}>
				Go home
			</button>
		</div>
	);
}

export function App({ children }: { children?: ReactNode }) {
	return (
		<LocationProvider>
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>
								<Pages />
								{children}
							</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
		</LocationProvider>
	);
}
