/** TS → JS for the browser runner. Compilation only: the compiler never
 *  executes the submitted code, and the result runs in the learner's Worker.
 *  Uses the TypeScript compiler API rather than esbuild — esbuild ships a
 *  native binary, which the server bundler cannot include. */
import ts from "typescript";

export const dynamic = "force-dynamic";

const MAX = 200 * 1024;

export async function POST(req: Request) {
	let body: { code?: unknown };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "invalid JSON" }, { status: 400 });
	}
	const code = typeof body.code === "string" ? body.code : "";
	if (!code.trim()) return Response.json({ error: "code required" }, { status: 400 });
	if (Buffer.byteLength(code) > MAX) return Response.json({ error: "code too large" }, { status: 413 });

	const out = ts.transpileModule(code, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true },
		reportDiagnostics: true,
	});
	const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
	if (errors.length) {
		return Response.json(
			{ error: ts.flattenDiagnosticMessageText(errors[0]!.messageText, " ") },
			{ status: 422 },
		);
	}
	return Response.json({ code: out.outputText, warnings: 0 });
}
