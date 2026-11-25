import SwiftUI
import UIKit
import VisionKit

/// Live camera QR scanning (VisionKit). Hands back the first LearnHarness
/// pairing link it sees; other codes are ignored.
struct QRScannerSheet: View {
	let onLink: (PairingLink) -> Void
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			Scanner(onLink: onLink)
				.ignoresSafeArea(edges: .bottom)
				.navigationTitle("Scan the QR Code")
				.navigationBarTitleDisplayMode(.inline)
				.toolbar {
					ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				}
				.safeAreaInset(edge: .bottom) {
					Text("Point the camera at the code in LearnHarness → Settings → Phone access on your computer.")
						.font(.footnote)
						.foregroundStyle(.secondary)
						.padding()
						.frame(maxWidth: .infinity)
						.background(.ultraThinMaterial)
				}
		}
	}

	private struct Scanner: UIViewControllerRepresentable {
		let onLink: (PairingLink) -> Void

		func makeUIViewController(context: Context) -> DataScannerViewController {
			let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
			scanner.delegate = context.coordinator
			try? scanner.startScanning()
			return scanner
		}

		func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

		static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
			scanner.stopScanning()
		}

		func makeCoordinator() -> Coordinator { Coordinator(onLink: onLink) }

		final class Coordinator: NSObject, DataScannerViewControllerDelegate {
			let onLink: (PairingLink) -> Void
			private var done = false
			init(onLink: @escaping (PairingLink) -> Void) { self.onLink = onLink }

			func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
				guard !done else { return }
				for item in items {
					if case let .barcode(code) = item, let text = code.payloadStringValue, let link = PairingLink(string: text) {
						done = true
						onLink(link)
						return
					}
				}
			}
		}
	}
}

/// The device name the computer shows in its list of paired phones.
@MainActor
func pairingDeviceName() -> String {
	let name = UIDevice.current.name
	return name.isEmpty ? UIDevice.current.model : name
}

/// Pairing from a QR code or a learnharness://pair link (system Camera).
struct LinkPairingView: View {
	let link: PairingLink
	var onPaired: () -> Void = {}

	@Environment(ServerStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var problem: String?

	var body: some View {
		NavigationStack {
			VStack(spacing: 20) {
				if let problem {
					ContentUnavailableView {
						Label("Couldn't pair", systemImage: "exclamationmark.triangle")
					} description: {
						Text(problem)
					} actions: {
						Button("Close") { dismiss() }.buttonStyle(.borderedProminent)
					}
				} else {
					ProgressView()
					Text("Pairing with \(link.name)…").foregroundStyle(.secondary)
				}
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.background(Color.appBackground)
			.navigationTitle("Pair")
			.navigationBarTitleDisplayMode(.inline)
		}
		.interactiveDismissDisabled(problem == nil)
		.task {
			do {
				let (pairing, token) = try await PairingClient.pair(with: link, deviceName: pairingDeviceName())
				try await store.adopt(pairing, token: token)
				dismiss()
				onPaired()
			} catch {
				problem = error.localizedDescription
			}
		}
	}
}

/// Pairing with a computer found nearby: the computer asks its user to allow
/// this phone; both show the same pairing key so an impostor stands out.
struct NearbyPairingView: View {
	let computer: NearbyBrowser.Computer
	var onPaired: () -> Void = {}

	@Environment(ServerStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var pending: NearbyRequest?
	@State private var problem: String?

	var body: some View {
		NavigationStack {
			VStack(spacing: 18) {
				if let problem {
					ContentUnavailableView {
						Label("Couldn't pair", systemImage: "exclamationmark.triangle")
					} description: {
						Text(problem)
					} actions: {
						Button("Close") { dismiss() }.buttonStyle(.borderedProminent)
					}
				} else if let pending {
					Image(systemName: "desktopcomputer").font(.system(size: 44))
					Text("Allow this iPhone on \(pending.name)").font(.title3.weight(.semibold)).multilineTextAlignment(.center)
					Text("Your computer is asking whether to allow \"\(pairingDeviceName())\". Allow it only if it shows this key:")
						.multilineTextAlignment(.center)
						.foregroundStyle(.secondary)
					Text(pending.key)
						.font(.system(.title, design: .monospaced).weight(.semibold))
						.textSelection(.enabled)
						.padding(.vertical, 10)
						.padding(.horizontal, 16)
						.background(Theme.raised, in: RoundedRectangle(cornerRadius: 10))
						.accessibilityLabel("Pairing key \(pending.key.map { String($0) }.joined(separator: " "))")
					HStack(spacing: 8) {
						ProgressView()
						Text("Waiting for the computer…").foregroundStyle(.secondary)
					}
					Text("If the keys differ, choose Don't Allow on the computer: something else on this network is pretending to be it.")
						.font(.footnote)
						.multilineTextAlignment(.center)
						.foregroundStyle(.secondary)
				} else {
					ProgressView()
					Text("Contacting \(computer.name)…").foregroundStyle(.secondary)
				}
			}
			.padding(24)
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.background(Color.appBackground)
			.navigationTitle("Pair")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
			}
		}
		.task { await run() }
	}

	private func run() async {
		do {
			let (host, port) = try await NearbyBrowser.resolve(computer.endpoint)
			let request = try await PairingClient.request(host: host, port: port, deviceName: pairingDeviceName())
			pending = request
			while !Task.isCancelled {
				try await Task.sleep(for: .milliseconds(1500))
				if case let .approved(pairing, token) = try await PairingClient.poll(request) {
					try await store.adopt(pairing, token: token)
					dismiss()
					onPaired()
					return
				}
			}
		} catch is CancellationError {
			return
		} catch {
			problem = error.localizedDescription
		}
	}
}
