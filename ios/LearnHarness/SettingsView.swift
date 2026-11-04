import SwiftUI

/// The app's settings: this phone's connection natively, and the server's
/// own settings sections (models, keys, appearance…) opened one at a time.
struct SettingsView: View {
	@Environment(AppModel.self) private var model
	@Environment(ServerStore.self) private var store
	@State private var showingConnect = false
	@State private var confirmingSignOut = false

	/// The server's settings sections (components/settings/settings-dialog.tsx).
	private static let sections: [(id: String, title: String, icon: String, color: Color)] = [
		("agent", "Models & Agent", "cpu", .purple),
		("keys", "Providers & API Keys", "key.fill", .orange),
		("graph", "Knowledge Graph", "point.3.connected.trianglepath.dotted", .teal),
		("appearance", "Appearance", "textformat.size", .blue),
		("general", "General", "slider.horizontal.3", .gray),
	]

	var body: some View {
		NavigationStack {
			List {
				Section {
					HStack(spacing: 12) {
						Image(systemName: "server.rack")
							.foregroundStyle(.white)
							.frame(width: 30, height: 30)
							.background(Theme.raised, in: RoundedRectangle(cornerRadius: 7))
						VStack(alignment: .leading) {
							Text(model.server.host() ?? model.server.absoluteString).font(.body.weight(.medium))
							Text(model.server.absoluteString).font(.caption.monospaced()).foregroundStyle(.secondary)
						}
						Spacer()
						Label(model.live ? "Live" : "Reconnecting", systemImage: "circle.fill")
							.labelStyle(.titleAndIcon)
							.font(.caption)
							.foregroundStyle(model.live ? Theme.foreground : Theme.warning)
					}
					NavigationLink {
						ConnectionTestView()
					} label: {
						row("Test Connection", "stethoscope", .green)
					}
				} header: {
					Text("Server")
				}

				Section {
					ForEach(Self.sections, id: \.id) { section in
						NavigationLink {
							ServerSettingsScreen(section: section.id, title: section.title)
						} label: {
							row(section.title, section.icon, section.color)
						}
					}
				} header: {
					Text("Learning")
				} footer: {
					Text("Stored on your server, so they apply on every device.")
				}

				Section {
					Button("Change Server…") { showingConnect = true }
					Button("Sign Out", role: .destructive) { confirmingSignOut = true }
				} footer: {
					Text("LearnHarness \(Bundle.main.appVersion). Signing out affects this phone only.")
				}
			}
			.lhList()
			.background(Color.appBackground)
			.navigationTitle("Settings")
			.navigationBarTitleDisplayMode(.inline)
		}
		.sheet(isPresented: $showingConnect) { ConnectView(isSheet: true) }
		.confirmationDialog("Sign out of \(model.server.host() ?? "the server")?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
			Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
		}
	}

	private func row(_ title: String, _ icon: String, _ color: Color) -> some View {
		Label {
			Text(title)
		} icon: {
			Image(systemName: icon)
				.font(.system(size: 14, weight: .semibold))
				.foregroundStyle(.white)
				.frame(width: 30, height: 30)
				.background(Theme.raised, in: RoundedRectangle(cornerRadius: 7))
		}
	}
}

/// One section of the server's settings dialog, full screen. Closing the
/// dialog inside the page goes back.
struct ServerSettingsScreen: View {
	let section: String
	let title: String

	@Environment(AppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var page: WebPage?

	var body: some View {
		Group {
			if let page { WebPageView(page: page) } else { Color.appBackground }
		}
		.ignoresSafeArea(.container, edges: .bottom)
		.navigationTitle(title)
		.navigationBarTitleDisplayMode(.inline)
		.toolbarBackground(Color.appBackground, for: .navigationBar)
		.toolbar(.hidden, for: .tabBar)
		.onAppear {
			guard page == nil else { return }
			// The lightest page that hosts the dialog; it opens on load.
			let page = WebPage(server: model.server, path: "/chat/new", startupScript: "window.lhNativePendingSettings = \(Self.jsString(section));")
			page.onMessage = { message in
				if message["type"] as? String == "settingsClosed" { dismiss() }
			}
			// Settings never navigate on their own; anything else is a link out of them.
			page.onRoute = { _ in
				dismiss()
				return true
			}
			self.page = page
		}
	}

	static func jsString(_ value: String) -> String {
		let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[\"\"]".utf8)
		return String(decoding: data, as: UTF8.self).dropFirst().dropLast().description
	}
}
