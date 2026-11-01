import SwiftUI

/// First screen (and "Change Server…"): enter the address of a self-hosted
/// LearnHarness server. The address is checked before it is saved.
struct ConnectView: View {
	@Environment(ServerStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	/// Shown as a sheet from the server screen (with Cancel) or as the root.
	var isSheet = false

	@State private var address = ""
	@State private var status: Status?
	@State private var checking = false
	/// An insecure-address warning is confirmed by pressing Connect again on the same address.
	@State private var warnedFor: String?

	enum Status {
		case error(String), warning(String)
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 16) {
					Text("Use your self-hosted LearnHarness server. Your sessions, knowledge graph and settings stay on the server and sync with your other devices.")
						.foregroundStyle(.secondary)

					TextField("my-server.lan:3000", text: $address)
						.textContentType(.URL)
						.keyboardType(.URL)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.submitLabel(.go)
						.onSubmit(connect)
						.padding(12)
						.background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
						.overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.12)))

					switch status {
					case .error(let message):
						Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
					case .warning(let message):
						Label(message, systemImage: "lock.open").foregroundStyle(.orange)
					case nil:
						EmptyView()
					}

					Button(action: connect) {
						HStack {
							if checking { ProgressView().tint(.black) }
							Text(checking ? "Checking…" : "Connect").fontWeight(.semibold)
						}
						.frame(maxWidth: .infinity)
						.padding(.vertical, 12)
					}
					.buttonStyle(.borderedProminent)
					.tint(.white)
					.foregroundStyle(.black)
					.disabled(checking || address.trimmingCharacters(in: .whitespaces).isEmpty)

					Text("Tip: on the go, install Tailscale on this phone and the server, then use the server's Tailscale name.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
				.padding(20)
			}
			.background(Color.appBackground)
			.navigationTitle("Connect to Server")
			.toolbar {
				if isSheet {
					ToolbarItem(placement: .cancellationAction) {
						Button("Cancel") { dismiss() }
					}
				}
			}
		}
		.onAppear {
			if address.isEmpty, let server = store.server { address = server.absoluteString }
		}
	}

	private func connect() {
		guard !checking else { return }
		let typed = address
		let url: URL
		switch ServerAddress.normalize(typed) {
		case .failure(let problem):
			status = .error(problem.message)
			return
		case .success(let normalized):
			url = normalized
		}
		checking = true
		status = nil
		Task {
			let problem = await ServerAddress.probe(url)
			checking = false
			if let problem {
				status = .error(problem)
				warnedFor = nil
				return
			}
			if ServerAddress.isInsecure(url), warnedFor != typed {
				warnedFor = typed
				status = .warning("This address uses plain http:// over the internet, so your password would travel unencrypted. Use https:// or Tailscale, or tap Connect again to use it anyway.")
				return
			}
			store.connect(to: url)
			if isSheet { dismiss() }
		}
	}
}
