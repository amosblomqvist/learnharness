import SwiftUI

/// Checks, step by step, everything a message needs to reach the model:
/// the address, this app being let in, the sign-in, the live channel, the
/// model setup and the provider key, then (on request) a real test message
/// in a throwaway session. Each step says what failed and what to do.
@MainActor
@Observable
final class ConnectionTest {
	enum Status { case waiting, running, passed, warning, failed, skipped }

	struct Step: Identifiable {
		let id: String
		let title: String
		var status: Status = .waiting
		var detail: String = ""
		var seconds: Double?
	}

	private(set) var steps: [Step] = []
	private(set) var isRunning = false
	/// The model's reply to the test message, when one was sent.
	private(set) var reply: String?

	let api: ServerAPI
	init(api: ServerAPI) { self.api = api }

	var report: String {
		var lines = ["LearnHarness connection test — \(api.server.absoluteString)", "App \(Bundle.main.appVersion) · \(Date().formatted())"]
		for step in steps {
			let mark = switch step.status {
			case .passed: "✓"
			case .warning: "!"
			case .failed: "✗"
			case .skipped: "–"
			case .waiting, .running: "…"
			}
			let time = step.seconds.map { String(format: " (%.1fs)", $0) } ?? ""
			lines.append("\(mark) \(step.title)\(time): \(step.detail)")
		}
		if let reply { lines.append("Reply: \(reply)") }
		if !PageDiagnostics.recent.isEmpty {
			lines.append("Recent page events:")
			lines.append(contentsOf: PageDiagnostics.recent)
		}
		return lines.joined(separator: "\n")
	}

	func run(sendMessage: Bool) async {
		guard !isRunning else { return }
		isRunning = true
		reply = nil
		defer { isRunning = false }
		steps = [
			Step(id: "reach", title: "Server answers"),
			Step(id: "signin", title: "Signed in"),
			Step(id: "live", title: "Live updates"),
			Step(id: "model", title: "Model chosen"),
			Step(id: "key", title: "Provider key"),
			Step(id: "message", title: "Test message"),
		]

		guard await step("reach", { try await self.checkReach() }) else { return skipRest() }
		guard await step("signin", { try await self.checkSignIn() }) else { return skipRest() }
		_ = await step("live", { try await self.checkLive() })
		var model: (provider: String, id: String)?
		_ = await step("model", {
			let found = try await self.checkModel()
			model = found
			return found == nil ? (.failed, "No model is set for new sessions. Pick one in Settings → Models & Agent.") : (.passed, "\(found!.provider) · \(found!.id)")
		})
		if let model {
			_ = await step("key", { try await self.checkKey(provider: model.provider) })
		} else {
			mark("key", .skipped, "Needs a model first.")
		}
		if sendMessage && model != nil {
			_ = await step("message", { try await self.sendTestMessage() })
		} else {
			mark("message", .skipped, sendMessage ? "Needs a model first." : "Tap “Send Test Message” to try a real turn.")
		}
	}

	// MARK: Steps

	private func checkReach() async throws -> (Status, String) {
		if let problem = await ServerAddress.probe(api.server) { return (.failed, problem) }
		// The probe sends this app's User-Agent; an apps-only server answering
		// with the sign-in page means it lets this app in.
		return (.passed, "\(api.server.absoluteString) is a LearnHarness server and lets this app in.")
	}

	private func checkSignIn() async throws -> (Status, String) {
		do {
			let chats = try await api.chats()
			return (.passed, "\(chats.count) session\(chats.count == 1 ? "" : "s") on the server.")
		} catch APIError.signedOut {
			return (.failed, "This phone isn't signed in. Sign in with the server password.")
		}
	}

	/// The notification channel must open promptly, or the app hears about
	/// replies late. Servers before the fix held it for ~25 seconds.
	private func checkLive() async throws -> (Status, String) {
		let start = Date()
		let opened = await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
			let once = Flag()
			let listener = Task {
				do {
					for try await _ in self.api.events(onOpen: { if once.set() { done.resume(returning: true) } }) { break }
				} catch {}
				if once.set() { done.resume(returning: false) }
			}
			Task {
				try? await Task.sleep(nanoseconds: 8_000_000_000)
				if once.set() { done.resume(returning: false) }
				listener.cancel()
			}
		}
		let elapsed = Date().timeIntervalSince(start)
		if !opened {
			return (.warning, "The live channel didn't open within 8 seconds, so replies show up late. Update the server (git pull, then rebuild the container).")
		}
		return elapsed > 3
			? (.warning, String(format: "Opened, but slowly (%.1fs). Update the server.", elapsed))
			: (.passed, "Connected.")
	}

	private func checkModel() async throws -> (provider: String, id: String)? {
		struct Catalog: Decodable {
			struct Slot: Decodable { struct Model: Decodable { let provider: String; let id: String }; let model: Model? }
			let slots: [String: Slot?]?
		}
		let catalog = try await api.decode(Catalog.self, api.request("/api/models", timeout: 30))
		guard let strong = catalog.slots?["strong"] ?? nil, let model = strong.model else { return nil }
		return (model.provider, model.id)
	}

	private func checkKey(provider: String) async throws -> (Status, String) {
		struct Keys: Decodable {
			struct Key: Decodable { let id: String; let present: Bool; let masked: String? }
			struct Provider: Decodable { let id: String; let envVar: String; let label: String? }
			let keys: [Key]
			let providers: [Provider]?
		}
		let keys = try await api.decode(Keys.self, api.request("/api/keys"))
		guard let entry = keys.providers?.first(where: { $0.id == provider }) else {
			// Subscriptions and custom providers sign in another way.
			return (.passed, "\(provider) doesn't use an API key here.")
		}
		let name = entry.label ?? provider
		if let key = keys.keys.first(where: { $0.id == entry.envVar }), key.present {
			return (.passed, "\(name) key saved\(key.masked.map { " (\($0))" } ?? "").")
		}
		return (.failed, "No \(name) API key on the server. Add it in Settings → Providers & API Keys.")
	}

	/// A real turn in a throwaway session, read straight off the turn stream,
	/// then the session is deleted (graph traces included).
	private func sendTestMessage() async throws -> (Status, String) {
		let id = try await api.createChat(title: "Connection test", practice: false)
		defer { Task { try? await self.api.delete(id, keepGraph: false) } }
		do {
			try await api.sendText("This is a connection test from the iPhone app. Reply with just the word: ok", to: id)
		} catch {
			return (.failed, "The server refused the message: \(TurnRefusal.message(for: error))")
		}
		let outcome = try await readTurn(chatId: id, timeout: 120)
		switch outcome {
		case .reply(let text, let model):
			reply = text
			return (.passed, "\(model ?? "The model") replied.")
		case .failed(let message):
			return (.failed, "The model call failed: \(message)")
		case .timedOut:
			return (.failed, "No reply within 2 minutes. The provider may be slow or down; check the server logs.")
		}
	}

	enum TurnOutcome { case reply(String, model: String?), failed(String), timedOut }

	private func readTurn(chatId: String, timeout: TimeInterval) async throws -> TurnOutcome {
		let request = api.request("/api/chats/\(chatId)/stream", timeout: timeout)
		let (bytes, response) = try await URLSession.shared.bytes(for: request)
		guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.badResponse }
		var last: TurnOutcome = .timedOut
		for try await line in bytes.lines where line.hasPrefix("data:") {
			let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
			if payload == "[DONE]" { break }
			guard let event = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] else { continue }
			switch event["type"] as? String {
			case "error":
				return .failed(event["errorText"] as? String ?? "Unknown error.")
			case "message_end":
				guard let message = event["message"] as? [String: Any], message["role"] as? String == "assistant" else { continue }
				if message["stopReason"] as? String == "error" {
					return .failed(message["errorMessage"] as? String ?? "The provider returned an error.")
				}
				let blocks = message["content"] as? [[String: Any]] ?? []
				let text = blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined()
				if !text.isEmpty { last = .reply(text, model: message["model"] as? String) }
			default:
				continue
			}
		}
		return last
	}

	// MARK: Bookkeeping

	private func step(_ id: String, _ check: () async throws -> (Status, String)) async -> Bool {
		mark(id, .running, "")
		let start = Date()
		let result: (Status, String)
		do { result = try await check() } catch { result = (.failed, error.localizedDescription) }
		mark(id, result.0, result.1, seconds: Date().timeIntervalSince(start))
		return result.0 != .failed
	}

	private func mark(_ id: String, _ status: Status, _ detail: String, seconds: Double? = nil) {
		guard let index = steps.firstIndex(where: { $0.id == id }) else { return }
		steps[index].status = status
		steps[index].detail = detail
		steps[index].seconds = seconds
	}

	private func skipRest() {
		for index in steps.indices where steps[index].status == .waiting {
			steps[index].status = .skipped
			steps[index].detail = "Fix the step above first."
		}
	}
}

/// A one-shot latch for continuations resumed from racing tasks.
private final class Flag: @unchecked Sendable {
	private var done = false
	private let lock = NSLock()
	/// True the first time only.
	func set() -> Bool {
		lock.lock()
		defer { lock.unlock() }
		if done { return false }
		done = true
		return true
	}
}

extension Bundle {
	var appVersion: String {
		let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
		let build = infoDictionary?["CFBundleVersion"] as? String ?? "?"
		return "\(version) (\(build))"
	}
}

struct ConnectionTestView: View {
	@Environment(AppModel.self) private var model
	@State private var test: ConnectionTest?

	var body: some View {
		List {
			if let test {
				Section {
					ForEach(test.steps) { step in
						StepRow(step: step)
					}
				} footer: {
					Text("The test message uses a throwaway session that is deleted afterwards. It costs one short model call.")
				}
				if let reply = test.reply {
					Section("Model's reply") {
						Text(reply).font(.body.monospaced())
					}
				}
				if !test.isRunning && !PageDiagnostics.recent.isEmpty {
					Section("Recent page events") {
						ForEach(Array(PageDiagnostics.recent.suffix(10).reversed().enumerated()), id: \.offset) { _, line in
							Text(line).font(Theme.ui(11)).foregroundStyle(Theme.muted)
						}
					}
				}
				Section {
					Button {
						Task { await test.run(sendMessage: false) }
					} label: {
						Label("Run Checks", systemImage: "stethoscope")
					}
					.disabled(test.isRunning)
					Button {
						Task { await test.run(sendMessage: true) }
					} label: {
						Label("Send Test Message", systemImage: "paperplane")
					}
					.disabled(test.isRunning)
					if !test.steps.isEmpty && !test.isRunning {
						ShareLink(item: test.report) {
							Label("Share Report", systemImage: "square.and.arrow.up")
						}
					}
				}
			}
		}
		.lhList()
		.background(Color.appBackground)
		.navigationTitle("Connection Test")
		.navigationBarTitleDisplayMode(.inline)
		.task {
			guard test == nil else { return }
			let test = ConnectionTest(api: model.api)
			self.test = test
			await test.run(sendMessage: false)
		}
	}

	private struct StepRow: View {
		let step: ConnectionTest.Step

		var body: some View {
			HStack(alignment: .top, spacing: 12) {
				icon.frame(width: 22)
				VStack(alignment: .leading, spacing: 2) {
					HStack {
						Text(step.title).font(.body.weight(.medium))
						Spacer()
						if let seconds = step.seconds {
							Text(String(format: "%.1fs", seconds)).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
						}
					}
					if !step.detail.isEmpty {
						Text(step.detail).font(.footnote).foregroundStyle(.secondary)
					}
				}
			}
			.padding(.vertical, 2)
		}

		@ViewBuilder
		private var icon: some View {
			switch step.status {
			case .waiting: Image(systemName: "circle").foregroundStyle(.tertiary)
			case .running: ProgressView().controlSize(.small)
			case .passed: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
			case .warning: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
			case .failed: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
			case .skipped: Image(systemName: "minus.circle").foregroundStyle(.tertiary)
			}
		}
	}
}
