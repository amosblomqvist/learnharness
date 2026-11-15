/** Child-process fixture (#403): `create` makes one chat and prints its id;
 *  `crash <id>` dies right before that chat's save would land; `read <id>`
 *  reports what fresh boots see. Runs on the caller's LH_DATA_DIR. */
import fs from "node:fs";
const [mode, id = ""] = process.argv.slice(2);
const { chatStore } = await import("../../src/store/chats.ts");
const { PATHS } = await import("../../config.ts");
if (mode === "create") {
	const chat = chatStore.createChat("Crash fixture");
	chatStore.saveMessages(chat.id, [{ role: "user", content: "first", timestamp: 1 }] as never);
	console.log(chat.id);
} else if (mode === "crash") {
	const rename = fs.renameSync;
	fs.renameSync = (...args: Parameters<typeof rename>) => {
		if (String(args[1]).endsWith(`${id}.json`)) process.exit(77);
		return rename(...args);
	};
	chatStore.saveMessages(id, [{ role: "user", content: "second", timestamp: 2 }] as never);
} else {
	console.log(JSON.stringify({
		chat: chatStore.getChat(id),
		listed: chatStore.listChats().map((c) => c.id),
		files: fs.readdirSync(PATHS.chats),
	}));
}
