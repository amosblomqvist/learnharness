import XCTest
@testable import LearnHarness

/// Phone access pairing: the QR link, pins and stored pairing.
final class PairingTests: XCTestCase {
	private let fingerprint = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"

	func testPairingLinkParsesTheDesktopQRCode() throws {
		let text = "learnharness://pair?v=1&h=192.168.1.88,100.101.1.2&p=4399&f=\(fingerprint)&c=Ab-_0123456789xyzABC&n=Ana%E2%80%99s%20Mac"
		let link = try XCTUnwrap(PairingLink(string: text))
		XCTAssertEqual(link.hosts, ["192.168.1.88", "100.101.1.2"])
		XCTAssertEqual(link.port, 4399)
		XCTAssertEqual(link.fingerprint, fingerprint)
		XCTAssertEqual(link.code, "Ab-_0123456789xyzABC")
		XCTAssertEqual(link.name, "Ana’s Mac")
	}

	func testPairingLinkRejectsAnythingElse() {
		let good = "learnharness://pair?v=1&h=192.168.1.88&p=4399&f=\(fingerprint)&c=Ab-_0123456789xyzABC"
		XCTAssertNotNil(PairingLink(string: good))
		for bad in [
			good.replacingOccurrences(of: "learnharness://", with: "https://"),
			good.replacingOccurrences(of: "v=1", with: "v=2"),
			good.replacingOccurrences(of: "p=4399", with: "p=70000"),
			good.replacingOccurrences(of: fingerprint, with: String(fingerprint.dropLast())),
			good.replacingOccurrences(of: "c=Ab-_0123456789xyzABC", with: "c=short"),
			good.replacingOccurrences(of: "h=192.168.1.88", with: "h="),
			good.replacingOccurrences(of: "h=192.168.1.88", with: "h=evil.com%2F@x"),
			"learnharness://other?v=1",
		] {
			XCTAssertNil(PairingLink(string: bad), bad)
		}
		// Unsafe host entries are dropped, safe ones kept.
		let mixed = good.replacingOccurrences(of: "h=192.168.1.88", with: "h=a%2Fb,192.168.1.88")
		XCTAssertEqual(PairingLink(string: mixed)?.hosts, ["192.168.1.88"])
	}

	func testPairingURLAndPins() {
		let pairing = Pairing(name: "Mac", fingerprint: fingerprint, hosts: ["192.168.1.88", "10.0.0.2"], port: 4399, deviceId: "d1")
		XCTAssertEqual(pairing.url.absoluteString, "https://192.168.1.88:4399")
		let trust = PinnedTrust()
		trust.pin(hosts: pairing.hosts, port: pairing.port, fingerprint: fingerprint.uppercased())
		XCTAssertEqual(trust.pinned(host: "192.168.1.88", port: 4399), fingerprint)
		XCTAssertEqual(trust.pinned(host: "10.0.0.2", port: 4399), fingerprint)
		XCTAssertNil(trust.pinned(host: "192.168.1.88", port: 443), "pins are per port")
		XCTAssertNil(trust.pinned(host: "example.com", port: 4399))
	}

	func testDeviceCookieIsSecureHostOnlyAndHttpOnly() throws {
		let cookie = try XCTUnwrap(DeviceCookie.cookies(token: "t0k3n", hosts: ["192.168.1.88"]).first)
		XCTAssertEqual(cookie.name, "lh_device")
		XCTAssertEqual(cookie.value, "t0k3n")
		XCTAssertEqual(cookie.domain, "192.168.1.88")
		XCTAssertTrue(cookie.isSecure)
		XCTAssertTrue(cookie.isHTTPOnly)
		XCTAssertEqual(cookie.sameSitePolicy, .sameSiteStrict)
	}
}
