// swift-tools-version: 6.0
// The local dictation helper (macOS only): Parakeet TDT on the Neural
// Engine through FluidAudio. Built by `npm run stt:build`; the server
// spawns it as a long-lived child (src/server/local-stt.ts).
import PackageDescription

let package = Package(
	name: "lh-parakeet-stt",
	platforms: [.macOS(.v14)],
	dependencies: [
		.package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7"),
	],
	targets: [
		.executableTarget(
			name: "lh-parakeet-stt",
			dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
		),
	]
)
