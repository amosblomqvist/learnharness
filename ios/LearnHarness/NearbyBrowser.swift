import Foundation
import Network

/// Finds the paired computer again over Bonjour (`_learnharness._tcp`,
/// advertised by electron/phone-access-bonjour.cjs) after its address
/// changes. The TXT record's `fp` is a public fingerprint prefix; the full
/// pinned fingerprint is still checked on connect.
@MainActor
final class NearbyBrowser {
	struct Computer {
		let fingerprintPrefix: String?
		let endpoint: NWEndpoint
	}

	static let serviceType = "_learnharness._tcp"

	private var computers: [Computer] = []
	private var browser: NWBrowser?

	private func start() {
		guard browser == nil else { return }
		let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: NWParameters())
		browser.browseResultsChangedHandler = { [weak self] results, _ in
			let found = results.map { result -> Computer in
				var prefix: String?
				if case let .bonjour(record) = result.metadata { prefix = record["fp"] }
				return Computer(fingerprintPrefix: prefix, endpoint: result.endpoint)
			}
			Task { @MainActor in self?.computers = found }
		}
		self.browser = browser
		browser.start(queue: .main)
	}

	func stop() {
		browser?.cancel()
		browser = nil
	}

	/// Waits briefly for the computer whose certificate starts with `fingerprint`.
	func find(fingerprint: String, timeout: Duration = .seconds(6)) async -> Computer? {
		start()
		let prefix = String(fingerprint.prefix(16)).lowercased()
		let deadline = ContinuousClock.now + timeout
		while ContinuousClock.now < deadline {
			if let match = computers.first(where: { $0.fingerprintPrefix?.lowercased() == prefix }) { return match }
			try? await Task.sleep(for: .milliseconds(250))
		}
		return nil
	}

	/// The IPv4 address and port behind a Bonjour service.
	nonisolated static func resolve(_ endpoint: NWEndpoint, timeout: TimeInterval = 6) async throws -> (host: String, port: Int) {
		let parameters = NWParameters.tcp
		if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
		let connection = NWConnection(to: endpoint, using: parameters)
		return try await withCheckedThrowingContinuation { continuation in
			let once = Once()
			connection.stateUpdateHandler = { state in
				switch state {
				case .ready:
					if case let .hostPort(host, port) = connection.currentPath?.remoteEndpoint, case let .ipv4(address) = host {
						let text = "\(address)".split(separator: "%").first.map(String.init) ?? "\(address)"
						once.run { continuation.resume(returning: (text, Int(port.rawValue))) }
					} else {
						once.run { continuation.resume(throwing: PairingError.unreachable("Couldn't find this computer's address.")) }
					}
					connection.cancel()
				case .failed(let error):
					once.run { continuation.resume(throwing: PairingError.unreachable("Couldn't connect to the computer (\(error.localizedDescription)).")) }
					connection.cancel()
				default: break
				}
			}
			connection.start(queue: .global())
			DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
				once.run { continuation.resume(throwing: PairingError.unreachable("The computer didn't answer in time.")) }
				connection.cancel()
			}
		}
	}
}

/// Runs a closure at most once across threads (continuations must resume once).
private final class Once: @unchecked Sendable {
	private let lock = NSLock()
	private var done = false
	func run(_ body: () -> Void) {
		let first = lock.withLock { () -> Bool in if done { return false }; done = true; return true }
		if first { body() }
	}
}
