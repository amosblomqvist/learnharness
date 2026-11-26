"use strict";

// Bonjour/mDNS advertisement for Phone access: `_learnharness._tcp`, so the
// iPhone app can list computers on the same network. The TXT record carries
// only public values (protocol version, app version, a fingerprint prefix that
// lets a paired phone find its computer again after the address changes).
// macOS uses the system mDNSResponder (dns-sd); other platforms bonjour-service.

const SERVICE_TYPE = "learnharness";
const DNS_SD = "/usr/bin/dns-sd";

/** Windows and Linux: returns an `advertise` function for createPhoneAccess. Advertising is a
 * convenience: its failures (no multicast route, VPN interfaces, sleep/wake)
 * are reported to `onError` and never thrown — bonjour-service's default
 * error handler throws, which would take down the Electron main process. */
function bonjourAdvertiser({ load = () => require("bonjour-service"), onError = () => {} } = {}) {
	let instance = null;
	const report = (error) => { try { onError(error); } catch { /* never rethrow */ } };
	return function advertise({ name, port, txt }) {
		const { Bonjour } = load();
		instance ??= new Bonjour({}, report);
		const service = instance.publish({ name, type: SERVICE_TYPE, protocol: "tcp", port, txt });
		service.on?.("error", report);
		return {
			stop() {
				try { service.stop?.(); } catch (error) { report(error); }
				try { instance?.destroy(); } catch (error) { report(error); }
				instance = null;
			},
		};
	};
}

/** macOS: register through the system's mDNSResponder with `dns-sd -R`, the
 * daemon AirDrop and AirPlay use. bonjour-service opens its own multicast
 * socket, which macOS refuses (EHOSTUNREACH) — the service never appears.
 * The child lives while the service is advertised; stop() (or the app
 * exiting) ends it, which withdraws the service. */
function dnsSdAdvertiser({ spawn = require("node:child_process").spawn, onError = () => {}, processRef = process } = {}) {
	const report = (error) => { try { onError(error); } catch { /* never rethrow */ } };
	return function advertise({ name, port, txt }) {
		const args = ["-R", name, `_${SERVICE_TYPE}._tcp`, "local", String(port), ...Object.entries(txt ?? {}).map(([key, value]) => `${key}=${value}`)];
		let stopped = false;
		const child = spawn(DNS_SD, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on?.("data", (chunk) => { stderr = (stderr + chunk).slice(-500); });
		child.on("error", (error) => report(error));
		child.on("exit", (code, signal) => {
			if (!stopped) report(new Error(`dns-sd exited (${signal ?? code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
		});
		const kill = () => { try { child.kill(); } catch (error) { report(error); } };
		processRef.once?.("exit", kill);
		return {
			stop() {
				if (stopped) return;
				stopped = true;
				processRef.removeListener?.("exit", kill);
				kill();
			},
		};
	};
}

/** The advertiser for this platform: native mDNSResponder on macOS,
 * bonjour-service elsewhere. */
function phoneAccessAdvertiser({ platform = process.platform, ...options } = {}) {
	return platform === "darwin" ? dnsSdAdvertiser(options) : bonjourAdvertiser(options);
}

module.exports = { bonjourAdvertiser, dnsSdAdvertiser, phoneAccessAdvertiser };
