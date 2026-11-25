"use strict";

// Bonjour/mDNS advertisement for Phone access: `_learnharness._tcp`, so the
// iPhone app can list computers on the same network. The TXT record carries
// only public values (protocol version, app version, a fingerprint prefix that
// lets a paired phone find its computer again after the address changes).

const SERVICE_TYPE = "learnharness";

/** Returns an `advertise` function for createPhoneAccess. Advertising is a
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

module.exports = { bonjourAdvertiser, SERVICE_TYPE };
