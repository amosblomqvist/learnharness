import SwiftUI

/// The desktop sidebar as a phone screen: every session newest first, the
/// All / Teaching / Practice filter, search, and the running background
/// work — live-updated from the server's events.
struct SessionsView: View {
	@Environment(AppModel.self) private var model
	@Environment(Router.self) private var router

	enum Filter: String, CaseIterable { case all = "All", teach = "Teaching", practice = "Practice" }

	@State private var search = ""
	@State private var filter = Filter.all
	@State private var showingNew = false
	@State private var newPractice = false
	@State private var renaming: ChatSummary?
	@State private var newTitle = ""
	@State private var deleting: ChatSummary?
	@State private var actionError: String?

	var body: some View {
		@Bindable var router = router
		NavigationStack(path: $router.sessionsPath) {
			list
				.navigationTitle("Sessions")
				.navigationBarTitleDisplayMode(.inline)
				.searchable(text: $search, prompt: "Search sessions")
				.toolbar {
					ToolbarItem(placement: .topBarTrailing) {
						Menu {
							Button("New Session", systemImage: "book") { startNew(practice: false) }
							Button("New Practice Session", systemImage: "dumbbell") { startNew(practice: true) }
						} label: {
							Image(systemName: "square.and.pencil")
						} primaryAction: {
							startNew(practice: false)
						}
						.accessibilityLabel("New Session")
					}
					ToolbarItem(placement: .topBarLeading) {
						if !model.live {
							Image(systemName: "bolt.horizontal.circle")
								.foregroundStyle(Theme.warning)
								.accessibilityLabel("Live updates reconnecting")
						}
					}
				}
				.navigationDestination(for: String.self) { id in
					ChatScreen(chatId: id)
				}
		}
		.sheet(isPresented: $showingNew) {
			NewSessionView(practice: newPractice) { id in router.open(chat: id) }
		}
		.alert("Rename Session", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
			TextField("Name", text: $newTitle)
			Button("Cancel", role: .cancel) {}
			Button("Rename") {
				guard let chat = renaming else { return }
				perform { try await model.rename(chat, to: newTitle) }
			}
		}
		.confirmationDialog(
			"Delete “\(deleting?.title ?? "")”?",
			isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
			titleVisibility: .visible,
			presenting: deleting
		) { chat in
			Button("Delete Session", role: .destructive) {
				perform { try await model.delete(chat, keepGraph: true) }
			}
			Button("Delete and Remove Its Graph Traces", role: .destructive) {
				perform { try await model.delete(chat, keepGraph: false) }
			}
		} message: { _ in
			Text("Deleting keeps what this session added to your knowledge graph. Removing its graph traces also takes out its topics, links and events; topics other sessions or imported notes cover survive.")
		}
		.alert("Couldn't Do That", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(actionError ?? "")
		}
	}

	private var filtered: [ChatSummary] {
		let query = search.trimmingCharacters(in: .whitespaces)
		return model.chats.filter { chat in
			switch filter {
			case .all: break
			case .teach: if chat.isPractice { return false }
			case .practice: if !chat.isPractice { return false }
			}
			return query.isEmpty || chat.title.localizedCaseInsensitiveContains(query)
		}
	}

	@ViewBuilder
	private var list: some View {
		if model.chats.isEmpty && !model.isLoadingList {
			ContentUnavailableView {
				Label("No sessions yet", systemImage: "bubble.left.and.text.bubble.right")
			} description: {
				Text("Start a session on anything you want to learn, or a practice session to work problems.")
			} actions: {
				Button("New Session") { startNew(practice: false) }
					.buttonStyle(.borderedProminent)
					.foregroundStyle(Theme.background)
			}
			.background(Theme.background)
			.refreshable { await model.refresh() }
		} else {
			List {
				Section {
					Picker("Show", selection: $filter) {
						ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
					}
					.pickerStyle(.segmented)
					.listRowBackground(Theme.background)
					.listRowSeparator(.hidden)
				}
				if let error = model.listError {
					Label(error, systemImage: "exclamationmark.triangle.fill")
						.font(Theme.ui(12))
						.foregroundStyle(Theme.warning)
						.listRowBackground(Theme.background)
				}
				Section {
					ForEach(filtered) { chat in
						NavigationLink(value: chat.id) { SessionRow(chat: chat) }
							.listRowBackground(Theme.background)
							.swipeActions(edge: .trailing) {
								Button("Delete", systemImage: "trash") { deleting = chat }.tint(Theme.destructive)
								Button("Rename", systemImage: "pencil") { beginRename(chat) }.tint(Theme.raised)
							}
							.contextMenu {
								Button("Rename", systemImage: "pencil") { beginRename(chat) }
								Button("Delete", systemImage: "trash", role: .destructive) { deleting = chat }
							}
					}
				}
				BackgroundSection(onOpen: { router.open(chat: $0) }, onError: { actionError = $0 })
			}
			.listStyle(.plain)
			.lhList()
			.refreshable {
				await model.refresh()
				model.scheduleActivityRefresh()
			}
			.overlay {
				if !search.isEmpty && filtered.isEmpty { ContentUnavailableView.search(text: search) }
			}
		}
	}

	private func startNew(practice: Bool) {
		newPractice = practice
		showingNew = true
	}

	private func beginRename(_ chat: ChatSummary) {
		newTitle = chat.title
		renaming = chat
	}

	private func perform(_ action: @escaping () async throws -> Void) {
		Task {
			do { try await action() } catch { actionError = error.localizedDescription }
		}
	}
}

/// One session, styled like the desktop sidebar row.
struct SessionRow: View {
	let chat: ChatSummary

	var body: some View {
		HStack(alignment: .top, spacing: 10) {
			VStack(alignment: .leading, spacing: 4) {
				HStack(spacing: 6) {
					if chat.isPractice {
						Image(systemName: "dumbbell.fill")
							.font(.system(size: 11))
							.foregroundStyle(Theme.muted)
							.accessibilityLabel("Practice session")
					}
					Text(chat.title)
						.font(Theme.ui(14, weight: .medium))
						.foregroundStyle(Theme.foreground)
						.lineLimit(2)
				}
				HStack(spacing: 8) {
					status
					Text(chat.updatedAt, format: .relative(presentation: .named))
						.foregroundStyle(Theme.muted.opacity(0.7))
				}
				.font(Theme.ui(11))
			}
			Spacer(minLength: 0)
			if chat.busy {
				ProgressView().controlSize(.small).tint(Theme.muted)
			}
		}
		.padding(.vertical, 4)
	}

	@ViewBuilder
	private var status: some View {
		if chat.busy {
			Text("Thinking…").foregroundStyle(Theme.foreground)
		} else if chat.pendingQuestion {
			Text("Question waiting").foregroundStyle(Theme.warning)
		} else if chat.pendingProblem == true {
			Text("Problem waiting").foregroundStyle(Theme.warning)
		} else {
			Text(chat.phaseLabel.uppercased()).foregroundStyle(Theme.muted)
		}
	}
}

/// Running sub-agents (research, demos, visuals) and graph extractions,
/// each with Stop — the desktop sidebar's Background section.
struct BackgroundSection: View {
	@Environment(AppModel.self) private var model
	let onOpen: (String) -> Void
	let onError: (String) -> Void

	var body: some View {
		if !model.activity.jobs.isEmpty || !model.activity.extractions.isEmpty {
			Section {
				ForEach(model.activity.jobs) { job in
					row(
						icon: icon(for: job.kind),
						title: "\(job.kind.capitalized) · \(job.title)",
						detail: job.activity.isEmpty ? job.status : job.activity,
						cost: job.costUsd
					) { onOpen(job.chatId) } stop: { stop("job", job.id) }
				}
				ForEach(model.activity.extractions) { run in
					row(icon: "point.3.connected.trianglepath.dotted", title: "Adding to graph · \(run.title)", detail: run.phase, cost: nil) {
						if model.chat(run.chatId) != nil { onOpen(run.chatId) }
					} stop: { stop("extraction", run.chatId) }
				}
			} header: {
				Text("BACKGROUND").font(Theme.label()).foregroundStyle(Theme.muted)
			}
		}
	}

	private func row(icon: String, title: String, detail: String, cost: Double?, open: @escaping () -> Void, stop: @escaping () -> Void) -> some View {
		Button(action: open) {
			HStack(spacing: 10) {
				ProgressView().controlSize(.mini).tint(Theme.muted)
				Image(systemName: icon).foregroundStyle(Theme.muted).frame(width: 18)
				VStack(alignment: .leading, spacing: 2) {
					Text(title).font(Theme.ui(12, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1)
					Text(detail).font(Theme.ui(11)).foregroundStyle(Theme.muted).lineLimit(1)
				}
				Spacer(minLength: 0)
				if let cost { Text(cost, format: .currency(code: "USD")).font(Theme.ui(11)).foregroundStyle(Theme.muted) }
			}
		}
		.listRowBackground(Theme.background)
		.swipeActions { Button("Stop", systemImage: "stop.fill", role: .destructive, action: stop) }
		.contextMenu { Button("Stop", systemImage: "stop.fill", role: .destructive, action: stop) }
	}

	private func icon(for kind: String) -> String {
		switch kind {
		case "research": "magnifyingglass"
		case "demo": "play.rectangle"
		case "visual": "photo"
		default: "gearshape.2"
		}
	}

	private func stop(_ kind: String, _ id: String) {
		Task {
			do { try await model.stop(kind, id: id) } catch { onError(error.localizedDescription) }
		}
	}
}
