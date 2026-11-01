import SwiftUI

/// Starts a session: teaching (the teacher probes, plans and teaches) or
/// practice (worked problems). The first message becomes the session's
/// title and its first turn, the same as on desktop.
struct NewSessionView: View {
	@Environment(AppModel.self) private var model
	@Environment(Router.self) private var router
	@Environment(\.dismiss) private var dismiss
	/// Called with the new session's id once its first message is accepted.
	let onStarted: (String) -> Void

	@State private var practice: Bool
	@State private var text = ""
	@State private var starting = false
	@State private var error: String?
	@State private var dictation = Dictation()
	@FocusState private var focused: Bool

	init(practice: Bool = false, onStarted: @escaping (String) -> Void) {
		_practice = State(initialValue: practice)
		self.onStarted = onStarted
	}

	var body: some View {
		NavigationStack {
			VStack(alignment: .leading, spacing: 16) {
				Picker("Kind", selection: $practice) {
					Label("Learn", systemImage: "book").tag(false)
					Label("Practice", systemImage: "dumbbell").tag(true)
				}
				.pickerStyle(.segmented)

				Text(practice ? "What do you want to practise? The teacher will set problems one at a time." : "What do you want to learn? The teacher finds out what you already know, makes a plan and teaches it.")
					.font(Theme.ui(13))
					.foregroundStyle(Theme.muted)

				ZStack(alignment: .topLeading) {
					if text.isEmpty {
						Text(practice ? "e.g. Subnetting for the CCNA" : "e.g. How does TCP congestion control work?")
							.font(Theme.ui(15))
							.foregroundStyle(Theme.muted.opacity(0.6))
							.padding(.horizontal, 5)
							.padding(.vertical, 8)
					}
					TextEditor(text: $text)
						.focused($focused)
						.scrollContentBackground(.hidden)
				}
				.font(Theme.ui(15))
				.frame(minHeight: 140)
				.padding(10)
				.lhCard()

				HStack {
					DictationButton(text: $text, dictation: dictation)
					if let error = dictation.error {
						Text(error).font(.caption).foregroundStyle(.orange)
					}
					Spacer()
				}

				if let error {
					Label {
						VStack(alignment: .leading, spacing: 6) {
							Text(error)
							Button("Open Model Settings") {
								dismiss()
								router.tab = .settings
							}
							.font(.footnote.bold())
						}
					} icon: {
						Image(systemName: "exclamationmark.triangle.fill")
					}
					.foregroundStyle(Theme.destructive)
					.font(Theme.ui(12))
				}
				Spacer()
			}
			.padding(20)
			.background(Color.appBackground)
			.navigationTitle("New Session")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					if starting {
						ProgressView()
					} else {
						Button("Start", action: start)
							.bold()
							.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
					}
				}
			}
			.onAppear { focused = true }
			.onDisappear { dictation.stop() }
		}
		.presentationDetents([.large])
	}

	private func start() {
		let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !message.isEmpty, !starting else { return }
		dictation.stop()
		starting = true
		error = nil
		Task {
			defer { starting = false }
			do {
				let id = try await model.startSession(with: message, practice: practice)
				dismiss()
				onStarted(id)
			} catch {
				self.error = TurnRefusal.message(for: error)
			}
		}
	}
}

/// Plain words for the server's refusals of a first message (the 503
/// envelopes from src/server/chat-handler.ts carry machine codes).
enum TurnRefusal {
	static func message(for error: Error) -> String {
		guard case APIError.server(let status, let text) = error else { return error.localizedDescription }
		if text.contains("models_not_configured") || text.localizedCaseInsensitiveContains("not configured") {
			return "No model is set up yet. Pick your models in Settings → Models & Agent."
		}
		if status == 503, text.localizedCaseInsensitiveContains("key") {
			return "The model's provider has no API key. Add it in Settings → Providers & API Keys."
		}
		return text.isEmpty ? "The server refused the message (\(status))." : text
	}
}
