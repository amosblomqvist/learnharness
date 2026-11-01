/** Personal sideload signing. Keep the private key to install future updates. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const input = path.resolve(process.argv[2] ?? "android/app/build/outputs/apk/release/app-arm64-v8a-release-unsigned.apk");
const cache = process.env.LH_ANDROID_CACHE ?? path.join(os.homedir(), ".cache/learnharness-android");
const sdk = process.env.ANDROID_HOME ?? path.join(cache, "sdk");
const signing = path.join(cache, "signing");
const keystore = path.join(signing, "learnharness.p12");
const password = path.join(signing, "password");
const tools = path.join(sdk, "build-tools/35.0.0");
const output = path.resolve("dist/learnharness-0.4.1-android.1-arm64.apk");
await fs.access(input);
await fs.mkdir(signing, { recursive: true, mode: 0o700 });
let exists = true;
try { await fs.access(keystore); } catch { exists = false; }
if (!exists) {
	try { await fs.writeFile(password, crypto.randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" }); }
	catch (error) { if (error.code !== "EEXIST") throw error; }
	execFileSync("keytool", ["-genkeypair", "-keystore", keystore, "-storetype", "PKCS12", "-storepass:file", password, "-keypass:file", password, "-alias", "learnharness", "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000", "-dname", "CN=LearnHarness Personal Android", "-noprompt"], { stdio: "inherit" });
	await fs.chmod(keystore, 0o600);
}
await fs.mkdir(path.dirname(output), { recursive: true });
execFileSync(path.join(tools, "zipalign"), ["-f", "-P", "16", "4", input, output + ".aligned"]);
execFileSync(path.join(tools, "apksigner"), ["sign", "--ks", keystore, "--ks-key-alias", "learnharness", "--ks-pass", `file:${password}`, "--out", output, output + ".aligned"], { stdio: "inherit" });
execFileSync(path.join(tools, "apksigner"), ["verify", "--verbose", "--print-certs", output], { stdio: "inherit" });
await fs.rm(output + ".aligned");
const digest = crypto.createHash("sha256").update(await fs.readFile(output)).digest("hex");
await fs.writeFile(output + ".sha256", `${digest}  ${path.basename(output)}\n`);
console.log(`Signed APK: ${output}\nSHA-256: ${digest}\nKeep the private signing directory outside Git: ${signing}`);
