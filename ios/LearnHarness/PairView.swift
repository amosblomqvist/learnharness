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
