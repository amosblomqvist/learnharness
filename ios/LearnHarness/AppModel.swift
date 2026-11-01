import Foundation
import Observation

/// Everything the native screens show about the connected server: whether
/// this phone is signed in, the session list, and which turns are running.
/// The server stays the source of truth; the notification channel tells
/// this model when to fetch again.
@MainActor
@Observable
final class AppModel {
	enum Access: Equatable {
		case checking
		case signedOut
		case signedIn
		case unreachable(String)
	}

	let api: ServerAPI
	private(set) var access: Access = .checking
	private(set) var chats: [ChatSummary] = []
	private(set) var listError: String?
	private(set) var isLoadingList = false
	/// True while the live events channel is open.
	private(set) var live = false
	/// Running sub-agent jobs and graph extractions (the desktop sidebar's Background section).
	private(set) var activity = ActivityFeed(jobs: [], extractions: [])

	@ObservationIgnored private var eventsTask: Task<Void, Never>?
	@ObservationIgnored private var refreshTask: Task<Void, Never>?
	@ObservationIgnored private var activityTask: Task<Void, Never>?

	init(server: URL) {
		api = ServerAPI(server: server)
	}

	var server: URL { api.server }

	/// Picks up a sign-in from the web views (earlier app versions signed in
	/// there), then checks the session cookie with one list request.
	func start() async {
		await CookieBridge.copyFromWeb(for: server)
		await refresh()
	}

	func refresh() async {
		isLoadingList = true
		defer { isLoadingList = false }
		do {
			chats = try await api.chats().sorted { $0.updatedAt > $1.updatedAt }
			listError = nil
			if access != .signedIn {
				access = .signedIn
				startEvents()
				scheduleActivityRefresh()
			}
		} catch APIError.signedOut {
			stopEvents()
			access = .signedOut
		} catch {
			let message = error.localizedDescription
			if access == .signedIn { listError = message } else { access = .unreachable(message) }
		}
	}

	func signIn(password: String) async throws -> ServerAPI.SignInResult {
		let result = try await api.signIn(password: password)
		if result == .signedIn { await refresh() }
		return result
	}

	func signOut() async {
		stopEvents()
		await CookieBridge.clear(for: server)
		chats = []
		access = .signedOut
	}

	// MARK: Session actions

	func chat(_ id: String) -> ChatSummary? { chats.first { $0.id == id } }

	func rename(_ chat: ChatSummary, to title: String) async throws {
		let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty, trimmed != chat.title else { return }
		try await api.rename(chat.id, to: trimmed)
		if let index = chats.firstIndex(where: { $0.id == chat.id }) { chats[index].title = trimmed }
	}

	func delete(_ chat: ChatSummary, keepGraph: Bool) async throws {
		try await api.delete(chat.id, keepGraph: keepGraph)
		chats.removeAll { $0.id == chat.id }
	}

	/// Creates a session and sends its opening message. If the first message
	/// is refused (no model or key set up), the empty session is removed again
	/// so it doesn't linger in the list.
	func startSession(with text: String, practice: Bool) async throws -> String {
		let id = try await api.createChat(title: text, practice: practice)
		do {
			try await api.sendText(text, to: id)
		} catch {
			try? await api.delete(id, keepGraph: true)
			throw error
		}
		scheduleRefresh()
		return id
	}

	// MARK: Live updates

	private func startEvents() {
		guard eventsTask == nil else { return }
		eventsTask = Task { [weak self] in
			// A reconnect may have missed events: fetch the list once it opens.
			let onOpen: @Sendable () -> Void = { [weak self] in
				Task { @MainActor in
					self?.live = true
					await self?.refresh()
				}
			}
			var delay: UInt64 = 1
			while !Task.isCancelled {
				guard let self else { return }
				do {
					for try await event in self.api.events(onOpen: onOpen) {
						delay = 1
						self.apply(event)
					}
				} catch APIError.signedOut {
					self.live = false
					self.access = .signedOut
					self.eventsTask = nil
					return
				} catch {}
				self.live = false
				// Reconnect with backoff (server restarts, Wi-Fi changes).
				try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
				delay = min(delay * 2, 30)
			}
		}
	}

	private func stopEvents() {
		eventsTask?.cancel()
		eventsTask = nil
		live = false
	}

	private func apply(_ event: ServerEvent) {
		switch event.type {
		case "turn-started":
			setBusy(event.chatId, true)
			scheduleRefresh()
		case "turn-settled":
			setBusy(event.chatId, false)
			scheduleRefresh()
		case "chats-changed", "compaction-changed", "record-changed":
			scheduleRefresh()
		case "jobs-changed", "activity-changed":
			scheduleActivityRefresh()
		default:
			break
		}
	}

	private func setBusy(_ chatId: String?, _ busy: Bool) {
		guard let chatId, let index = chats.firstIndex(where: { $0.id == chatId }) else { return }
		chats[index].busy = busy
	}

	func updateSettings(_ settings: ChatSettings, for chatId: String) {
		guard let index = chats.firstIndex(where: { $0.id == chatId }) else { return }
		chats[index].settings = settings
	}

	func stop(_ kind: String, id: String) async throws {
		try await api.abort(kind: kind, id: id)
		scheduleActivityRefresh()
	}

	func scheduleActivityRefresh() {
		activityTask?.cancel()
		activityTask = Task { [weak self] in
			try? await Task.sleep(nanoseconds: 300_000_000)
			guard !Task.isCancelled, let self else { return }
			if let feed = try? await self.api.activity() { self.activity = feed }
		}
	}

	/// Coalesces bursts of events into one list fetch.
	func scheduleRefresh() {
		refreshTask?.cancel()
		refreshTask = Task { [weak self] in
			try? await Task.sleep(nanoseconds: 250_000_000)
			guard !Task.isCancelled else { return }
			await self?.refresh()
		}
	}
}
