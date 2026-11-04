"use strict";
const { PROVIDERS } = require("./subscription-store.cjs");
const { publicError } = require("./subscriptions.cjs");
function attachSubscriptionChild(child, controller) {
	let disposed = false;
	const send = (packet) => { if (!disposed && child.connected) { try { child.send(packet, () => {}); } catch { /* child exited */ } } };
	const listener = async (message) => {
		if (disposed || !child.connected || message?.channel !== "lh:subscriptions" || typeof message.id !== "string") return;
		const { id, op } = message;
		try {
			if (!controller || !["snapshot", "lease"].includes(op)) throw new Error();
			if (op === "lease" && (typeof message.background !== "boolean" || !validScope(message.scope))) throw new Error();
			const value = op === "snapshot" ? await controller.snapshot() : await controller.lease(message.scope, message.background);
			send({ channel: "lh:subscriptions", id, op, ok: true, value });
		} catch (error) { send({ channel: "lh:subscriptions", id, op, ok: false, error: publicError(error) }); }
	};
	child.on("message", listener);
	return {
		send(snapshot) { send({ channel: "lh:subscriptions", op: "changed", snapshot }); },
		dispose() { disposed = true; child.removeListener("message", listener); },
	};
}
function validScope(scope) {
	return scope && PROVIDERS.includes(scope.providerId) && typeof scope.connectionId === "string" && !!scope.connectionId && typeof scope.selectedModelId === "string" && !!scope.selectedModelId && [scope.epoch, scope.authorityRevision].every((n) => Number.isSafeInteger(n) && n >= 0);
}
/** Caller authenticates the exact trusted main-frame origin before dispatch. */
async function subscriptionControl(command, controller) {
	try {
		if (!controller || !command || typeof command !== "object") throw new Error();
		if (command.op === "status") return await controller.status();
		if (!PROVIDERS.includes(command.providerId)) throw new Error();
		const id = command.providerId;
		switch (command.op) {
			case "login": return await controller.login(id, command.enabled);
			case "cancel": return controller.cancel(id);
			case "respond": return await controller.respond(id, command.attemptId, command.promptId, command.value);
			case "open": return await controller.open(id, command.attemptId, command.actionId);
			case "retry": return await controller.retry(id);
			case "disconnect": return await controller.disconnect(id);
			case "consent": return await controller.consent(id, command.enabled);
			default: throw new Error();
		}
	} catch (error) { throw new Error(publicError(error)); }
}
module.exports = { attachSubscriptionChild, subscriptionControl, validScope };
