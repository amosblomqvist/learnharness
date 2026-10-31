"use client";

/**
 * Accounts (mobile-web, 2026-10-29): the admin surface for the people who can
 * sign in to this server. Admins create accounts directly (first password
 * here) or mint a one-time invite link; nobody else sees this section.
 *
 * Data isolation is per account; provider keys stay machine-global (owner
 * decision), so nothing here touches keys.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsSection } from "@/components/settings/controls";
import { useMe, invalidateMe } from "@/components/auth/use-me";

type Account = {
	id: string;
	name: string;
	email: string;
	role: "admin" | "user";
	createdAt: string;
	disabled: boolean;
};

type Invite = { code: string; email?: string; role: "admin" | "user"; expiresAt: string };

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
	try {
		const res = await fetch(url, {
			...init,
			headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
		});
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) return { ok: false, error: typeof body.error === "string" ? body.error : `HTTP ${res.status}` };
		return { ok: true, data: body as T };
	} catch {
		return { ok: false, error: "Could not reach the server." };
	}
}

export function AccountsSection() {
	const { user: me, loading: meLoading } = useMe();
	const [accounts, setAccounts] = useState<Account[]>([]);
	const [invites, setInvites] = useState<Invite[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [inviteUrl, setInviteUrl] = useState<string | null>(null);
	const [resetFor, setResetFor] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const result = await api<{ users: Account[]; invites: Invite[] }>("/api/users");
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setError(null);
		setAccounts(result.data.users);
		setInvites(result.data.invites);
	}, []);

	useEffect(() => {
		if (!meLoading && me?.role === "admin") void refresh();
	}, [meLoading, me, refresh]);

	if (!meLoading && me?.role !== "admin") {
		return (
			<SettingsSection title="Accounts">
				<p className="text-sm text-muted-foreground">Only an admin can manage accounts.</p>
			</SettingsSection>
		);
	}

	const createAccount = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (busy) return;
		const form = event.currentTarget;
		const data = new FormData(form);
		setBusy(true);
		const result = await api<{ user: Account }>("/api/users", {
			method: "POST",
			body: JSON.stringify({
				name: data.get("name"),
				email: data.get("email"),
				password: data.get("password"),
				role: data.get("role") === "admin" ? "admin" : "user",
			}),
		});
		setBusy(false);
		if (!result.ok) return setError(result.error);
		form.reset();
		void refresh();
	};

	const createInvite = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (busy) return;
		const data = new FormData(event.currentTarget);
		setBusy(true);
		const result = await api<{ url: string }>("/api/users", {
			method: "POST",
			body: JSON.stringify({
				invite: true,
				email: (data.get("inviteEmail") as string) || undefined,
				role: data.get("inviteRole") === "admin" ? "admin" : "user",
			}),
		});
		setBusy(false);
		if (!result.ok) return setError(result.error);
		setInviteUrl(result.data.url);
		void refresh();
	};

	const patch = async (id: string, body: Record<string, unknown>) => {
		setBusy(true);
		const result = await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });
		setBusy(false);
		if (!result.ok) return setError(result.error);
		setError(null);
		setResetFor(null);
		void refresh();
	};

	const remove = async (account: Account) => {
		if (!window.confirm(`Delete ${account.name}'s account? Their chats stay on disk but are no longer reachable.`)) return;
		setBusy(true);
		const result = await api(`/api/users/${account.id}`, { method: "DELETE" });
		setBusy(false);
		if (!result.ok) return setError(result.error);
		invalidateMe();
		void refresh();
	};

	return (
		<SettingsSection title="Accounts" hint="Each account has its own sessions, graph and settings. Provider keys are shared." testid="accounts-section">
			{error && (
				<p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{error}
				</p>
			)}

			<SettingsGroup label="People">
				<ul className="flex flex-col gap-1">
					{accounts.map((account) => (
						<li key={account.id} className="flex flex-col gap-2 border-b border-border/50 py-2 last:border-b-0">
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm text-foreground">
										{account.name}
										{account.id === me?.id && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
									</span>
									<span className="block truncate text-xs text-muted-foreground">{account.email}</span>
								</span>
								<span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
									{account.role}
								</span>
								{account.disabled && (
									<span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
										disabled
									</span>
								)}
							</div>
							<div className="flex flex-wrap items-center gap-1.5">
								<Button type="button" size="xs" variant="outline" disabled={busy || account.id === me?.id} onClick={() => void patch(account.id, { disabled: !account.disabled })}>
									{account.disabled ? "Enable" : "Disable"}
								</Button>
								<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => setResetFor(resetFor === account.id ? null : account.id)}>
									Reset password
								</Button>
								<Button type="button" size="xs" variant="outline" disabled={busy || account.id === me?.id} onClick={() => void remove(account)}>
									Delete
								</Button>
							</div>
							{resetFor === account.id && (
								<form
									className="flex items-center gap-1.5"
									onSubmit={(event) => {
										event.preventDefault();
										const value = new FormData(event.currentTarget).get("password");
										if (typeof value === "string" && value) void patch(account.id, { password: value });
									}}
								>
									<Input name="password" type="password" minLength={10} placeholder="New password (10+ chars)" className="h-9" />
									<Button type="submit" size="xs" disabled={busy}>
										Save
									</Button>
								</form>
							)}
						</li>
					))}
				</ul>
			</SettingsGroup>

			<SettingsGroup label="Invite someone">
				<form onSubmit={createInvite} className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
					<Input name="inviteEmail" type="email" placeholder="Email (optional)" className="h-9 sm:flex-1" />
					<select name="inviteRole" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm">
						<option value="user">user</option>
						<option value="admin">admin</option>
					</select>
					<Button type="submit" size="sm" disabled={busy}>
						Create invite link
					</Button>
				</form>
				{inviteUrl && (
					<div className="flex items-center gap-1.5">
						<Input readOnly value={inviteUrl} className="h-9 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
						<Button type="button" size="xs" variant="outline" onClick={() => void navigator.clipboard?.writeText(inviteUrl)}>
							Copy
						</Button>
					</div>
				)}
				{invites.length > 0 && (
					<ul className="flex flex-col gap-1 text-xs text-muted-foreground">
						{invites.map((invite) => (
							<li key={invite.code} className="flex items-center gap-2">
								<span className="truncate font-mono">{invite.code}</span>
								<span>{invite.email ?? "any email"}</span>
								<span className="ml-auto shrink-0">expires {new Date(invite.expiresAt).toLocaleDateString()}</span>
							</li>
						))}
					</ul>
				)}
			</SettingsGroup>

			<SettingsGroup label="Create an account directly">
				<form onSubmit={createAccount} className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
					<Input name="name" placeholder="Name" required className="h-9" />
					<Input name="email" type="email" placeholder="Email" required className="h-9" />
					<Input name="password" type="password" minLength={10} placeholder="Password (10+ chars)" required className="h-9" />
					<select name="role" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm">
						<option value="user">user</option>
						<option value="admin">admin</option>
					</select>
					<Button type="submit" size="sm" className="sm:col-span-2" disabled={busy}>
						Create account
					</Button>
				</form>
			</SettingsGroup>
		</SettingsSection>
	);
}
