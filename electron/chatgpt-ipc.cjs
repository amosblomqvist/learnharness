"use strict";
const { publicError } = require("./chatgpt.cjs");

/** Inherited Node child IPC, not a listening HTTP/socket token service. */
function attachChatGPTChild(child, connection) {
	const send = (value) => {
		if (child.connected) child.send({ channel: "lh:chatgpt", ...value }, () => {});
	};
	const listener = async (message) => {
		if (!message || message.channel !== "lh:chatgpt" || typeof message.id !== "string" || message.id.length > 100) return;
		try {
			let value;
			if (message.op === "status") value = { status: await connection.status(), ...connection.stamp() };
			else if (message.op === "models") value = await connection.models();
			else if (message.op === "lease" && typeof message.background === "boolean") value = await connection.lease(message.background, message);
			else throw new Error("Invalid private operation");
			send({ id: message.id, op: message.op, ok: true, value });
		} catch (err) { send({ id: message.id, op: message.op, ok: false, stamp: connection.stamp(), error: publicError(err) }); }
	};
	child.on("message", listener);
	return { send, dispose: () => child.removeListener("message", listener) };
}

/** Sender must be the trusted window's main frame at its exact app origin. */
function trustedSender(event, origin, BrowserWindow) {
	const win = BrowserWindow.fromWebContents(event.sender);
	try {
		return !!win && event.senderFrame === event.sender.mainFrame && new URL(event.senderFrame.url).origin === origin;
	} catch { return false; }
}
async function chatGPTControl(command, connection) {
	try {
		if (command?.op === "status") return await connection.status();
		if (command?.op === "login" && (command.id === undefined || typeof command.id === "string")) return await connection.login(command.id);
		if (command?.op === "cancel") return connection.cancelLogin();
		if (command?.op === "select" && typeof command.id === "string") return await connection.select(command.id);
		if (command?.op === "disconnect" && typeof command.id === "string") return await connection.disconnect(command.id);
		if (command?.op === "logout" && typeof command.id === "string") return await connection.logout(command.id);
		if (command?.op === "consent" && typeof command.enabled === "boolean") return await connection.consent(command.enabled);
		return { error: "Unsupported ChatGPT control." };
	} catch (err) { return { error: publicError(err) }; }
}
module.exports = { attachChatGPTChild, trustedSender, chatGPTControl };
