/*
 * lh-parakeet-stt — the local dictation engine (macOS, Apple Silicon).
 *
 * A long-lived child of the LearnHarness server (src/server/local-stt.ts).
 * It loads Parakeet TDT 0.6B once and then transcribes one utterance per
 * request — batch, not streaming: the app's dictation is deferred (the
 * transcript lands once, when the run ends), so one pass over the whole
 * utterance is both simpler and more accurate than chunked streaming.
 *
 * MODELS: FluidAudio's shared cache (~/Library/Application Support/
 * FluidAudio/Models) — the same directory every FluidAudio app uses, so a
 * machine that already runs one (FluidVoice, VoiceInk, Spokenly, …) reuses
 * its downloaded Parakeet instead of storing a second copy. Selection:
 *   LH_PARAKEET_MODEL=v2|v3  → that version (downloaded if absent)
 *   otherwise                → the first cached of v2 (English) then v3
 *                              (multilingual); neither cached → download v3.
 * A cached copy is found under the current folder name or the older
 * `…-coreml` one (see cacheCandidates) and loaded in place.
 *
 * PROTOCOL (stdio, one request at a time):
 *   stdin   u32 little-endian byte length N, then N bytes of 16 kHz mono
 *           signed 16-bit little-endian PCM.
 *   stdout  one JSON object per line:
 *             {"type":"ready","model":"v2","downloaded":false}   once, at boot
 *             {"type":"result","text":"…"}                       per request
 *             {"type":"error","message":"…"}                     per request, or fatal at boot
 * Library logging is routed to stderr: fd 1 is re-pointed at fd 2 and the
 * protocol writes to a private dup of the original stdout, so nothing but
 * protocol lines can ever reach the parent's parser.
 */
import FluidAudio
import Foundation

let protocolOut = FileHandle(fileDescriptor: dup(STDOUT_FILENO), closeOnDealloc: true)
dup2(STDERR_FILENO, STDOUT_FILENO)

func emit(_ object: [String: Any]) {
	guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
	data.append(0x0A)
	protocolOut.write(data)
}

func fail(_ message: String) -> Never {
	emit(["type": "error", "message": message])
	exit(1)
}

/// Read exactly `count` bytes from stdin; nil at EOF (the parent went away).
func readExactly(_ count: Int) -> Data? {
	var data = Data(capacity: count)
	while data.count < count {
		guard let chunk = try? FileHandle.standardInput.read(upToCount: count - data.count), !chunk.isEmpty else {
			return nil
		}
		data.append(chunk)
	}
	return data
}

/// Every directory a cached copy of `version` may live in. FluidAudio ≥ 0.15
/// names the folder `parakeet-tdt-0.6b-v2`; earlier releases (still bundled
/// by some apps) used the Hugging Face repo name, `…-v2-coreml`. Both are the
/// same compiled models, so either one is reused as-is.
func cacheCandidates(for version: AsrModelVersion) -> [URL] {
	let current = AsrModels.defaultCacheDirectory(for: version)
	let legacy = current.deletingLastPathComponent().appendingPathComponent(current.lastPathComponent + "-coreml")
	return [current, legacy]
}

/// The int8 file set FluidAudio's batch loader reads (v2 joint vs v3 joint).
func hasModels(at directory: URL, version: AsrModelVersion) -> Bool {
	let joint = version == .v2 ? "JointDecision.mlmodelc" : "JointDecisionv3.mlmodelc"
	let files = ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Decoder.mlmodelc", joint, "parakeet_vocab.json"]
	return files.allSatisfy { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0).path) }
}

/// The version to run and, when one is already on disk, where it is.
func chooseModels() -> (AsrModelVersion, URL?) {
	let forced: AsrModelVersion? =
		switch ProcessInfo.processInfo.environment["LH_PARAKEET_MODEL"]?.lowercased() {
		case "v2": .v2
		case "v3": .v3
		default: nil
		}
	for version in forced.map({ [$0] }) ?? [.v2, .v3] {
		if let directory = cacheCandidates(for: version).first(where: { hasModels(at: $0, version: version) }) {
			return (version, directory)
		}
	}
	return (forced ?? .v3, nil)
}

let (version, cachedDirectory) = chooseModels()
let manager = AsrManager(config: .default)
do {
	let models =
		if let cachedDirectory {
			try AsrModels.loadLocal(from: cachedDirectory, version: version)
		} else {
			try await AsrModels.downloadAndLoad(version: version)
		}
	try await manager.loadModels(models)
} catch {
	fail("Parakeet failed to load: \(error.localizedDescription)")
}
emit(["type": "ready", "model": version == .v2 ? "v2" : "v3", "downloaded": cachedDirectory == nil])

let minimumSamples = ASRConstants.minimumRequiredSamples(forSampleRate: 16_000)

while let header = readExactly(4) {
	let length = Int(header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian })
	guard let pcm = readExactly(length) else { break }
	var samples = pcm.withUnsafeBytes { raw in
		raw.bindMemory(to: Int16.self).map { Float(Int16(littleEndian: $0)) / 32768 }
	}
	// A click-and-release or a silent run: Parakeet invents a word ("Yeah.")
	// for near-empty input, so anything under 0.3 s or never above a whisper
	// transcribes to nothing.
	if samples.count < 4_800 || (samples.lazy.map(abs).max() ?? 0) < 0.01 {
		emit(["type": "result", "text": ""])
		continue
	}
	// Parakeet rejects clips under its minimum window — pad short ones with silence.
	if samples.count < minimumSamples {
		samples.append(contentsOf: repeatElement(0, count: minimumSamples - samples.count))
	}
	do {
		var state = try TdtDecoderState(decoderLayers: version.decoderLayers)
		let result = try await manager.transcribe(samples, decoderState: &state)
		emit(["type": "result", "text": result.text.trimmingCharacters(in: .whitespacesAndNewlines)])
	} catch {
		emit(["type": "error", "message": error.localizedDescription])
	}
}
