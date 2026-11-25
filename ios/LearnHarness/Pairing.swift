import CryptoKit
import Foundation
import Security
import WebKit

// Phone access (docs/phone-access.md): this phone pairs with the desktop
// app's HTTPS gateway instead of a self-hosted server. The gateway uses a
// self-signed certificate; the phone pins its SHA-256 fingerprint and holds a
// device token (Keychain) that the gateway accepts as the `lh_device` cookie,
// so the app's requests and the web views share it like a sign-in cookie.

/// A computer this phone is paired with. Secrets live in the Keychain.
struct Pairing: Codable, Equatable {
	/// The computer's name, for display.
	var name: String
	/// SHA-256 of the gateway certificate, lowercase hex (64 characters).
	var fingerprint: String
	/// Addresses to try, the last one that worked first.
	var hosts: [String]
	var port: Int
	var deviceId: String

	var url: URL {
		var parts = URLComponents()
		parts.scheme = "https"
		parts.host = hosts.first ?? "localhost"
		parts.port = port
		return parts.url!
	}

}

/// learnharness://pair?v=1&h=<hosts>&p=<port>&f=<fingerprint>&c=<code>&n=<name>,
/// from the QR code on the computer (or the system Camera opening the app).
struct PairingLink: Equatable {
	let name: String
	let hosts: [String]
	let port: Int
	let fingerprint: String
	let code: String

	init?(url: URL) {
		guard url.scheme?.lowercased() == "learnharness", url.host()?.lowercased() == "pair",
		      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
		func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
		guard value("v") == "1",
		      let fingerprint = value("f")?.lowercased(), fingerprint.count == 64, fingerprint.allSatisfy(\.isHexDigit),
		      let port = value("p").flatMap(Int.init), (1...65535).contains(port),
		      let code = value("c"), (16...128).contains(code.count), code.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return nil }
		let hosts = (value("h") ?? "").split(separator: ",").map(String.init).filter(Self.isHost)
		guard !hosts.isEmpty else { return nil }
		self.hosts = hosts
		self.port = port
		self.fingerprint = fingerprint
		self.code = code
		let name = (value("n") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		self.name = name.isEmpty ? "your computer" : String(name.prefix(64))
	}

	init?(string: String) {
		guard let url = URL(string: string) else { return nil }
		self.init(url: url)
	}

	/// IPv4 addresses and host names only; nothing that could smuggle a path or credentials.
	static func isHost(_ host: String) -> Bool {
		!host.isEmpty && host.count <= 253 && host.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }
	}
}

// MARK: - Keychain

/// The device token, readable only on this phone after first unlock.
enum DeviceTokenStore {
	private static let service = "LearnHarness.phone-access"

	struct SaveError: LocalizedError {
		let status: OSStatus
		var errorDescription: String? { "Couldn't keep the pairing on this iPhone (Keychain error \(status))." }
	}

	static func save(_ token: String, for deviceId: String) throws {
		delete(deviceId)
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: deviceId,
			kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
			kSecValueData as String: Data(token.utf8),
		]
		let status = SecItemAdd(query as CFDictionary, nil)
		guard status == errSecSuccess else { throw SaveError(status: status) }
	}

	static func load(_ deviceId: String) -> String? {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: deviceId,
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		var result: AnyObject?
		guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
		return String(data: data, encoding: .utf8)
	}

	static func delete(_ deviceId: String) {
		let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: deviceId]
		SecItemDelete(query as CFDictionary)
	}
}

// MARK: - Certificate pinning

/// Which certificate each paired host:port must present. Hosts without a pin
/// (self-hosted servers) get the system's normal TLS evaluation.
final class PinnedTrust: @unchecked Sendable {
	static let shared = PinnedTrust()
	private let lock = NSLock()
	private var pins: [String: String] = [:]

	func pin(hosts: [String], port: Int, fingerprint: String) {
		lock.withLock { for host in hosts { pins["\(host.lowercased()):\(port)"] = fingerprint.lowercased() } }
	}

	func clear() { lock.withLock { pins.removeAll() } }

	func pinned(host: String, port: Int) -> String? {
		lock.withLock { pins["\(host.lowercased()):\(port)"] }
	}

	/// The decision for a TLS challenge: pinned hosts must present exactly the
	/// pinned certificate; anything else is cancelled, never "trusted anyway".
	func evaluate(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
		let space = challenge.protectionSpace
		guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
			return (.performDefaultHandling, nil)
		}
		guard let pin = pinned(host: space.host, port: space.port) else { return (.performDefaultHandling, nil) }
		guard Self.leafFingerprint(trust) == pin else { return (.cancelAuthenticationChallenge, nil) }
		return (.useCredential, URLCredential(trust: trust))
	}

	static func leafFingerprint(_ trust: SecTrust) -> String? {
		guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
		let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
		return digest.map { String(format: "%02x", $0) }.joined()
	}
}

/// URLSession delegate applying the pins (ServerAPI's sessions use it).
final class PinningDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
	static let shared = PinningDelegate()

	func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
		PinnedTrust.shared.evaluate(challenge)
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
		PinnedTrust.shared.evaluate(challenge)
	}
}

// MARK: - Device cookie

enum DeviceCookie {
	static let name = "lh_device"

	static func cookies(token: String, hosts: [String]) -> [HTTPCookie] {
		hosts.compactMap { host in
			HTTPCookie(properties: [
				.name: name, .value: token, .domain: host, .path: "/",
				.secure: "TRUE", .expires: Date().addingTimeInterval(10 * 365 * 24 * 3600),
				HTTPCookiePropertyKey("HttpOnly"): "TRUE", .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict,
			])
		}
	}

	/// Puts the token where the app's requests and the web views both send it.
	@MainActor
	static func install(token: String, hosts: [String]) async {
		let cookies = cookies(token: token, hosts: hosts)
		cookies.forEach { HTTPCookieStorage.shared.setCookie($0) }
		await CookieBridge.copyToWeb(cookies)
	}

	@MainActor
	static func remove(hosts: [String]) async {
		for host in hosts { if let url = URL(string: "https://\(host)") { await CookieBridge.clear(for: url) } }
	}
}

// MARK: - Pairing requests

enum PairingError: LocalizedError, Equatable {
	case rejected(String)
	case unreachable(String)
	case busy(String)
	case badResponse

	var errorDescription: String? {
		switch self {
		case .rejected(let message), .busy(let message), .unreachable(let message): message
		case .badResponse: "The computer answered with something this app didn't understand."
		}
	}
}

enum PairingClient {
	private static let wellKnown = "/.well-known/learnharness/"

	private struct Paired: Decodable { let token: String; let deviceId: String }
	private struct Failure: Decodable { let error: String }

	private static func endpoint(_ host: String, _ port: Int, _ path: String) -> URL {
		var parts = URLComponents()
		parts.scheme = "https"
		parts.host = host
		parts.port = port
		parts.path = wellKnown + path
		return parts.url!
	}

	private static func httpRequest(_ url: URL, method: String = "GET", json: [String: Any]? = nil) -> URLRequest {
		var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
		request.httpMethod = method
		request.setValue(ServerAddress.apiUserAgent, forHTTPHeaderField: "User-Agent")
		if let json {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try? JSONSerialization.data(withJSONObject: json)
		}
		return request
	}

	private static func ephemeral(_ delegate: URLSessionDelegate) -> URLSession {
		let config = URLSessionConfiguration.ephemeral
		config.timeoutIntervalForRequest = 10
		return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
	}

	private static func message(_ data: Data) -> String? { (try? JSONDecoder().decode(Failure.self, from: data))?.error }

	/// QR pairing: try each address with the fingerprint pinned; the first
	/// computer that accepts the one-time code issues this phone's token.
	static func pair(with link: PairingLink, deviceName: String) async throws -> (Pairing, String) {
		PinnedTrust.shared.pin(hosts: link.hosts, port: link.port, fingerprint: link.fingerprint)
		let session = ephemeral(PinningDelegate.shared)
		defer { session.finishTasksAndInvalidate() }
		var lastProblem = "Couldn't reach \(link.name). Check that this iPhone is on the same Wi-Fi and Phone access is on."
		for host in link.hosts {
			do {
				let (data, response) = try await session.data(for: httpRequest(endpoint(host, link.port, "pair/qr"), method: "POST", json: ["code": link.code, "deviceName": deviceName]))
				let status = (response as? HTTPURLResponse)?.statusCode ?? 0
				guard status == 200 else {
					if status == 429 { throw PairingError.busy(message(data) ?? "Too many attempts. Wait a minute.") }
					throw PairingError.rejected(message(data) ?? "The computer refused the code. Show a new QR code and scan again.")
				}
				guard let paired = try? JSONDecoder().decode(Paired.self, from: data) else { throw PairingError.badResponse }
				let rest = link.hosts.filter { $0 != host }
				return (Pairing(name: link.name, fingerprint: link.fingerprint, hosts: [host] + rest, port: link.port, deviceId: paired.deviceId), paired.token)
			} catch let error as URLError {
				lastProblem = error.code == .cancelled
					? "This computer's identity doesn't match the QR code. Don't pair, and check you're on the right network."
					: "Couldn't reach \(link.name) at \(host) (\(error.localizedDescription))."
				continue
			}
		}
		throw PairingError.unreachable(lastProblem)
	}

	/// Tells the computer to forget this phone (best effort; it may be off).
	static func unpair(_ pairing: Pairing, token: String) async {
		let session = ephemeral(PinningDelegate.shared)
		defer { session.finishTasksAndInvalidate() }
		var call = httpRequest(endpoint(pairing.hosts.first ?? "", pairing.port, "unpair"), method: "POST")
		call.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		_ = try? await session.data(for: call)
	}
}
