import XCTest
@testable import LearnHarness

/// Same cases as the desktop app's tests/desktop-remote-server.test.ts.
final class ServerAddressTests: XCTestCase {
	private func normalized(_ input: String) -> String? {
		if case .success(let url) = ServerAddress.normalize(input) { return url.absoluteString }
		return nil
	}

	func testTypedAddressesNormalizeToAnOrigin() {
		XCTAssertEqual(normalized("my-server.lan:3000"), "http://my-server.lan:3000")
		XCTAssertEqual(normalized("  lh.example.com/chat/abc?x=1 "), "https://lh.example.com")
		XCTAssertEqual(normalized("http://192.168.1.20:3000/"), "http://192.168.1.20:3000")
		XCTAssertEqual(normalized("HTTPS://LH.Example.com:443"), "https://lh.example.com")
		XCTAssertEqual(ServerAddress.normalize(""), .failure(.empty))
		XCTAssertEqual(ServerAddress.normalize("ftp://host"), .failure(.unsupportedScheme))
		XCTAssertEqual(ServerAddress.normalize("http://user:pw@host:3000"), .failure(.credentialsInAddress))
		XCTAssertEqual(ServerAddress.normalize("http://"), .failure(.invalid))
	}

	func testPlainHttpIsOnlyFlaggedOffPrivateNetworks() {
		for ok in ["https://lh.example.com", "http://localhost:3000", "http://127.0.0.1:3000", "http://192.168.1.20:3000",
		           "http://10.0.0.5:3000", "http://172.20.0.2:3000", "http://100.101.1.2:3000", "http://box.tail1234.ts.net:3000",
		           "http://nas.local:3000", "http://my-server.lan:3000", "http://box.home.arpa:3000", "http://my-server:3000"] {
			XCTAssertFalse(ServerAddress.isInsecure(URL(string: ok)!), ok)
		}
		for bad in ["http://lh.example.com", "http://8.8.8.8:3000", "http://172.32.0.1:3000"] {
			XCTAssertTrue(ServerAddress.isInsecure(URL(string: bad)!), bad)
		}
	}
}
