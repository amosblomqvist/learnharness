import Foundation
import Observation
import WebKit

/// The one piece of app state: which server this phone uses. Everything
/// else (sessions, graph, settings, keys) lives on the server.
@MainActor
@Observable
final class ServerStore {
	private static let key = "serverURL"

	private(set) var server: URL?

	init(defaults: UserDefaults = .standard) {
		if let saved = defaults.string(forKey: Self.key), case .success(let url) = ServerAddress.normalize(saved) {
			server = url
		}
	}

	func connect(to url: URL) {
		server = url
		UserDefaults.standard.set(url.absoluteString, forKey: Self.key)
	}

	func disconnect() {
		server = nil
		UserDefaults.standard.removeObject(forKey: Self.key)
	}

	/// Clears this phone's session cookie for the server (other devices stay signed in).
	func signOut() async {
		guard let host = server?.host else { return }
		let store = WKWebsiteDataStore.default()
		let records = await store.dataRecords(ofTypes: [WKWebsiteDataTypeCookies])
		await store.removeData(ofTypes: [WKWebsiteDataTypeCookies], for: records.filter { $0.displayName == host || host.hasSuffix($0.displayName) })
	}
}
