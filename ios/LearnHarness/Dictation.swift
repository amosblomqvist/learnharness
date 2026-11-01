import AVFoundation
import Speech
import SwiftUI

/// Speech to text with Apple's recognizer, on the device when it can be.
/// Works over plain http (the web page's mic needs https) and sends no
/// audio to the LearnHarness server.
@MainActor
@Observable
final class Dictation {
	private(set) var isRecording = false
	private(set) var error: String?
	/// Microphone level, 0…1, for the recording indicator.
	private(set) var level: Float = 0

	@ObservationIgnored private let engine = AVAudioEngine()
	@ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
	@ObservationIgnored private var task: SFSpeechRecognitionTask?
	@ObservationIgnored private var recognizer = SFSpeechRecognizer()

	/// Starts listening. `onText` gets the full transcript so far, each time it changes.
	func start(onText: @escaping (String) -> Void) async {
		guard !isRecording else { return }
		error = nil
		guard await Self.authorize() else {
			error = "Allow Microphone and Speech Recognition for LearnHarness in Settings to dictate."
			return
		}
		guard let recognizer, recognizer.isAvailable else {
			error = "Speech recognition isn't available right now."
			return
		}
		do {
			let session = AVAudioSession.sharedInstance()
			try session.setCategory(.record, mode: .measurement, options: .duckOthers)
			try session.setActive(true, options: .notifyOthersOnDeactivation)

			let request = SFSpeechAudioBufferRecognitionRequest()
			request.shouldReportPartialResults = true
			request.addsPunctuation = true
			if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
			self.request = request

			let input = engine.inputNode
			let format = input.outputFormat(forBus: 0)
			input.removeTap(onBus: 0)
			input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
				request.append(buffer)
				let level = Self.rms(buffer)
				Task { @MainActor in self?.level = level }
			}
			engine.prepare()
			try engine.start()
			isRecording = true

			task = recognizer.recognitionTask(with: request) { [weak self] result, error in
				let text = result?.bestTranscription.formattedString
				let final = result?.isFinal ?? false
				Task { @MainActor in
					guard let self else { return }
					if let text { onText(text) }
					if final || error != nil { self.finish() }
				}
			}
		} catch {
			self.error = "Couldn't start the microphone (\(error.localizedDescription))."
			finish()
		}
	}

	/// Stops listening; the last words still arrive through `onText`.
	func stop() {
		guard isRecording else { return }
		request?.endAudio()
		finish()
	}

	private func finish() {
		if engine.isRunning {
			engine.stop()
			engine.inputNode.removeTap(onBus: 0)
		}
		request?.endAudio()
		request = nil
		task?.finish()
		task = nil
		isRecording = false
		level = 0
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
	}

	private static func authorize() async -> Bool {
		let speech = await withCheckedContinuation { done in
			SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0 == .authorized) }
		}
		guard speech else { return false }
		return await AVAudioApplication.requestRecordPermission()
	}

	nonisolated private static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
		guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
		var sum: Float = 0
		for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
		let rms = (sum / Float(buffer.frameLength)).squareRoot()
		return min(1, rms * 12)
	}
}

/// The mic button: tap to dictate into `text`, tap again to stop. Speech is
/// added after whatever was already typed.
struct DictationButton: View {
	@Binding var text: String
	let dictation: Dictation
	@State private var base = ""

	var body: some View {
		Button {
			if dictation.isRecording {
				dictation.stop()
			} else {
				base = text
				Task {
					await dictation.start { spoken in
						let prefix = base.trimmingCharacters(in: .whitespacesAndNewlines)
						text = prefix.isEmpty ? spoken : prefix + " " + spoken
					}
				}
			}
		} label: {
			Image(systemName: dictation.isRecording ? "stop.circle.fill" : "mic")
				.font(.system(size: 20))
				.foregroundStyle(dictation.isRecording ? Color.red : Color.secondary)
				.symbolEffect(.pulse, isActive: dictation.isRecording)
				.frame(width: 36, height: 36)
				.contentShape(Rectangle())
		}
		.accessibilityLabel(dictation.isRecording ? "Stop Dictation" : "Dictate")
	}
}
