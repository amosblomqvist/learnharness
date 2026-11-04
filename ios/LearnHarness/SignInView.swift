import SwiftUI

/// The server's password, asked natively. One sign-in lasts 30 days and
/// covers the web pages too (CookieBridge).
struct SignInView: View {
	@Environment(AppModel.self) private var model
	@Environment(ServerStore.self) private var store

	@State private var password = ""
	@State private var working = false
	@State private var message: String?
	@State private var showingConnect = false
	@FocusState private var focused: Bool

	var body: some View {
		NavigationStack {
			Form {
				Section {
					VStack(spacing: 10) {
						Image(systemName: "graduationcap.fill")
							.font(.system(size: 44))
							.foregroundStyle(Theme.foreground)
						Text("Sign in to LearnHarness").font(.title2.bold())
						Text(model.server.host() ?? model.server.absoluteString)
							.font(.subheadline.monospaced())
							.foregroundStyle(.secondary)
					}
					.frame(maxWidth: .infinity)
					.padding(.vertical, 8)
					.listRowBackground(Color.clear)
				}

				Section {
					SecureField("Server password", text: $password)
						.textContentType(.password)
						.submitLabel(.go)
						.focused($focused)
						.onSubmit(signIn)
				} footer: {
					if let message {
						Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red)
					} else {
						Text("The password set on the server (LH_SERVER_PASSWORD).")
					}
				}

				Section {
					Button(action: signIn) {
						HStack {
							Spacer()
							if working { ProgressView() } else { Text("Sign In").bold() }
							Spacer()
						}
					}
					.disabled(working || password.isEmpty)
				}

				Section {
					NavigationLink("Test Connection") { ConnectionTestView() }
					Button("Use a Different Server…") { showingConnect = true }
				}
			}
			.lhList()
			.background(Color.appBackground)
			.navigationBarTitleDisplayMode(.inline)
			.onAppear { focused = true }
			.sheet(isPresented: $showingConnect) { ConnectView(isSheet: true) }
		}
	}

	private func signIn() {
		guard !working, !password.isEmpty else { return }
		working = true
		message = nil
		Task {
			defer { working = false }
			do {
				switch try await model.signIn(password: password) {
				case .signedIn: password = ""
				case .wrongPassword: message = "Wrong password."
				case .throttled: message = "Too many attempts. Try again in 15 minutes."
				}
			} catch {
				message = error.localizedDescription
			}
		}
	}
}
