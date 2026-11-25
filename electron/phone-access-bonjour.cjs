"use strict";

// Bonjour/mDNS advertisement for Phone access: `_learnharness._tcp`, so the
// iPhone app can list computers on the same network. The TXT record carries
// only public values (protocol version, app version, a fingerprint prefix that
// lets a paired phone find its computer again after the address changes).

const SERVICE_TYPE = "learnharness";

/** Returns an `advertise` function for createPhoneAccess. */
function bonjourAdvertiser(load = () => require("bonjour-service")) {
	let instance = null;
	return function advertise({ name, port, txt }) {
		const { Bonjour } = load();
		instance ??= new Bonjour();
		const service = instance.publish({ name, type: SERVICE_TYPE, protocol: "tcp", port, txt, disableIPv6: false });
		service.on?.("error", () => { /* name conflicts and network changes are retried by mDNS */ });
		return {
			stop() {
				try { service.stop?.(); } catch { /* best effort */ }
				try { instance?.destroy(); } catch { /* best effort */ }
				instance = null;
			},
		};
	};
}

module.exports = { bonjourAdvertiser, SERVICE_TYPE };
