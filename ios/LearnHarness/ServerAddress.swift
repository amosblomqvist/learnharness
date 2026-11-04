import Foundation

/// Address handling for a self-hosted LearnHarness server. Mirrors the
/// desktop app's rules (electron/remote-server.cjs) so both clients accept
/// and warn about the same addresses.
enum ServerAddress {
	/// Appended to every request's User-Agent (web views and API calls) so a
	/// server in apps-only mode (LH_APPS_ONLY) lets this app in.
	static let appUserAgentToken = "LearnHarnessiOS/2.0"

	/// Tells the server's pages that this app draws the navigation, composer
	/// and dictation itself (components/native-shell.ts hides the web's own).
	static let nativeShellToken = "LHNativeShell/1"

	/// The User-Agent for the app's own API requests.
	static let apiUserAgent = "LearnHarness/2.0 \(appUserAgentToken)"

	/// Home-network and Tailscale names that never resolve on the public internet.
	static let privateSuffixes = [".local", ".lan", ".home", ".internal", ".home.arpa", ".ts.net"]

	enum Problem: Error, Equatable {
		case empty, invalid, unsupportedScheme, credentialsInAddress

		var message: String {
			switch self {
			case .empty: "Enter your server's address."
			case .invalid: "That doesn't look like a web address."
			case .unsupportedScheme: "Use an http:// or https:// address."
			case .credentialsInAddress: "Leave the username and password out of the address."
			}
		}
	}

	/// Typed address → server origin (scheme://host[:port]). A bare host gets
	/// http:// when it names a port (LAN / Tailscale), https:// otherwise.
	static func normalize(_ input: String) -> Result<URL, Problem> {
		let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty else { return .failure(.empty) }
		let hasScheme = text.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*://", options: .regularExpression) != nil
		let namesPort = text.range(of: ":[0-9]+(/|$)", options: .regularExpression) != nil
		let withScheme = hasScheme ? text : "\(namesPort ? "http" : "https")://\(text)"
		guard let parts = URLComponents(string: withScheme), let host = parts.host, !host.isEmpty else {
			return .failure(.invalid)
		}
		guard let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
			return .failure(.unsupportedScheme)
		}
		guard parts.user == nil, parts.password == nil else { return .failure(.credentialsInAddress) }
		var origin = URLComponents()
		origin.scheme = scheme
		origin.host = host.lowercased()
		let defaultPort = scheme == "http" ? 80 : 443
		if let port = parts.port, port != defaultPort { origin.port = port }
		guard let url = origin.url else { return .failure(.invalid) }
		return .success(url)
	}

	/// Plain http is fine on loopback, private LAN ranges and Tailscale;
	/// anywhere else the password and session cookie would cross the
	/// internet unencrypted.
	static func isInsecure(_ url: URL) -> Bool {
		guard url.scheme == "http", let host = url.host?.lowercased() else { return false }
		if host == "localhost" || host == "::1" || !host.contains(".") { return false }
		if privateSuffixes.contains(where: { host.hasSuffix($0) }) { return false }
		let octets = host.split(separator: ".").map { Int($0) }
		guard octets.count == 4, octets.allSatisfy({ ($0 ?? -1) >= 0 && ($0 ?? 256) <= 255 }) else { return true }
		let a = octets[0]!, b = octets[1]!
		let isPrivate = a == 127 || a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 100 && (64...127).contains(b))
		return !isPrivate
	}

	/// Checks the address answers with a LearnHarness server-mode sign-in page.
	/// Without cookies: a signed-in phone would be redirected away from /login.
	static let probeSession = URLSession(configuration: .ephemeral)

	static func probe(_ server: URL, session: URLSession = probeSession) async -> String? {
		var request = URLRequest(url: server.appending(path: "login"), timeoutInterval: 8)
		request.cachePolicy = .reloadIgnoringLocalCacheData
		request.setValue(apiUserAgent, forHTTPHeaderField: "User-Agent")
		do {
			let (data, response) = try await session.data(for: request)
			let status = (response as? HTTPURLResponse)?.statusCode ?? 0
			let body = String(decoding: data, as: UTF8.self)
			if status == 200, body.contains("action=\"/api/auth/login\"") { return nil }
			return "\(server.absoluteString) answered, but it isn't a LearnHarness server with server mode (the self-hosting branch)."
		} catch let error as URLError where error.code == .timedOut {
			return "Couldn't reach \(server.absoluteString) (it didn't answer in time). Check the address and that the server is running."
		} catch {
			return "Couldn't reach \(server.absoluteString) (nothing answered). Check the address, that the server is running, and that this phone is on the same network or Tailscale."
		}
	}
}
