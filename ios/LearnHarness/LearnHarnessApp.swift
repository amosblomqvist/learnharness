import SwiftUI

@main
struct LearnHarnessApp: App {
	@State private var store = ServerStore()
	/// A learnharness://pair link opened from the Camera app or a QR scan.
	@State private var openedLink: PairingLink?

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
			.onOpenURL { url in openedLink = PairingLink(url: url) }
			.sheet(item: $openedLink) { link in
				LinkPairingView(link: link).environment(store)
			}
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
	@State private var relocating = false

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
				if let pairing = store.pairing { unpaired(pairing) } else { SignInView() }
			case .unreachable(let message):
				unreachable(message)
			case .signedIn:
				MainTabs()
			}
		}
		.environment(model)
		.task { await model.start() }
		.task(id: model.access) {
			// A paired computer that moved to another address: find it again
			// over Bonjour by its certificate and reconnect there.
			guard case .unreachable = model.access, let pairing = store.pairing, !relocating else { return }
			relocating = true
			defer { relocating = false }
			let nearby = NearbyBrowser()
			defer { nearby.stop() }
			guard let computer = await nearby.find(fingerprint: pairing.fingerprint),
			      let found = try? await NearbyBrowser.resolve(computer.endpoint),
			      found.host != pairing.hosts.first || found.port != pairing.port else { return }
			await store.relocate(to: found.host, port: found.port)
		}
		.sheet(isPresented: $showingConnect) { ConnectView(isSheet: true) }
	}

	/// The computer revoked this phone (Settings → Phone access → Revoke).
	private func unpaired(_ pairing: Pairing) -> some View {
		ContentUnavailableView {
			Label("This iPhone was removed", systemImage: "iphone.slash")
		} description: {
			Text("\(pairing.name) no longer lets this iPhone in. Pair again from Settings → Phone access on the computer.")
		} actions: {
			Button("Pair Again") { Task { await store.forgetPairing() } }
				.buttonStyle(.borderedProminent)
		}
		.background(Color.appBackground)
	}

	private func unreachable(_ message: String) -> some View {
		NavigationStack {
			ContentUnavailableView {
				Label(store.pairing.map { "Can't reach \($0.name)" } ?? "Can't reach your server", systemImage: "wifi.exclamationmark")
			} description: {
				Text(store.pairing == nil ? message : "\(message)\n\nKeep LearnHarness open on the computer with Phone access on, and this iPhone on the same Wi-Fi.")
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
