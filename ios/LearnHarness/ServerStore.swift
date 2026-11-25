import Foundation
import Observation
import WebKit

/// The one piece of app state: which server this phone uses. Everything
/// else (sessions, graph, settings, keys) lives on the server. That is
/// either a computer paired through Phone access (docs/phone-access.md) or
/// a self-hosted server reached by address and password.
@MainActor
@Observable
final class ServerStore {
	private static let serverKey = "serverURL"
	private static let pairingKey = "pairing"

	private(set) var server: URL?
	/// Set when `server` is a paired computer's gateway.
	private(set) var pairing: Pairing?

	@ObservationIgnored private let defaults: UserDefaults

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
		if let data = defaults.data(forKey: Self.pairingKey), let saved = try? JSONDecoder().decode(Pairing.self, from: data), let token = DeviceTokenStore.load(saved.deviceId) {
			pairing = saved
			server = saved.url
			PinnedTrust.shared.pin(hosts: saved.hosts, port: saved.port, fingerprint: saved.fingerprint)
			Task { await DeviceCookie.install(token: token, hosts: saved.hosts) }
		} else if let saved = defaults.string(forKey: Self.serverKey), case .success(let url) = ServerAddress.normalize(saved) {
			server = url
		}
	}

	/// A self-hosted server by address (sign-in follows with its password).
	func connect(to url: URL) {
		let previous = pairing
		pairing = nil
		defaults.removeObject(forKey: Self.pairingKey)
		if let previous { Task { await Self.unpair(previous) } }
		server = url
		defaults.set(url.absoluteString, forKey: Self.serverKey)
	}

	/// A newly paired computer becomes this phone's server. Throws (and the
	/// computer is told to forget the phone) if the token can't be stored.
	func adopt(_ new: Pairing, token: String) async throws {
		do {
			try DeviceTokenStore.save(token, for: new.deviceId)
		} catch {
			PinnedTrust.shared.pin(hosts: new.hosts, port: new.port, fingerprint: new.fingerprint)
			await PairingClient.unpair(new, token: token)
			throw error
		}
		if let old = pairing, old.deviceId != new.deviceId { await Self.unpair(old) }
		PinnedTrust.shared.pin(hosts: new.hosts, port: new.port, fingerprint: new.fingerprint)
		await DeviceCookie.install(token: token, hosts: new.hosts)
		save(new)
		defaults.removeObject(forKey: Self.serverKey)
		server = new.url
	}

	/// The paired computer moved to another address (found again over Bonjour).
	func relocate(to host: String, port: Int) async {
		guard var moved = pairing, let token = DeviceTokenStore.load(moved.deviceId) else { return }
		moved.hosts = [host] + moved.hosts.filter { $0 != host }
		moved.port = port
		PinnedTrust.shared.pin(hosts: [host], port: port, fingerprint: moved.fingerprint)
		await DeviceCookie.install(token: token, hosts: [host])
		save(moved)
		server = moved.url
	}

	/// Unpairs this phone, telling the computer when it can be reached.
	func forgetPairing() async {
		guard let old = pairing else { return }
		pairing = nil
		defaults.removeObject(forKey: Self.pairingKey)
		if server == old.url { server = nil }
		await Self.unpair(old)
	}

	func disconnect() {
		server = nil
		defaults.removeObject(forKey: Self.serverKey)
	}

	/// Clears this phone's session cookie for the server (other devices stay signed in).
	func signOut() async {
		guard let host = server?.host else { return }
		let store = WKWebsiteDataStore.default()
		let records = await store.dataRecords(ofTypes: [WKWebsiteDataTypeCookies])
		await store.removeData(ofTypes: [WKWebsiteDataTypeCookies], for: records.filter { $0.displayName == host || host.hasSuffix($0.displayName) })
	}

	private func save(_ value: Pairing) {
		pairing = value
		if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: Self.pairingKey) }
	}

	/// Best-effort notice to the computer, then the token and cookies go.
	private static func unpair(_ old: Pairing) async {
		if let token = DeviceTokenStore.load(old.deviceId) { await PairingClient.unpair(old, token: token) }
		DeviceTokenStore.delete(old.deviceId)
		await DeviceCookie.remove(hosts: old.hosts)
	}
}
