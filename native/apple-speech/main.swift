// Apple on-device dictation helper (SpeechAnalyzer + SpeechTranscriber,
// macOS 26+). Spawned by electron/apple-speech.cjs; one subcommand per run:
//
//   status      one JSON line: availability, locale, model state, reservation
//   install     reserve the locale + download the model; progress JSON lines
//   release     drop this app's reservation (macOS removes the model later,
//               unless another app still uses it)
//   transcribe  stdin = linear16 16 kHz mono PCM (the renderer's worklet
//               frames); stdout = {"type":"final"} lines; stdin EOF finalizes
//
// Locale: the system locale when SpeechTranscriber supports it, else en-US.
// stdout carries protocol lines only.
import AVFoundation
import Foundation
import Speech

let outputLock = NSLock()

/// One JSON object per line. POSIX write, not FileHandle: a dead parent
/// (EPIPE) must not raise an Objective-C exception.
func emit(_ object: [String: Any]) {
	guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
	data.append(0x0A)
	outputLock.lock()
	defer { outputLock.unlock() }
	data.withUnsafeBytes { raw in _ = write(STDOUT_FILENO, raw.baseAddress, raw.count) }
}

func fail(_ message: String) -> Never {
	emit(["type": "error", "message": message])
	exit(1)
}

func resolveLocale() async -> Locale {
	await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) ?? Locale(identifier: "en-US")
}

func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
	SpeechTranscriber(locale: locale, preset: .transcription)
}

/// reservedLocales may hold variants of the reserved locale — compare
/// language + region, not the raw identifier.
func sameLocale(_ a: Locale, _ b: Locale) -> Bool {
	a.language.languageCode == b.language.languageCode && a.region == b.region
}

func isReserved(_ locale: Locale) async -> Bool {
	await AssetInventory.reservedLocales.contains { sameLocale($0, locale) }
}

func status() async {
	guard SpeechTranscriber.isAvailable else {
		emit(["available": false])
		return
	}
	let locale = await resolveLocale()
	// AssetInventory.status reports this app's reservation, not the disk: a
	// released model reads .supported while macOS still keeps it (shared
	// with other apps). installedLocales is what is actually on the Mac.
	let model: String
	if await SpeechTranscriber.installedLocales.contains(where: { sameLocale($0, locale) }) {
		model = "installed"
	} else {
		switch await AssetInventory.status(forModules: [makeTranscriber(locale)]) {
		case .installed: model = "installed"
		case .downloading: model = "downloading"
		case .supported: model = "supported"
		default: model = "unsupported"
		}
	}
	emit([
		"available": true,
		"locale": locale.identifier(.bcp47),
		"language": Locale(identifier: "en").localizedString(forIdentifier: locale.identifier) ?? locale.identifier,
		"model": model,
		"reserved": await isReserved(locale),
	])
}

func install() async {
	let locale = await resolveLocale()
	// Reservations are capped per app: free the oldest one for a new locale.
	let reserved = await AssetInventory.reservedLocales
	if !reserved.contains(where: { sameLocale($0, locale) }), reserved.count >= AssetInventory.maximumReservedLocales, let oldest = reserved.first {
		_ = await AssetInventory.release(reservedLocale: oldest)
	}
	do {
		_ = try await AssetInventory.reserve(locale: locale)
		if let request = try await AssetInventory.assetInstallationRequest(supporting: [makeTranscriber(locale)]) {
			let observation = request.progress.observe(\.fractionCompleted, options: [.initial, .new]) { progress, _ in
				emit(["type": "progress", "fraction": progress.fractionCompleted])
			}
			defer { observation.invalidate() }
			try await request.downloadAndInstall()
		}
		emit(["type": "done"])
	} catch {
		fail(error.localizedDescription)
	}
}

func transcribe() async {
	let locale = await resolveLocale()
	let transcriber = makeTranscriber(locale)
	// Hold a reservation while in use, so macOS keeps the model. Best effort:
	// at the reservation cap this fails and transcription still runs.
	if !(await isReserved(locale)) { _ = try? await AssetInventory.reserve(locale: locale) }
	// nil = the model is not installed.
	guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
		fail("model-missing")
	}
	guard let inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true) else {
		fail("Unsupported input format")
	}
	// The analyzer never converts: every buffer must match analyzerFormat
	// exactly (a mismatch fails start(inputSequence:) with nilError).
	// AnalyzerInputConverter is macOS 27+, so AVAudioConverter does it here.
	let converter: AVAudioConverter?
	if inputFormat == analyzerFormat {
		converter = nil
	} else {
		guard let made = AVAudioConverter(from: inputFormat, to: analyzerFormat) else { fail("Unsupported analyzer format") }
		made.primeMethod = .none
		converter = made
	}

	let analyzer = SpeechAnalyzer(modules: [transcriber])
	let (inputSequence, inputBuilder) = AsyncStream.makeStream(of: AnalyzerInput.self)

	let results = Task {
		do {
			for try await result in transcriber.results where result.isFinal {
				let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
				if !text.isEmpty { emit(["type": "final", "text": text]) }
			}
		} catch {
			emit(["type": "error", "message": error.localizedDescription])
		}
	}

	do {
		try await analyzer.start(inputSequence: inputSequence)
	} catch {
		fail(error.localizedDescription)
	}
	emit(["type": "ready"])

	let reader = Thread {
		var carry = Data()
		while true {
			let chunk = FileHandle.standardInput.availableData
			if chunk.isEmpty { break } // EOF: the stop path closed stdin
			carry.append(chunk)
			let usable = carry.count & ~1 // whole Int16 samples only
			if usable == 0 { continue }
			let frames = AVAudioFrameCount(usable / 2)
			guard let pcm = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames) else { continue }
			pcm.frameLength = frames
			carry.prefix(usable).withUnsafeBytes { raw in
				_ = memcpy(pcm.int16ChannelData![0], raw.baseAddress!, usable)
			}
			carry = Data(carry.dropFirst(usable))
			if let buffer = convert(pcm, with: converter, to: analyzerFormat) {
				inputBuilder.yield(AnalyzerInput(buffer: buffer))
			}
		}
		inputBuilder.finish()
	}
	reader.start()

	do {
		try await analyzer.finalizeAndFinishThroughEndOfInput()
	} catch {
		fail(error.localizedDescription)
	}
	await results.value
	emit(["type": "end"])
}

func convert(_ input: AVAudioPCMBuffer, with converter: AVAudioConverter?, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
	guard let converter else { return input }
	let ratio = format.sampleRate / input.format.sampleRate
	let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 32
	guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
	var supplied = false
	var error: NSError?
	converter.convert(to: output, error: &error) { _, inputStatus in
		if supplied {
			inputStatus.pointee = .noDataNow
			return nil
		}
		supplied = true
		inputStatus.pointee = .haveData
		return input
	}
	if error != nil || output.frameLength == 0 { return nil }
	return output
}

switch CommandLine.arguments.dropFirst().first {
case "status": await status()
case "install": await install()
case "transcribe": await transcribe()
default: fail("usage: apple-speech status|install|transcribe")
}
exit(0)
