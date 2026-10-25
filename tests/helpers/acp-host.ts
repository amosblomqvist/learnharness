import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { AcpAgentId, AcpConnectionConfig } from "../../src/core/acp.ts";

export function configureAcpHost(test: TestContext, initial: Partial<Record<AcpAgentId, AcpConnectionConfig>> = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "lh-acp-host-test-"));
	const file = path.join(dir, "host.json");
	const previous = Object.fromEntries(["LH_ACP_HOST_CONFIG", "LH_LOCAL_APP", "HOSTNAME"].map((key) => [key, process.env[key]]));
	process.env.LH_ACP_HOST_CONFIG = file;
	process.env.LH_LOCAL_APP = "1";
	process.env.HOSTNAME = "127.0.0.1";
	const config = { ...initial };
	const write = () => writeFileSync(file, JSON.stringify(config));
	write();
	test.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		if (path.dirname(dir) === path.resolve(tmpdir()) && path.basename(dir).startsWith("lh-acp-host-test-")) rmSync(dir, { recursive: true, force: true });
	});
	return (id: AcpAgentId, next: AcpConnectionConfig) => { config[id] = next; write(); };
}
