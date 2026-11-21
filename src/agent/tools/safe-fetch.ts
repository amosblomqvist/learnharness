import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/**
 * Fetch for model-chosen URLs (research web_fetch / web_fetch_pdf): only
 * public internet addresses. A fetched page can steer the researcher, so
 * without this it could read loopback services, the LAN, or cloud metadata
 * (169.254.169.254) and hand the response back to the model.
 *
 * Every address DNS returns is judged before a connection is attempted, so a
 * single non-public candidate blocks the request even when another is public.
 * IP-literal hosts are judged before the resolver is consulted, and the peer
 * the socket actually reports is rechecked as defence in depth. Redirects and
 * DNS rebinding therefore pass the same checks, with no request bytes sent to
 * a refused address.
 */

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // carrier-grade NAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, cloud metadata
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.88.99.0", 24], // 6to4 relay anycast
	["192.168.0.0", 16], // private
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, broadcast
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 128], // unspecified
	["::1", 128], // loopback
	["64:ff9b::", 96], // NAT64
	["64:ff9b:1::", 48], // local-use NAT64
	["100::", 64], // discard-only
	["2001:db8::", 32], // documentation
	["2002::", 16], // 6to4
	["fc00::", 7], // unique local
	["fe80::", 10], // link-local
	["fec0::", 10], // deprecated site-local
	["ff00::", 8], // multicast
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv6");

/** True when an IP address is on the public internet. IPv4-mapped IPv6
 *  (::ffff:a.b.c.d) is judged as the IPv4 address it carries. */
export function isPublicAddress(address: string): boolean {
	const unbracketed = address.replace(/^\[|\]$/g, "");
	const mapped = unbracketed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
	const ip = mapped ?? unbracketed;
	const family = isIP(ip);
	if (family === 4) return !NON_PUBLIC.check(ip, "ipv4");
	if (family === 6) return !NON_PUBLIC.check(ip, "ipv6");
	return false;
}

export class BlockedAddressError extends Error {}

/** An undici Agent whose connections may only reach addresses `allowed`
 *  accepts (exported with the check injectable, for tests). */
export function createAddressCheckedAgent(
	allowed: (address: string) => boolean = isPublicAddress,
	connectorOptions: Parameters<typeof buildConnector>[0] = {},
): Agent {
	// Connector settings let offline tests supply deterministic DNS and a TLS CA.
	const refused = (hostname: string) => new BlockedAddressError(`refusing to connect to a private or local address (${hostname})`);
	const resolve: LookupFunction = connectorOptions && "lookup" in connectorOptions ? connectorOptions.lookup ?? dnsLookup : dnsLookup;
	// undici calls setNoDelay/setKeepAlive on the pending socket before it
	// resolves; on Windows that leaves remoteAddress empty even for a connected
	// socket. Judge the address where it is chosen instead: every address the
	// resolver returns is checked before the connection is attempted.
	const lookup: LookupFunction = (hostname, options, callback) => {
		resolve(hostname, options, (error, address, family) => {
			if (error) return callback(error, address ?? "", family);
			const blocked = Array.isArray(address) ? address.some(entry => !allowed(entry.address)) : !allowed(address);
			return blocked ? callback(refused(hostname), "", undefined) : callback(null, address, family);
		});
	};
	const connect = buildConnector({ ...connectorOptions, lookup });
	return new Agent({
		connect: (options, callback) => {
			if (connectorOptions && (("socketPath" in connectorOptions && connectorOptions.socketPath) || ("path" in connectorOptions && connectorOptions.path))) {
				callback(refused(options.hostname), null);
				return;
			}
			// A literal IP never reaches the resolver, so judge it here.
			const literal = options.hostname.replace(/^\[|\]$/g, "");
			if (isIP(literal) && !allowed(literal)) {
				callback(refused(options.hostname), null);
				return;
			}
			connect(options, (error, socket) => {
				if (error || !socket) {
					callback(error ?? new Error("connection failed"), null);
					return;
				}
				// Defence in depth where the platform still reports the peer.
				const peer = socket.remoteAddress ?? "";
				if (peer && !allowed(peer)) {
					socket.destroy();
					callback(refused(options.hostname), null);
					return;
				}
				callback(null, socket);
			});
		},
	});
}

const publicOnly = createAddressCheckedAgent();

/** Test seam — undefined in production. Tests that drive the research tools
 *  offline set a canned responder here (stubbing globalThis.fetch no longer
 *  reaches these tools, which use undici's own fetch). */
export const safeFetchOverride: { current?: (url: string, init: RequestInit) => Promise<Response> } = {};

/** fetch() limited to public addresses. A refusal surfaces as its own
 *  message instead of undici's generic "fetch failed". */
export async function safeFetch(url: string, init: RequestInit = {}, dispatcher: Agent = publicOnly): Promise<Response> {
	if (safeFetchOverride.current) return safeFetchOverride.current(url, init);
	try {
		return (await undiciFetch(url, { ...(init as object), dispatcher })) as unknown as Response;
	} catch (err) {
		let link: unknown = err;
		for (let depth = 0; link && depth < 4; depth++) {
			if (link instanceof BlockedAddressError) throw new Error(link.message);
			link = typeof link === "object" && "cause" in link ? link.cause : undefined;
		}
		throw err;
	}
}
