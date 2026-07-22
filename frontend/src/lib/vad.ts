// Lightweight energy-based voice activity detection: an AnalyserNode
// polled on an interval, comparing RMS volume against a threshold with a
// silence "hangover" so brief pauses mid-sentence don't cut an utterance
// short. This is simpler than a neural VAD (Silero et al.) - no WASM model
// to load, no extra asset pipeline - at the cost of being less robust to
// background noise. Good enough for a dev/demo voice loop; worth revisiting
// if false triggers become a real problem.

export interface VadCallbacks {
  onSpeechStart: () => void
  onSpeechEnd: (blob: Blob) => void
}

export interface VadOptions {
  speechThreshold: number
  silenceHangoverMs: number
  minSpeechMs: number
  pollIntervalMs: number
}

const DEFAULT_OPTIONS: VadOptions = {
  speechThreshold: 0.02,
  silenceHangoverMs: 600,
  minSpeechMs: 200,
  pollIntervalMs: 50,
}

export class VoiceActivityDetector {
  private readonly options: VadOptions
  private readonly audioContext: AudioContext
  private readonly analyser: AnalyserNode
  private readonly source: MediaStreamAudioSourceNode
  private readonly sampleData: Uint8Array
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private intervalId: ReturnType<typeof setInterval> | null = null
  private speaking = false
  private speechStartedAt = 0
  private silenceStartedAt: number | null = null

  constructor(
    private readonly stream: MediaStream,
    private readonly callbacks: VadCallbacks,
    options: Partial<VadOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.audioContext = new AudioContext()
    this.source = this.audioContext.createMediaStreamSource(stream)
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 1024
    this.source.connect(this.analyser)
    this.sampleData = new Uint8Array(this.analyser.fftSize)
  }

  start(): void {
    if (this.intervalId !== null) return
    this.intervalId = setInterval(() => this.tick(), this.options.pollIntervalMs)
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop()
    }
    this.recorder = null
    this.source.disconnect()
    void this.audioContext.close()
  }

  private rms(): number {
    this.analyser.getByteTimeDomainData(this.sampleData)
    let sumSquares = 0
    for (const byte of this.sampleData) {
      const normalized = (byte - 128) / 128
      sumSquares += normalized * normalized
    }
    return Math.sqrt(sumSquares / this.sampleData.length)
  }

  private tick(): void {
    const level = this.rms()
    const now = performance.now()
    const aboveThreshold = level > this.options.speechThreshold

    if (aboveThreshold) {
      this.silenceStartedAt = null
      if (!this.speaking) {
        this.speaking = true
        this.speechStartedAt = now
        this.beginRecording()
        this.callbacks.onSpeechStart()
      }
      return
    }

    if (!this.speaking) return

    if (this.silenceStartedAt === null) {
      this.silenceStartedAt = now
      return
    }

    if (now - this.silenceStartedAt >= this.options.silenceHangoverMs) {
      this.speaking = false
      this.silenceStartedAt = null
      const spokeLongEnough = now - this.speechStartedAt >= this.options.minSpeechMs
      this.endRecording(spokeLongEnough)
    }
  }

  private beginRecording(): void {
    this.chunks = []
    const recorder = new MediaRecorder(this.stream)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    recorder.start()
    this.recorder = recorder
  }

  private endRecording(deliver: boolean): void {
    const recorder = this.recorder
    if (!recorder) return
    this.recorder = null

    if (!deliver) {
      recorder.stop()
      return
    }

    recorder.addEventListener(
      'stop',
      () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType })
        this.callbacks.onSpeechEnd(blob)
      },
      { once: true },
    )
    recorder.stop()
  }
}
