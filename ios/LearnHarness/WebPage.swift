import OSLog
import SwiftUI
import WebKit

private let pageLog = Logger(subsystem: "com.example.learnharness", category: "page")

/// One server page shown inside a native screen (a session's transcript, the
/// graph, settings). The app draws the chrome around it; the page reports its
/// state over the `lhNative` message handler (components/native-shell.ts).
@MainActor
@Observable
final class WebPage: NSObject {
	private(set) var loadError: String?
	private(set) var isFirstLoad = true

	let server: URL
	let path: String
	/// Messages the page posts with window.webkit.messageHandlers.lhNative.
	@ObservationIgnored var onMessage: (([String: Any]) -> Void)?
	/// The page moved to another path of the server (client-side routing
	/// included). Return true when the app took over that destination.
	@ObservationIgnored var onRoute: ((String) -> Bool)?

	@ObservationIgnored private var downloads: [ObjectIdentifier: URL] = [:]
	@ObservationIgnored private var urlObservation: NSKeyValueObservation?
	@ObservationIgnored private(set) lazy var webView: WKWebView = makeWebView()

	/// Runs before the page's own scripts on every load.
	private let startupScript: String?

	init(server: URL, path: String, startupScript: String? = nil) {
		self.server = server
		self.path = path
		self.startupScript = startupScript
	}

	var homeURL: URL { URL(string: path, relativeTo: server)!.absoluteURL }

	func load() {
		loadError = nil
		webView.load(URLRequest(url: homeURL))
	}

	func reload() {
		if webView.url == nil || loadError != nil { load() } else { webView.reload() }
	}

	/// Runs a script in the page, ignoring pages that aren't ready for it.
	func run(_ script: String) {
		webView.evaluateJavaScript(script) { _, _ in }
	}

	private func makeWebView() -> WKWebView {
		let config = WKWebViewConfiguration()
		// Persistent store: the 30-day sign-in cookie survives app restarts.
		config.websiteDataStore = .default()
		config.allowsInlineMediaPlayback = true
		config.mediaTypesRequiringUserActionForPlayback = []
		// Keep the mobile Safari tokens so the web app sees a phone; the suffix
		// identifies this app (apps-only servers refuse anything else) and
		// asks the pages to leave navigation and the composer to the app.
		config.applicationNameForUserAgent = "Mobile/15E148 \(ServerAddress.appUserAgentToken) \(ServerAddress.nativeShellToken)"
		let content = config.userContentController
		content.addUserScript(WKUserScript(source: Self.viewportScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
		if let startupScript {
			content.addUserScript(WKUserScript(source: startupScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
		}
		content.add(WeakMessageHandler(self), name: "lhNative")
		content.addUserScript(WKUserScript(source: Self.diagnosticsScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
		content.addScriptMessageHandler(NativeTransport(server: server), contentWorld: .page, name: "lhFetch")
		content.addUserScript(WKUserScript(source: Self.transportScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

		let webView = WKWebView(frame: .zero, configuration: config)
		webView.navigationDelegate = self
		webView.uiDelegate = self
		webView.isOpaque = false
		webView.backgroundColor = UIColor(Color.appBackground)
		webView.scrollView.backgroundColor = webView.backgroundColor
		// The web app is a fixed-height shell with its own scrolling panes.
		webView.scrollView.bounces = false
		webView.scrollView.contentInsetAdjustmentBehavior = .never
		#if DEBUG
		webView.isInspectable = true
		#endif
		// Next.js routes with pushState, which never reaches the navigation
		// delegate; the URL property does change, so watch that.
		urlObservation = webView.observe(\.url, options: [.new]) { [weak self] webView, _ in
			MainActor.assumeIsolated { self?.urlChanged(webView.url) }
		}
		return webView
	}

	private func urlChanged(_ url: URL?) {
		guard let url, isServerOrigin(url), url.path() != homeURL.path() else { return }
		if url.path() == "/login" { return }
		if onRoute?(url.path()) == true {
			// The app opened that destination natively; put this page back.
			if webView.canGoBack { webView.goBack() } else { load() }
		}
	}

	/// iOS zooms the page when focusing an input with text under 16px and
	/// never zooms back; pinning the maximum scale stops that jump.
	private static let viewportScript = """
	(() => {
		let meta = document.querySelector('meta[name=viewport]');
		if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; document.head.appendChild(meta); }
		meta.content = 'width=device-width, initial-scale=1, maximum-scale=1';
	})();
	"""

	/// Page errors and failed requests: kept for the Connection Test report
	/// (PageDiagnostics) and written to the system log (Console.app,
	/// subsystem com.example.learnharness).
	private static let diagnosticsScript = """
	(() => {
		const post = (text) => { try { window.webkit.messageHandlers.lhNative.postMessage({ type: "log", text: String(text).slice(0, 2000) }); } catch {} };
		const error = console.error.bind(console);
		console.error = (...args) => { post("console.error " + args.map(String).join(" ")); error(...args); };
		window.addEventListener("error", (e) => post("error " + e.message + " @" + e.filename + ":" + e.lineno));
		window.addEventListener("unhandledrejection", (e) => post("unhandledrejection " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
		const realFetch = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input.url;
			const method = (init && init.method) || "GET";
			// API writes are traced start → finish, so one that never settles
			// shows up as a start with no matching finish.
			const traced = String(url).includes("/api/") && String(method).toUpperCase() !== "GET";
			const started = Date.now();
			if (traced) post("→ " + method + " " + url);
			try {
				const res = await realFetch(input, init);
				if (!res.ok || traced) post("← " + method + " " + url + " " + res.status + " in " + (Date.now() - started) + "ms");
				return res;
			} catch (err) {
				post("fetch " + method + " " + url + " FAILED " + err);
				throw err;
			}
		};
	})();
	"""

	/// Every write the page makes to the server's API (answers, practice
	/// thinking, Next, Retry, dismissals, settings) goes over the app's own
	/// connection (NativeTransport) instead of the web view's. On iPhone the
	/// web view's POSTs to a LAN server could stall without ever arriving,
	/// leaving "Thinking…" or a dead Submit button; the app's requests get
	/// through. Reads, uploads (non-string bodies) and other sites keep the
	/// page's own fetch.
	private static let transportScript = """
	(() => {
		const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lhFetch;
		if (!handler) return;
		const pageFetch = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const request = typeof input === "string" || input instanceof URL ? null : input;
			const url = new URL(request ? request.url : String(input), location.href);
			const method = String((init && init.method) || (request && request.method) || "GET").toUpperCase();
			const body = init ? init.body : undefined;
			const native = method !== "GET" && method !== "HEAD" && url.origin === location.origin &&
				url.pathname.startsWith("/api/") && (body === undefined || body === null || typeof body === "string");
			if (!native) return pageFetch(input, init);
			try { window.webkit.messageHandlers.lhNative.postMessage({ type: "log", text: "⇢ native " + method + " " + url.pathname }); } catch {}
			const headers = {};
			new Headers((init && init.headers) || (request && request.headers) || {}).forEach((value, key) => { headers[key] = value; });
			const reply = await handler.postMessage({ path: url.pathname + url.search, method, headers, body: body ?? null });
			const empty = reply.status === 204 || reply.status === 304;
			return new Response(empty ? null : reply.body, { status: reply.status, headers: reply.contentType ? { "content-type": reply.contentType } : {} });
		};
	})();
	"""

	func isServerOrigin(_ url: URL?) -> Bool {
		guard let url else { return false }
		return url.scheme == server.scheme && url.host == server.host && url.port == server.port
	}

	fileprivate func receive(_ body: Any) {
		guard let message = body as? [String: Any] else { return }
		if message["type"] as? String == "log" {
			PageDiagnostics.record("\(path): \(message["text"] as? String ?? "")")
			return
		}
		onMessage?(message)
	}

	fileprivate func present(_ controller: UIViewController) {
		var top = webView.window?.rootViewController
		while let presented = top?.presentedViewController { top = presented }
		if let popover = controller.popoverPresentationController {
			popover.sourceView = webView
			popover.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 0, height: 0)
		}
		top?.present(controller, animated: true)
	}
}

/// Recent page errors and request failures, newest last — shown in the
/// Connection Test report so a problem on the phone can be seen.
@MainActor
enum PageDiagnostics {
	private(set) static var recent: [String] = []

	static func record(_ line: String) {
		let stamped = "\(Date().formatted(date: .omitted, time: .standard)) \(line)"
		pageLog.notice("\(stamped, privacy: .public)")
		// Also on stdout, which `devicectl device process launch --console` streams.
		print("[page] \(stamped)")
		recent.append(stamped)
		if recent.count > 40 { recent.removeFirst(recent.count - 40) }
	}
}

/// Carries the page's API writes over URLSession (shared cookies, the
/// app's User-Agent) and hands the response back to the page's fetch.
private final class NativeTransport: NSObject, WKScriptMessageHandlerWithReply {
	let api: ServerAPI
	init(server: URL) { api = ServerAPI(server: server) }

	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
		guard let call = message.body as? [String: Any], let path = call["path"] as? String, path.hasPrefix("/api/"),
		      let method = call["method"] as? String else {
			return (nil, "Bad request from the page.")
		}
		var request = api.request(path, method: method, timeout: 60)
		for (key, value) in call["headers"] as? [String: String] ?? [:] where key.lowercased() != "user-agent" {
			request.setValue(value, forHTTPHeaderField: key)
		}
		if let body = call["body"] as? String { request.httpBody = Data(body.utf8) }
		let started = Date()
		PageDiagnostics.record("native → \(method) \(path)")
		do {
			let (data, response) = try await api.raw(request)
			let status = response.statusCode
			let ms = Int(Date().timeIntervalSince(started) * 1000)
			PageDiagnostics.record("native ← \(method) \(path) \(status) in \(ms)ms \(status >= 400 ? ServerAPI.errorText(data) ?? "" : "")")
			return ([
				"status": status,
				"body": String(decoding: data, as: UTF8.self),
				"contentType": response.value(forHTTPHeaderField: "Content-Type") ?? "",
			], nil)
		} catch {
			PageDiagnostics.record("\(method) \(path) FAILED \(error.localizedDescription)")
			return (nil, error.localizedDescription)
		}
	}
}

/// WKUserContentController retains its handlers; this keeps the page releasable.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
	weak var page: WebPage?
	init(_ page: WebPage) { self.page = page }

	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
		MainActor.assumeIsolated { page?.receive(message.body) }
	}
}

// MARK: - Navigation: stay on the server, everything else opens in Safari

extension WebPage: WKNavigationDelegate {
	func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
		if action.shouldPerformDownload { return .download }
		guard action.targetFrame?.isMainFrame ?? true, let url = action.request.url else { return .allow }
		if isServerOrigin(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return .allow }
		if ["http", "https", "mailto", "tel"].contains(url.scheme ?? "") { await UIApplication.shared.open(url) }
		return .cancel
	}

	func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
		let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") ?? false
		return response.canShowMIMEType && !attachment ? .allow : .download
	}

	func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		loadError = nil
		isFirstLoad = false
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		fail(error)
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		fail(error)
	}

	private func fail(_ error: Error) {
		let error = error as NSError
		// Cancelled loads (a newer navigation replaced this one) are not failures.
		if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
		if error.domain == "WebKitErrorDomain" && error.code == 102 { return } // frame load interrupted (download handoff)
		isFirstLoad = false
		loadError = error.localizedDescription
	}

	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
		// iOS may reclaim the page's process in the background; start fresh.
		load()
	}
}

// MARK: - Browser features the page relies on

extension WebPage: WKUIDelegate {
	/// window.open / target=_blank: pages stay in place, other sites go to Safari.
	func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
		if let url = action.request.url {
			if isServerOrigin(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
		}
		return nil
	}

	func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
		await withCheckedContinuation { done in
			let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
			alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume() })
			present(alert)
		}
	}

	func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
		await withCheckedContinuation { done in
			let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
			alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: false) })
			alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume(returning: true) })
			present(alert)
		}
	}

	func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
		await withCheckedContinuation { done in
			let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
			alert.addTextField { $0.text = defaultText }
			alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: nil) })
			alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume(returning: alert.textFields?.first?.text ?? "") })
			present(alert)
		}
	}
}

// MARK: - Downloads (e.g. Markdown export) go to the share sheet

extension WebPage: WKDownloadDelegate {
	func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
		let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
		try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		let file = folder.appending(path: suggestedFilename)
		downloads[ObjectIdentifier(download)] = file
		return file
	}

	func downloadDidFinish(_ download: WKDownload) {
		guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
		present(UIActivityViewController(activityItems: [file], applicationActivities: nil))
	}

	func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
		downloads.removeValue(forKey: ObjectIdentifier(download))
		let alert = UIAlertController(title: "Download failed", message: error.localizedDescription, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "OK", style: .default))
		present(alert)
	}
}

/// SwiftUI host for a page's long-lived web view, with loading and
/// can't-reach states drawn natively.
struct WebPageView: View {
	let page: WebPage

	var body: some View {
		ZStack {
			Color.appBackground
			PageHost(page: page)
				.opacity(page.loadError == nil ? 1 : 0)
			if let error = page.loadError {
				ContentUnavailableView {
					Label("Couldn't load this page", systemImage: "wifi.exclamationmark")
				} description: {
					Text(error)
				} actions: {
					Button("Try Again") { page.reload() }.buttonStyle(.borderedProminent)
				}
			} else if page.isFirstLoad {
				ProgressView()
			}
		}
	}

	private struct PageHost: UIViewRepresentable {
		let page: WebPage

		func makeUIView(context: Context) -> WKWebView {
			let webView = page.webView
			if webView.url == nil { page.load() }
			return webView
		}

		func updateUIView(_ webView: WKWebView, context: Context) {}
	}
}
