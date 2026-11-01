import SwiftUI
import UIKit

/// The desktop app's look (app/globals.css): a monochrome dark palette,
/// monospaced chrome and CMU Serif titles. Native screens use these so the
/// phone reads as the same app as the Mac.
enum Theme {
	static let background = Color(hex: 0x141414)
	static let card = Color(hex: 0x1C1C1C)
	/// Hover / selected surfaces.
	static let raised = Color(hex: 0x2A2A2A)
	static let foreground = Color(hex: 0xE6E6E6)
	static let muted = Color(hex: 0x8D8D8D)
	static let border = Color(hex: 0x434343)
	/// --destructive (oklch 0.704 0.191 22.2).
	static let destructive = Color(red: 1.0, green: 0.39, blue: 0.40)
	static let warning = Color(red: 0.95, green: 0.75, blue: 0.35)

	/// Chrome text (JetBrains Mono on desktop; SF Mono here).
	static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
		.system(size: size, weight: weight, design: .monospaced)
	}

	/// Session names and screen titles (CMU Serif Bold, bundled).
	static func title(_ size: CGFloat) -> Font {
		// Built from UIFont so the app-wide monospaced design can't restyle it.
		UIFont(name: "CMUSerif-Bold", size: size).map { Font($0) } ?? .system(size: size, weight: .bold, design: .serif)
	}

	/// Small uppercase labels, like the desktop's phase chip.
	static func label(_ size: CGFloat = 11) -> Font {
		.system(size: size, weight: .medium, design: .monospaced)
	}

	/// UIKit bars and controls in the same style.
	@MainActor
	static func applyAppearance() {
		let uiBackground = UIColor(background)
		let uiForeground = UIColor(foreground)
		let mono = { (size: CGFloat, weight: UIFont.Weight) in UIFont.monospacedSystemFont(ofSize: size, weight: weight) }
		// Screen names sit in a slim bar in CMU Serif, like the desktop's top bar.
		let serif = UIFont(name: "CMUSerif-Bold", size: 20) ?? .boldSystemFont(ofSize: 20)

		let nav = UINavigationBarAppearance()
		nav.configureWithOpaqueBackground()
		nav.backgroundColor = uiBackground
		nav.shadowColor = UIColor(border)
		nav.titleTextAttributes = [.foregroundColor: uiForeground, .font: serif]
		UINavigationBar.appearance().standardAppearance = nav
		UINavigationBar.appearance().scrollEdgeAppearance = nav
		UINavigationBar.appearance().compactAppearance = nav

		let tab = UITabBarAppearance()
		tab.configureWithOpaqueBackground()
		tab.backgroundColor = uiBackground
		tab.shadowColor = UIColor(border)
		for item in [tab.stackedLayoutAppearance, tab.inlineLayoutAppearance, tab.compactInlineLayoutAppearance] {
			item.normal.iconColor = UIColor(muted)
			item.normal.titleTextAttributes = [.foregroundColor: UIColor(muted), .font: mono(10, .regular)]
			item.selected.iconColor = uiForeground
			item.selected.titleTextAttributes = [.foregroundColor: uiForeground, .font: mono(10, .semibold)]
		}
		UITabBar.appearance().standardAppearance = tab
		UITabBar.appearance().scrollEdgeAppearance = tab

		UISegmentedControl.appearance().setTitleTextAttributes([.font: mono(13, .medium), .foregroundColor: UIColor(muted)], for: .normal)
		UISegmentedControl.appearance().setTitleTextAttributes([.font: mono(13, .semibold), .foregroundColor: uiForeground], for: .selected)
		UISegmentedControl.appearance().selectedSegmentTintColor = UIColor(raised)
		UITableView.appearance().separatorColor = UIColor(border)
	}
}

extension Color {
	init(hex: UInt32) {
		self.init(
			red: Double((hex >> 16) & 0xFF) / 255,
			green: Double((hex >> 8) & 0xFF) / 255,
			blue: Double(hex & 0xFF) / 255
		)
	}

	/// The web app's background, so native screens and loading states match it.
	static let appBackground = Theme.background
}

/// The desktop's bordered card: #1c1c1c with a #434343 hairline.
struct CardBackground: ViewModifier {
	var radius: CGFloat = 16

	func body(content: Content) -> some View {
		content
			.background(Theme.card, in: RoundedRectangle(cornerRadius: radius))
			.overlay(RoundedRectangle(cornerRadius: radius).stroke(Theme.border, lineWidth: 1))
	}
}

extension View {
	func lhCard(radius: CGFloat = 16) -> some View { modifier(CardBackground(radius: radius)) }

	/// List styling shared by the native lists (desktop background and borders).
	func lhList() -> some View {
		scrollContentBackground(.hidden)
			.background(Theme.background)
			.listRowSeparatorTint(Theme.border)
	}
}
