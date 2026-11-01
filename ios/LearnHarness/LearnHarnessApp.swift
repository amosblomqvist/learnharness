import SwiftUI

@main
struct LearnHarnessApp: App {
	@State private var store = ServerStore()

	init() {
		Theme.applyAppearance()
	}

	var body: some Scene {
		WindowGroup {
			Group {
				if let server = store.server {
					RootView(server: server).id(server)
				} else {
					ConnectView()
				}
			}
			.environment(store)
			.preferredColorScheme(.dark)
			.tint(Theme.foreground)
			.fontDesign(.monospaced)
		}
	}
}


/// Where a connected phone is: checking the saved sign-in, signing in, or
/// using the app.
struct RootView: View {
	@Environment(ServerStore.self) private var store
	@State private var model: AppModel
	@State private var showingConnect = false

	init(server: URL) {
		_model = State(initialValue: AppModel(server: server))
	}

	var body: some View {
		Group {
			switch model.access {
			case .checking:
				ProgressView("Connecting…")
					.frame(maxWidth: .infinity, maxHeight: .infinity)
					.background(Color.appBackground)
			case .signedOut:
				SignInView()
			case .unreachable(let message):
				unreachable(message)
			case .signedIn:
				MainTabs()
			}
		}
		.environment(model)
		.task { await model.start() }
		.sheet(isPresented: $showingConnect) { ConnectView(isSheet: true) }
	}

	private func unreachable(_ message: String) -> some View {
		NavigationStack {
			ContentUnavailableView {
				Label("Can't reach your server", systemImage: "wifi.exclamationmark")
			} description: {
				Text(message)
			} actions: {
				Button("Try Again") { Task { await model.refresh() } }
					.buttonStyle(.borderedProminent)
				Button("Change Server…") { showingConnect = true }
				NavigationLink("Run Connection Test") { ConnectionTestView() }
			}
			.background(Color.appBackground)
		}
	}
}

/// Which tab is showing and the Sessions tab's navigation stack, shared so
/// any screen (the graph, a new-session sheet) can open a session.
@MainActor
@Observable
final class Router {
	enum Tab: Hashable { case sessions, graph, settings }

	var tab: Tab = .sessions
	var sessionsPath: [String] = []

	func open(chat id: String) {
		tab = .sessions
		if sessionsPath.last != id { sessionsPath = [id] }
	}
}

struct MainTabs: View {
	@State private var router = Router()

	var body: some View {
		TabView(selection: $router.tab) {
			SessionsView()
				.tabItem { Label("Sessions", systemImage: "bubble.left.and.text.bubble.right") }
				.tag(Router.Tab.sessions)
			GraphScreen()
				.tabItem { Label("Graph", systemImage: "point.3.connected.trianglepath.dotted") }
				.tag(Router.Tab.graph)
			SettingsView()
				.tabItem { Label("Settings", systemImage: "gearshape") }
				.tag(Router.Tab.settings)
		}
		.environment(router)
	}
}
