"use strict";
const { publicError } = require("./legacy-subscriptions.cjs");

const CHANNEL = "lh:subscription";
const lookup = (map, provider) => {
	if (typeof provider !== "string") return undefined;
	const c = map instanceof Map ? map.get(provider) : Object.hasOwn(map ?? {}, provider) ? map[provider] : undefined;
	return c && typeof c.status === "function" ? c : undefined;
};
const bad = (id, op, provider, connection) => ({ channel: CHANNEL, id, op, provider, ok: false, ...(connection ? { stamp: connection.stamp() } : {}), error: publicError(Object.assign(new Error("request"), { code: "request" }), connection?.label) });
/** Whitelist copies: nothing but known public fields ever leaves main. */
const cleanStatus = (s) => ({
	available: !!s?.available, pending: !!s?.pending, allowBackgroundUse: !!s?.allowBackgroundUse,
	activeId: typeof s?.activeId === "string" ? s.activeId : null,
	accounts: (Array.isArray(s?.accounts) ? s.accounts : []).map((a) => ({ id: String(a.id), label: String(a.label), connected: !!a.connected })),
	error: typeof s?.error === "string" ? s.error : null,
	...(s?.catalogError !== undefined ? { catalogError: typeof s.catalogError === "string" ? s.catalogError : null } : {}),
});
const cleanStamp = (s) => ({ epoch: s.epoch, authorityRevision: s.authorityRevision, revision: s.revision });

/** Inherited Node child IPC. Provider is required on every request; lease is child-only. */
function attachSubscriptionChild(child, connectionsMap) {
	const send = (value) => { if (child.connected) child.send({ channel: CHANNEL, ...value }, () => {}); };
	const listener = async (message) => {
		if (!message || message.channel !== CHANNEL || typeof message.id !== "string" || message.id.length > 100) return;
		const { id, op, provider } = message;
		const connection = lookup(connectionsMap, provider);
		if (!connection) return send(bad(id, op, undefined, undefined));
		try {
			let value;
			if (op === "status") value = { status: cleanStatus(await connection.status()), ...cleanStamp(connection.stamp()) };
			else if (op === "models") {
				const m = await connection.models();
				value = { ...cleanStamp(m), status: cleanStatus(m.status), accountId: typeof m.accountId === "string" ? m.accountId : null, models: m.models.map((x) => ({ id: x.id, name: x.name })) };
			} else if (op === "lease" && typeof message.background === "boolean") {
				const l = await connection.lease(message.background, message);
				value = { accessToken: l.accessToken, accountId: l.accountId, ...cleanStamp(l) };
			} else return send(bad(id, op, provider, connection));
			send({ channel: CHANNEL, id, op, provider, ok: true, value });
		} catch (e) { send({ channel: CHANNEL, id, op, provider, ok: false, stamp: cleanStamp(connection.stamp()), error: publicError(e, connection.label) }); }
	};
	child.on("message", listener);
	return { send, dispose: () => child.removeListener("message", listener) };
}

/** Renderer control. Parent must already have verified the trusted sender. No lease/import/url/code/token ops. */
async function subscriptionControl(command, connectionsMap) {
	const connection = lookup(connectionsMap, command?.provider);
	if (!connection) return { error: "Unsupported subscription control." };
	try {
		const op = command.op;
		if (op === "status") return cleanStatus(await connection.status());
		if (op === "login" && (command.id === undefined || typeof command.id === "string") && (command.allowBackgroundUse === undefined || typeof command.allowBackgroundUse === "boolean")) return cleanStatus(await connection.login(command.id, command.allowBackgroundUse));
		if (op === "cancel") return cleanStatus(connection.cancelLogin());
		if (op === "select" && typeof command.id === "string") return cleanStatus(await connection.select(command.id));
		if (op === "disconnect" && typeof command.id === "string") return cleanStatus(await connection.disconnect(command.id));
		if (op === "logout" && typeof command.id === "string") return cleanStatus(await connection.logout(command.id));
		if (op === "consent" && typeof command.enabled === "boolean") return cleanStatus(await connection.consent(command.enabled));
		return { error: "Unsupported subscription control." };
	} catch (e) { return { error: publicError(e, connection.label) }; }
}
module.exports = { attachSubscriptionChild, subscriptionControl, cleanStatus };
