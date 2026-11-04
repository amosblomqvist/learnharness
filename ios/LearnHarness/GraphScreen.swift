import SwiftUI

/// The knowledge graph: the server's graph view, with sessions it starts or
/// links to opening natively in the Sessions tab.
struct GraphScreen: View {
	@Environment(AppModel.self) private var model
	@Environment(Router.self) private var router
	@State private var page: WebPage?

	var body: some View {
		NavigationStack {
			Group {
				if let page { WebPageView(page: page) } else { Color.appBackground }
			}
			.navigationTitle("Graph")
			.navigationBarTitleDisplayMode(.inline)
			.toolbarBackground(Color.appBackground, for: .navigationBar)
			.toolbar {
				ToolbarItem(placement: .topBarTrailing) {
					Button { page?.reload() } label: { Image(systemName: "arrow.clockwise") }
						.accessibilityLabel("Reload Graph")
				}
			}
		}
		.onAppear {
			guard page == nil else { return }
			let page = WebPage(server: model.server, path: "/")
			page.onRoute = { path in
				guard path.hasPrefix("/chat/"), let id = path.split(separator: "/").last.map(String.init), id != "new" else { return false }
				model.scheduleRefresh()
				router.open(chat: id)
				return true
			}
			self.page = page
		}
	}
}
