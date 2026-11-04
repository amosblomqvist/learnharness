import SwiftUI

/// What the session's page reports about its composer (chatState messages,
/// components/chat.tsx). Until the page reports, the composer shows.
struct ChatPageState: Equatable {
	var busy = false
	/// False while a question or practice problem waits: the page's dock
	/// takes the composer's place, as on desktop.
	var composer = true
	var compacting = false
	var nextReady = false
	var configured = true
	var hasPlan = false
}

/// One session. The transcript, question and practice cards are the
/// desktop's own rendering; the header controls, composer and dictation
/// are native.
struct ChatScreen: View {
	let chatId: String

	@Environment(AppModel.self) private var model
	@Environment(Router.self) private var router
	@Environment(\.dismiss) private var dismiss

	@State private var page: WebPage?
	@State private var state = ChatPageState()
	@State private var text = ""
	@State private var sending = false
	@State private var sendError: String?
	@State private var renaming = false
	@State private var newTitle = ""
	@State private var confirmingDelete = false
	@State private var showingModel = false
	@State private var exported: URL?

	private var chat: ChatSummary? { model.chat(chatId) }
	private var busy: Bool { state.busy || (chat?.busy ?? false) }

	var body: some View {
		Group {
			if let page { WebPageView(page: page) } else { Theme.background }
		}
		.ignoresSafeArea(.container, edges: .bottom)
		.safeAreaInset(edge: .bottom, spacing: 0) {
			if state.composer {
				ComposerBar(
					text: $text,
					busy: busy,
					sending: sending,
					canSend: !state.compacting,
					nextReady: state.nextReady,
					error: sendError,
					onSend: send,
					onStop: stop,
					onNext: next,
					onDismissError: { sendError = nil }
				)
			}
		}
		.navigationBarTitleDisplayMode(.inline)
		.toolbar(.hidden, for: .tabBar)
		.toolbar {
			ToolbarItem(placement: .principal) {
				VStack(spacing: 1) {
					Text(chat?.title ?? "Session")
						.font(Theme.title(17))
						.foregroundStyle(Theme.foreground)
						.lineLimit(1)
					Text(subtitle.uppercased())
						.font(Theme.label(10))
						.tracking(0.8)
						.foregroundStyle(Theme.muted)
				}
			}
			ToolbarItemGroup(placement: .topBarTrailing) {
				if state.hasPlan {
					Button { page?.run("window.lhNativeChat?.openPlan()") } label: {
						Image(systemName: "point.topleft.down.to.point.bottomright.curvepath")
					}
					.accessibilityLabel("Open the Plan")
				}
				menu
			}
		}
		.sheet(isPresented: $showingModel) {
			ModelPickerView(chatId: chatId, current: chat?.settings)
		}
		.sheet(item: $exported) { file in
			ShareSheet(items: [file])
		}
		.alert("Rename Session", isPresented: $renaming) {
			TextField("Name", text: $newTitle)
			Button("Cancel", role: .cancel) {}
			Button("Rename") {
				guard let chat else { return }
				Task { try? await model.rename(chat, to: newTitle) }
			}
		}
		.confirmationDialog("Delete this session?", isPresented: $confirmingDelete, titleVisibility: .visible) {
			Button("Delete Session", role: .destructive) { delete(keepGraph: true) }
			Button("Delete and Remove Its Graph Traces", role: .destructive) { delete(keepGraph: false) }
		} message: {
			Text("Deleting keeps what this session added to your knowledge graph.")
		}
		.onAppear(perform: makePage)
	}

	private var menu: some View {
		Menu {
			Section {
				Button { showingModel = true } label: {
					Label {
						Text("Model & Thinking")
						Text(modelSummary)
					} icon: {
						Image(systemName: "cpu")
					}
				}
				Button("Find in Session", systemImage: "magnifyingglass") { page?.run("window.lhNativeChat?.find()") }
				if state.hasPlan {
					Button("Open the Plan", systemImage: "point.topleft.down.to.point.bottomright.curvepath") {
						page?.run("window.lhNativeChat?.openPlan()")
					}
				}
			}
			Section {
				Button("Export as Markdown", systemImage: "square.and.arrow.up") { export() }
				Button("Rename", systemImage: "pencil") {
					newTitle = chat?.title ?? ""
					renaming = true
				}
				Button("Reload", systemImage: "arrow.clockwise") { page?.reload() }
			}
			if busy {
				Button("Stop the Teacher", systemImage: "stop.fill") { stop() }
			}
			Button("Delete Session", systemImage: "trash", role: .destructive) { confirmingDelete = true }
		} label: {
			Image(systemName: "ellipsis.circle")
		}
		.accessibilityLabel("Session Options")
	}

	private var subtitle: String {
		if busy { return "Thinking…" }
		if state.compacting { return "Compacting context…" }
		return chat?.phaseLabel ?? ""
	}

	private var modelSummary: String {
		guard let model = chat?.settings?.model else { return "Not set" }
		let level = chat?.settings?.thinkingLevel.map { " · \($0)" } ?? ""
		return "\(model.id)\(level)"
	}

	private func makePage() {
		guard page == nil else { return }
		let page = WebPage(server: model.server, path: "/chat/\(chatId)")
		page.onMessage = { message in
			guard message["type"] as? String == "chatState", message["chatId"] as? String == chatId else { return }
			state = ChatPageState(
				busy: message["busy"] as? Bool ?? false,
				composer: message["composer"] as? Bool ?? true,
				compacting: message["compacting"] as? Bool ?? false,
				nextReady: message["nextReady"] as? Bool ?? false,
				configured: message["configured"] as? Bool ?? true,
				hasPlan: message["hasPlan"] as? Bool ?? false
			)
		}
		page.onRoute = { path in
			if path.hasPrefix("/chat/"), let other = path.split(separator: "/").last.map(String.init), other != "new" {
				router.open(chat: other)
				return true
			}
			// The page left its session (deleted elsewhere, or a link home).
			dismiss()
			return true
		}
		self.page = page
	}

	private func send() {
		let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !message.isEmpty, !sending else { return }
		sending = true
		sendError = nil
		let steering = busy
		text = ""
		Task {
			defer { sending = false }
			do {
				if steering {
					do {
						try await model.api.steer(message, in: chatId)
					} catch APIError.server(status: 409, _) {
						// The turn ended between the tap and the request: send normally.
						try await model.api.sendText(message, to: chatId)
					}
				} else {
					try await model.api.sendText(message, to: chatId)
				}
			} catch {
				// Keep what was typed so nothing is lost.
				if text.isEmpty { text = message }
				sendError = TurnRefusal.message(for: error)
			}
		}
	}

	private func next() {
		Task {
			do { try await model.api.sendNext(to: chatId) } catch { sendError = TurnRefusal.message(for: error) }
		}
	}

	private func stop() {
		// The page's own Stop also detaches its stream; the API call covers a
		// page that hasn't loaded its bridge.
		page?.run("window.lhNativeChat?.stop()")
		Task { try? await model.api.stopTurn(in: chatId) }
	}

	private func export() {
		Task {
			do { exported = try await model.api.exportMarkdown(chatId, title: chat?.title ?? "session") } catch { sendError = error.localizedDescription }
		}
	}

	private func delete(keepGraph: Bool) {
		guard let chat else { return }
		Task {
			do {
				try await model.delete(chat, keepGraph: keepGraph)
				dismiss()
			} catch {
				sendError = error.localizedDescription
			}
		}
	}
}

extension URL: @retroactive Identifiable {
	public var id: String { absoluteString }
}

struct ShareSheet: UIViewControllerRepresentable {
	let items: [Any]

	func makeUIViewController(context: Context) -> UIActivityViewController {
		UIActivityViewController(activityItems: items, applicationActivities: nil)
	}

	func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// The composer, in the desktop dock's shape: a bordered card with the
/// mic on the left and send (or stop while the teacher works) on the right.
struct ComposerBar: View {
	@Binding var text: String
	let busy: Bool
	let sending: Bool
	let canSend: Bool
	let nextReady: Bool
	let error: String?
	let onSend: () -> Void
	let onStop: () -> Void
	let onNext: () -> Void
	let onDismissError: () -> Void

	@State private var dictation = Dictation()
	@FocusState private var focused: Bool

	private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

	var body: some View {
		VStack(spacing: 8) {
			if let message = error ?? dictation.error {
				HStack(alignment: .top) {
					Image(systemName: "exclamationmark.triangle.fill")
					Text(message).frame(maxWidth: .infinity, alignment: .leading)
					Button { onDismissError() } label: { Image(systemName: "xmark") }
						.accessibilityLabel("Dismiss")
				}
				.font(Theme.ui(12))
				.foregroundStyle(Theme.warning)
				.padding(10)
				.lhCard(radius: 10)
			}
			if nextReady && !hasText {
				Button(action: onNext) {
					Label("Next problem", systemImage: "arrow.right")
						.font(Theme.ui(13, weight: .medium))
						.frame(maxWidth: .infinity)
						.padding(.vertical, 8)
				}
				.foregroundStyle(Theme.foreground)
				.lhCard(radius: 10)
			}
			HStack(alignment: .bottom, spacing: 4) {
				DictationButton(text: $text, dictation: dictation)
				TextField(
					"",
					text: $text,
					prompt: Text(nextReady ? "Ask anything, or tap Next problem." : "Ask, answer, or steer the lesson…").foregroundStyle(Theme.muted),
					axis: .vertical
				)
				.font(Theme.ui(15))
				.foregroundStyle(Theme.foreground)
				.lineLimit(1...6)
				.focused($focused)
				.padding(.vertical, 9)
				trailingButton
			}
			.padding(.horizontal, 6)
			.padding(.vertical, 2)
			.lhCard(radius: 18)
		}
		.padding(.horizontal, 12)
		.padding(.top, 8)
		.padding(.bottom, 8)
		.background(Theme.background)
	}

	@ViewBuilder
	private var trailingButton: some View {
		if busy && !hasText {
			Button(action: onStop) {
				Image(systemName: "stop.fill")
					.font(.system(size: 12, weight: .bold))
					.foregroundStyle(Theme.background)
					.frame(width: 30, height: 30)
					.background(Theme.foreground, in: Circle())
			}
			.padding(.bottom, 3)
			.accessibilityLabel("Stop")
		} else {
			Button {
				dictation.stop()
				onSend()
			} label: {
				Group {
					if sending {
						ProgressView().tint(Theme.background)
					} else {
						Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
					}
				}
				.foregroundStyle(Theme.background)
				.frame(width: 30, height: 30)
				.background(hasText && canSend ? Theme.foreground : Theme.raised, in: Circle())
			}
			.padding(.bottom, 3)
			.disabled(!hasText || !canSend || sending)
			.accessibilityLabel(busy ? "Steer" : "Send")
		}
	}
}

/// The session's model and thinking level — the desktop stats bar's model
/// control. Changes apply from the session's next turn.
struct ModelPickerView: View {
	let chatId: String
	let current: ChatSettings?

	@Environment(AppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var models: [CatalogModel] = []
	@State private var selected: ModelRef?
	@State private var level: String?
	@State private var search = ""
	@State private var loading = true
	@State private var error: String?
	@State private var saving = false

	private var selectedModel: CatalogModel? { models.first { $0.ref == selected } }

	private var groups: [(provider: String, models: [CatalogModel])] {
		let query = search.trimmingCharacters(in: .whitespaces)
		let shown = models.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.id.localizedCaseInsensitiveContains(query) }
		return Dictionary(grouping: shown, by: \.provider).map { ($0.key, $0.value.sorted { $0.name < $1.name }) }.sorted { $0.provider < $1.provider }
	}

	var body: some View {
		NavigationStack {
			List {
				if let error {
					Text(error).font(Theme.ui(12)).foregroundStyle(Theme.destructive).listRowBackground(Theme.background)
				}
				if let selectedModel, !selectedModel.supportedLevels.isEmpty {
					Section {
						Picker("Thinking", selection: Binding(get: { level ?? selectedModel.supportedLevels.first! }, set: { level = $0 })) {
							ForEach(selectedModel.supportedLevels, id: \.self) { Text($0.capitalized).tag($0) }
						}
						.pickerStyle(.menu)
						.font(Theme.ui(14))
						.listRowBackground(Theme.card)
					} header: {
						Text("THINKING").font(Theme.label()).foregroundStyle(Theme.muted)
					}
				}
				ForEach(groups, id: \.provider) { group in
					Section {
						ForEach(group.models) { item in
							Button {
								selected = item.ref
								if let level, !item.supportedLevels.contains(level) { self.level = item.supportedLevels.first }
							} label: {
								HStack {
									VStack(alignment: .leading, spacing: 2) {
										Text(item.name).font(Theme.ui(14)).foregroundStyle(Theme.foreground)
										Text(item.id).font(Theme.ui(11)).foregroundStyle(Theme.muted)
									}
									Spacer()
									if item.ref == selected { Image(systemName: "checkmark").foregroundStyle(Theme.foreground) }
								}
							}
							.listRowBackground(Theme.background)
						}
					} header: {
						Text(group.provider.uppercased()).font(Theme.label()).foregroundStyle(Theme.muted)
					}
				}
			}
			.listStyle(.insetGrouped)
			.lhList()
			.overlay { if loading { ProgressView() } }
			.searchable(text: $search, prompt: "Search models")
			.navigationTitle("Model & Thinking")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					if saving { ProgressView() } else { Button("Done", action: save).bold().disabled(selected == nil) }
				}
			}
			.task {
				selected = current?.model
				level = current?.thinkingLevel
				do { models = try await model.api.models() } catch { self.error = error.localizedDescription }
				loading = false
			}
		}
	}

	private func save() {
		guard let selected else { return }
		saving = true
		Task {
			defer { saving = false }
			do {
				let saved = try await model.api.setSettings(ChatSettings(model: selected, thinkingLevel: level), for: chatId)
				model.updateSettings(saved, for: chatId)
				dismiss()
			} catch {
				self.error = error.localizedDescription
			}
		}
	}
}
