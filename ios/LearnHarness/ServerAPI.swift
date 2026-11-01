import Foundation
import WebKit

/// One session row, as GET /api/chats lists it (src/core/contracts/chat.ts ChatListItem).
struct ChatSummary: Decodable, Identifiable, Hashable {
	let id: String
	var title: String
	let createdAt: Date
	let updatedAt: Date
	/// "teach" or "practice".
	let kind: String
	let messageCount: Int
	/// "probe", "plan" or "teach".
	let phase: String?
	let pendingQuestion: Bool
	let pendingProblem: Bool?
	/// A turn is running for this session right now.
	var busy: Bool
	let compacting: Bool?
	/// The session's own model and thinking level (set at birth from the strong slot).
	var settings: ChatSettings?

	var isPractice: Bool { kind == "practice" }

	/// The desktop phase chip's words.
	var phaseLabel: String {
		if isPractice { return "Practice" }
		switch phase {
		case "plan": return "Planning"
		case "teach": return "Teaching"
		default: return "Probing"
		}
	}
}

struct ModelRef: Codable, Hashable {
	let provider: String
	let id: String
}

struct ChatSettings: Codable, Hashable {
	var model: ModelRef?
	var thinkingLevel: String?
}

/// One pickable model (GET /api/models, src/core/contracts/models.ts).
struct CatalogModel: Decodable, Identifiable, Hashable {
	let id: String
	let name: String
	let provider: String
	let reasoning: Bool
	let supportedLevels: [String]

	var ref: ModelRef { ModelRef(provider: provider, id: id) }
}

/// Running background work (GET /api/activity): sub-agent jobs and graph extractions.
struct ActivityFeed: Decodable {
	struct Job: Decodable, Identifiable, Hashable {
		let id: String
		let kind: String
		let chatId: String
		let status: String
		let activity: String
		let title: String
		let costUsd: Double?
	}

	struct Extraction: Decodable, Identifiable, Hashable {
		let id: String
		let chatId: String
		let title: String
		let phase: String
	}

	let jobs: [Job]
	let extractions: [Extraction]
}

/// One frame from the server's notification channel (GET /api/events).
struct ServerEvent: Equatable {
	let type: String
	let chatId: String?
}

enum APIError: LocalizedError, Equatable {
	/// 401: the session cookie is missing or expired.
	case signedOut
	/// 403 from an apps-only server that didn't recognise this app.
	case refused(String)
	case server(status: Int, message: String)
	case unreachable(String)
	case badResponse

	var errorDescription: String? {
		switch self {
		case .signedOut: "You're signed out of your server."
		case .refused(let message): message
		case .server(let status, let message): message.isEmpty ? "The server answered with an error (\(status))." : message
		case .unreachable(let message): message
		case .badResponse: "The server sent something this app didn't understand."
		}
	}
}

/// The app's own requests to the LearnHarness server. Cookies are shared
/// with the web views (CookieBridge), so one sign-in covers both.
struct ServerAPI: Sendable {
	let server: URL

	private static let session: URLSession = {
		let config = URLSessionConfiguration.default
		config.httpCookieStorage = .shared
		config.httpShouldSetCookies = true
		config.httpCookieAcceptPolicy = .always
		config.requestCachePolicy = .reloadIgnoringLocalCacheData
		config.timeoutIntervalForRequest = 20
		return URLSession(configuration: config)
	}()

	/// The notification channel never ends on its own, so it gets no timeout.
	private static let streamSession: URLSession = {
		let config = URLSessionConfiguration.default
		config.httpCookieStorage = .shared
		config.requestCachePolicy = .reloadIgnoringLocalCacheData
		config.timeoutIntervalForRequest = 60 * 60 * 24
		config.timeoutIntervalForResource = 60 * 60 * 24 * 7
		return URLSession(configuration: config)
	}()

	private static let decoder: JSONDecoder = {
		let decoder = JSONDecoder()
		let fractional = ISO8601DateFormatter()
		fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		let plain = ISO8601DateFormatter()
		decoder.dateDecodingStrategy = .custom { decoder in
			let text = try decoder.singleValueContainer().decode(String.self)
			if let date = fractional.date(from: text) ?? plain.date(from: text) { return date }
			throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad date \(text)"))
		}
		return decoder
	}()

	func request(_ path: String, method: String = "GET", json: Any? = nil, timeout: TimeInterval = 20) -> URLRequest {
		var request = URLRequest(url: URL(string: path, relativeTo: server)!.absoluteURL, timeoutInterval: timeout)
		request.httpMethod = method
		request.setValue(ServerAddress.apiUserAgent, forHTTPHeaderField: "User-Agent")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		if let json {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try? JSONSerialization.data(withJSONObject: json)
		}
		return request
	}

	/// Sends a request and returns the response whatever its status.
	func raw(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await Self.session.data(for: request)
		} catch let error as URLError {
			throw APIError.unreachable(Self.describe(error, server: server))
		}
		guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
		return (data, http)
	}

	/// Sends a request and turns HTTP failures into APIError.
	@discardableResult
	func send(_ request: URLRequest) async throws -> Data {
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await Self.session.data(for: request)
		} catch let error as URLError {
			throw APIError.unreachable(Self.describe(error, server: server))
		}
		guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
		switch http.statusCode {
		case 200..<300: return data
		case 401: throw APIError.signedOut
		case 403: throw APIError.refused(Self.errorText(data) ?? "The server refused this app.")
		default: throw APIError.server(status: http.statusCode, message: Self.errorText(data) ?? "")
		}
	}

	func decode<T: Decodable>(_ type: T.Type, _ request: URLRequest) async throws -> T {
		let data = try await send(request)
		do { return try Self.decoder.decode(T.self, from: data) } catch { throw APIError.badResponse }
	}

	// MARK: Sessions

	func chats() async throws -> [ChatSummary] {
		struct List: Decodable { let chats: [ChatSummary] }
		return try await decode(List.self, request("/api/chats")).chats
	}

	/// Creates a session titled from its opening message (POST /api/chats).
	func createChat(title: String, practice: Bool) async throws -> String {
		struct Created: Decodable { let id: String }
		var body: [String: Any] = ["title": title]
		if practice { body["kind"] = "practice" }
		return try await decode(Created.self, request("/api/chats", method: "POST", json: body)).id
	}

	func rename(_ chatId: String, to title: String) async throws {
		try await send(request("/api/chats/\(chatId)", method: "PUT", json: ["title": title]))
	}

	/// `keepGraph` false also removes the session's topics, links and events from the graph.
	func delete(_ chatId: String, keepGraph: Bool) async throws {
		try await send(request("/api/chats/\(chatId)?mode=\(keepGraph ? "preserve-graph" : "delete-nodes")", method: "DELETE"))
	}

	// MARK: Session controls

	func models() async throws -> [CatalogModel] {
		struct Catalog: Decodable { let models: [CatalogModel] }
		return try await decode(Catalog.self, request("/api/models", timeout: 30)).models
	}

	/// The session's model and thinking level (PUT /api/chats/:id/settings).
	func setSettings(_ settings: ChatSettings, for chatId: String) async throws -> ChatSettings {
		struct Saved: Decodable { let settings: ChatSettings }
		var body: [String: Any] = [:]
		if let model = settings.model { body["model"] = ["provider": model.provider, "id": model.id] }
		if let level = settings.thinkingLevel { body["thinkingLevel"] = level }
		return try await decode(Saved.self, request("/api/chats/\(chatId)/settings", method: "PUT", json: body)).settings
	}

	/// The session as Markdown, written to a temporary file for the share sheet.
	func exportMarkdown(_ chatId: String, title: String) async throws -> URL {
		let data = try await send(request("/api/chats/\(chatId)/markdown"))
		let name = title.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: "-").lowercased()
		let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
		try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		let file = folder.appending(path: "\(name.isEmpty ? "session" : name).md")
		try data.write(to: file)
		return file
	}

	func activity() async throws -> ActivityFeed {
		try await decode(ActivityFeed.self, request("/api/activity"))
	}

	/// Stops a background job or extraction ("job" / "extraction").
	func abort(kind: String, id: String) async throws {
		try await send(request("/api/activity/abort", method: "POST", json: ["kind": kind, "id": id]))
	}

	// MARK: Turns

	/// Starts a turn with the learner's message (POST /api/chat answers at once;
	/// the reply streams on /api/chats/:id/stream, which the web view attaches to).
	func sendText(_ text: String, to chatId: String) async throws {
		try await sendInput(["type": "text", "text": text], to: chatId)
	}

	/// The practice "next problem" signal.
	func sendNext(to chatId: String) async throws {
		try await sendInput(["type": "next"], to: chatId)
	}

	func sendInput(_ input: [String: Any], to chatId: String) async throws {
		try await send(request("/api/chat", method: "POST", json: ["chatId": chatId, "input": input], timeout: 60))
	}

	/// A message sent while a turn runs steers it instead of starting a new one.
	func steer(_ text: String, in chatId: String) async throws {
		let id = "steer_\(UUID().uuidString.lowercased())"
		try await send(request("/api/chats/\(chatId)/steer", method: "POST", json: ["input": ["type": "steer", "id": id, "text": text]]))
	}

	func stopTurn(in chatId: String) async throws {
		try await send(request("/api/activity/abort", method: "POST", json: ["kind": "turn", "id": chatId]))
	}

	// MARK: Sign-in

	enum SignInResult: Equatable { case signedIn, wrongPassword, throttled }

	/// POST /api/auth/login with the password. Success is a redirect that sets
	/// the `lh_session` cookie; a failure redirects back to /login?error=….
	func signIn(password: String) async throws -> SignInResult {
		var request = request("/api/auth/login", method: "POST")
		request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
		request.httpBody = Data("password=\(Self.formEncode(password))&next=%2F".utf8)
		let response: URLResponse
		do {
			(_, response) = try await NoRedirect.session.data(for: request)
		} catch let error as URLError {
			throw APIError.unreachable(Self.describe(error, server: server))
		}
		guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
		if http.statusCode == 403 { throw APIError.refused("The server refused this app.") }
		let location = http.value(forHTTPHeaderField: "Location") ?? ""
		if location.contains("error=throttled") { return .throttled }
		if location.contains("error=") { return .wrongPassword }
		let headers = http.allHeaderFields.reduce(into: [String: String]()) { $0["\($1.key)"] = "\($1.value)" }
		let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: server)
		guard (300..<400).contains(http.statusCode), cookies.contains(where: { $0.name == "lh_session" }) else {
			throw APIError.server(status: http.statusCode, message: "The server didn't accept the sign-in.")
		}
		cookies.forEach { HTTPCookieStorage.shared.setCookie($0) }
		await CookieBridge.copyToWeb(cookies)
		return .signedIn
	}

	/// Login must see the redirect itself (it carries the cookie and any error).
	private final class NoRedirect: NSObject, URLSessionTaskDelegate {
		static let session: URLSession = {
			let config = URLSessionConfiguration.ephemeral
			config.timeoutIntervalForRequest = 15
			return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
		}()

		func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
			nil
		}
	}

	// MARK: Notification channel

	/// The server's live events (turn started/settled, session list changed…).
	/// `onOpen` fires once the response headers arrive.
	func events(onOpen: @escaping @Sendable () -> Void = {}) -> AsyncThrowingStream<ServerEvent, Error> {
		var request = request("/api/events", timeout: 60 * 60 * 24)
		request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
		return AsyncThrowingStream { continuation in
			let task = Task {
				do {
					let (bytes, response) = try await Self.streamSession.bytes(for: request)
					guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
					if http.statusCode == 401 { throw APIError.signedOut }
					guard http.statusCode == 200 else { throw APIError.server(status: http.statusCode, message: "") }
					onOpen()
					var type: String?
					var data = ""
					for try await line in bytes.lines {
						if line.hasPrefix("event:") {
							type = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
						} else if line.hasPrefix("data:") {
							data += line.dropFirst(5).trimmingCharacters(in: .whitespaces)
							// AsyncLineSequence drops blank lines, so a data line ends the frame.
							if let name = type {
								let payload = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any]
								continuation.yield(ServerEvent(type: name, chatId: payload?["chatId"] as? String))
							}
							type = nil
							data = ""
						}
					}
					continuation.finish()
				} catch let error as URLError {
					continuation.finish(throwing: APIError.unreachable(Self.describe(error, server: server)))
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in task.cancel() }
		}
	}

	// MARK: Helpers

	/// application/x-www-form-urlencoded value: everything but unreserved characters escaped.
	static func formEncode(_ value: String) -> String {
		var allowed = CharacterSet.alphanumerics
		allowed.insert(charactersIn: "-._~")
		return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
	}

	static func errorText(_ data: Data) -> String? {
		if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let error = object["error"] as? String, !error.isEmpty {
			return error
		}
		let text = String(decoding: data.prefix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
		return text.isEmpty || text.hasPrefix("<") ? nil : text
	}

	static func describe(_ error: URLError, server: URL) -> String {
		let name = server.host() ?? server.absoluteString
		switch error.code {
		case .timedOut: return "\(name) didn't answer in time."
		case .notConnectedToInternet: return "This phone is offline."
		case .cannotFindHost, .dnsLookupFailed: return "Couldn't find \(name). On the go, use Tailscale and the server's Tailscale name."
		case .cannotConnectToHost: return "Nothing is answering at \(server.absoluteString). Check the server is running."
		case .networkConnectionLost: return "The connection to \(name) dropped."
		case .appTransportSecurityRequiresSecureConnection: return "iOS blocked the plain http:// connection."
		default: return "Couldn't reach \(name) (\(error.localizedDescription))."
		}
	}
}

/// Keeps the app's cookie jar and the web views' cookie store in step, so a
/// sign-in in either place signs in both.
enum CookieBridge {
	@MainActor
	static func copyFromWeb(for server: URL) async {
		let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
		for cookie in cookies where matches(cookie, server) {
			HTTPCookieStorage.shared.setCookie(cookie)
		}
	}

	@MainActor
	static func copyToWeb(_ cookies: [HTTPCookie]) async {
		let store = WKWebsiteDataStore.default().httpCookieStore
		for cookie in cookies { await store.setCookie(cookie) }
	}

	/// Signs this phone out: removes the server's cookies from both jars.
	@MainActor
	static func clear(for server: URL) async {
		for cookie in HTTPCookieStorage.shared.cookies ?? [] where matches(cookie, server) {
			HTTPCookieStorage.shared.deleteCookie(cookie)
		}
		let store = WKWebsiteDataStore.default().httpCookieStore
		for cookie in await store.allCookies() where matches(cookie, server) {
			await store.deleteCookie(cookie)
		}
	}

	private static func matches(_ cookie: HTTPCookie, _ server: URL) -> Bool {
		guard let host = server.host()?.lowercased() else { return false }
		let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
		return host == domain || host.hasSuffix("." + domain)
	}
}
