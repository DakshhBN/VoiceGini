import { useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  type Message,
  type Thread,
  createThread,
  getMessages,
  listThreads,
  streamChat,
} from '@/lib/chat-api'
import { connectVoiceSocket, sendInterrupt, type VoiceEvent } from '@/lib/voice-api'
import { VoiceActivityDetector } from '@/lib/vad'

const MAX_RECONNECT_ATTEMPTS = 4

export default function Chat() {
  const { user, logout } = useAuth()
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [voiceModeActive, setVoiceModeActive] = useState(false)
  const [userSpeaking, setUserSpeaking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Voice socket/VAD/playback state lives in refs, not React state - it's
  // mutated from event callbacks (VAD, WebSocket, Audio) that shouldn't
  // trigger re-renders on every chunk, and it all needs to survive across
  // multiple utterances within one continuous voice-mode session.
  const voiceSocketRef = useRef<WebSocket | null>(null)
  const voiceThreadIdRef = useRef<string | null>(null)
  const vadRef = useRef<VoiceActivityDetector | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  // Set right before any deliberate ws.close() so the onclose handler can
  // tell "we did this on purpose" apart from "the connection dropped" -
  // only the latter should trigger a reconnect attempt.
  const intentionalCloseRef = useRef(false)
  const reconnectAttemptsRef = useRef(0)
  // Set right before setActiveThreadId() when the caller (handleSend,
  // startVoiceMode) just created the thread itself and is about to seed
  // its messages optimistically - without this, the fetch below would
  // race that optimistic update: it always resolves to [] (the thread is
  // genuinely brand new in the DB), but if it lands *after* the optimistic
  // bubbles were added, it wipes them out. The next streamed token then
  // updates "the last message" of an empty array and throws, and with no
  // error boundary the whole tree unmounts to a blank page.
  const skipNextMessagesFetchRef = useRef(false)

  useEffect(() => {
    listThreads().then((loaded) => {
      setThreads(loaded)
      if (loaded.length > 0) setActiveThreadId(loaded[0].id)
    })
  }, [])

  useEffect(() => {
    if (!activeThreadId) {
      setMessages([])
      return
    }
    if (skipNextMessagesFetchRef.current) {
      skipNextMessagesFetchRef.current = false
      return
    }
    getMessages(activeThreadId).then(setMessages)
  }, [activeThreadId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Voice mode is scoped to one thread's socket/VAD session - switching
  // threads mid-session would otherwise keep listening on a mic bound to
  // the old thread's connection.
  useEffect(() => {
    if (voiceModeActive) stopVoiceMode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId])

  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true
      voiceSocketRef.current?.close()
      currentAudioRef.current?.pause()
      vadRef.current?.stop()
      micStreamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  function appendToken(token: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      // Defensive: there's no error boundary above this component, so a
      // token arriving with no assistant bubble to append to (a bug
      // elsewhere in the message-list bookkeeping) should degrade to a
      // new bubble rather than crash the whole tree to a blank page.
      if (!last || last.role !== 'assistant') {
        return [...prev, { role: 'assistant', content: token }]
      }
      const next = [...prev]
      next[next.length - 1] = { role: 'assistant', content: last.content + token }
      return next
    })
  }

  async function handleNewThread() {
    const thread = await createThread()
    setThreads((prev) => [thread, ...prev])
    setActiveThreadId(thread.id)
  }

  async function handleSend() {
    const content = input.trim()
    if (!content || sending) return

    let threadId = activeThreadId
    if (!threadId) {
      const thread = await createThread()
      setThreads((prev) => [thread, ...prev])
      threadId = thread.id
      skipNextMessagesFetchRef.current = true
      setActiveThreadId(threadId)
    }

    setInput('')
    setError(null)
    setSending(true)
    setMessages((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '' }])

    try {
      await streamChat(threadId, content, appendToken)
    } catch {
      setError('Failed to get a response')
    } finally {
      setSending(false)
    }
  }

  function handleVoiceEvent(event: VoiceEvent) {
    switch (event.type) {
      case 'transcript':
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: event.text },
          { role: 'assistant', content: '' },
        ])
        break
      case 'token':
        appendToken(event.token)
        break
      case 'audio':
        // No-op marker - the actual audio arrives as the next binary WS
        // frame, handled by the socket's onmessage Blob branch below.
        break
      case 'done':
        setSending(false)
        break
      case 'interrupted':
        setSending(false)
        // Drop a still-empty assistant bubble left over from a turn that
        // got cut off before any text came back.
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant' && last.content === '') return prev.slice(0, -1)
          return prev
        })
        break
      case 'error':
        setError(event.detail)
        setSending(false)
        break
    }
  }

  function stopPlayback() {
    currentAudioRef.current?.pause()
    currentAudioRef.current = null
    setSpeaking(false)
  }

  function playAudio(blob: Blob) {
    stopPlayback()

    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudioRef.current = audio

    const cleanup = () => {
      URL.revokeObjectURL(url)
      if (currentAudioRef.current === audio) currentAudioRef.current = null
      setSpeaking(false)
    }
    audio.onended = cleanup
    audio.onerror = cleanup

    setSpeaking(true)
    audio.play().catch(cleanup)
  }

  // Reused across utterances in the same thread rather than reconnecting
  // per recording - a fresh ticket-authenticated connection per utterance
  // would add a network round trip before every reply.
  async function ensureVoiceSocket(threadId: string): Promise<WebSocket> {
    const existing = voiceSocketRef.current
    if (existing && voiceThreadIdRef.current === threadId && existing.readyState === WebSocket.OPEN) {
      return existing
    }
    if (existing) {
      intentionalCloseRef.current = true
      existing.close()
    }

    const ws = await connectVoiceSocket(threadId)
    ws.onmessage = (e) => {
      if (e.data instanceof Blob) {
        playAudio(e.data)
        return
      }
      handleVoiceEvent(JSON.parse(e.data) as VoiceEvent)
    }
    ws.onclose = () => {
      if (voiceSocketRef.current === ws) voiceSocketRef.current = null

      if (intentionalCloseRef.current) {
        intentionalCloseRef.current = false
        return
      }
      // Voice mode is still meant to be active (vadRef is only cleared by
      // stopVoiceMode) - the connection dropped out from under it, so try
      // to recover rather than silently going deaf.
      if (vadRef.current) void reconnectVoiceSocket(threadId)
    }
    voiceSocketRef.current = ws
    voiceThreadIdRef.current = threadId
    reconnectAttemptsRef.current = 0
    setReconnecting(false)
    return ws
  }

  async function reconnectVoiceSocket(threadId: string): Promise<void> {
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setReconnecting(false)
      setError('Voice channel disconnected')
      stopVoiceMode()
      return
    }
    reconnectAttemptsRef.current += 1
    setReconnecting(true)

    const delayMs = Math.min(1000 * 2 ** (reconnectAttemptsRef.current - 1), 8000)
    await new Promise((resolve) => setTimeout(resolve, delayMs))

    // Voice mode may have been stopped manually while we were waiting.
    if (!vadRef.current) {
      setReconnecting(false)
      return
    }

    try {
      await ensureVoiceSocket(threadId)
    } catch {
      await reconnectVoiceSocket(threadId)
    }
  }

  async function startVoiceMode() {
    if (voiceModeActive) return
    setError(null)

    let threadId = activeThreadId
    if (!threadId) {
      const thread = await createThread()
      setThreads((prev) => [thread, ...prev])
      threadId = thread.id
      skipNextMessagesFetchRef.current = true
      setActiveThreadId(threadId)
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch {
      setError('Microphone access denied')
      return
    }

    try {
      await ensureVoiceSocket(threadId)
    } catch {
      stream.getTracks().forEach((track) => track.stop())
      setError('Failed to connect voice channel')
      return
    }

    micStreamRef.current = stream
    // Reads voiceSocketRef.current rather than closing over a single
    // WebSocket instance, so a mid-session reconnect (a fresh socket
    // object) is picked up transparently without rebuilding the VAD.
    const vad = new VoiceActivityDetector(stream, {
      onSpeechStart: () => {
        // Cut the assistant off the instant the user starts talking -
        // locally right away, and over the wire so the server abandons
        // whatever it's still generating for the previous turn.
        setUserSpeaking(true)
        stopPlayback()
        const ws = voiceSocketRef.current
        if (ws) sendInterrupt(ws)
      },
      onSpeechEnd: (blob) => {
        setUserSpeaking(false)
        const ws = voiceSocketRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          setError('Voice channel disconnected')
          return
        }
        setSending(true)
        ws.send(blob)
      },
    })
    vad.start()
    vadRef.current = vad
    setVoiceModeActive(true)
  }

  function stopVoiceMode() {
    vadRef.current?.stop()
    vadRef.current = null
    micStreamRef.current?.getTracks().forEach((track) => track.stop())
    micStreamRef.current = null
    setVoiceModeActive(false)
    setUserSpeaking(false)
  }

  const voiceStatus = reconnecting
    ? 'Reconnecting…'
    : userSpeaking
      ? 'Hearing you…'
      : sending
        ? 'Thinking…'
        : speaking
          ? 'Speaking…'
          : voiceModeActive
            ? 'Listening…'
            : null

  return (
    <div className="flex h-svh">
      <aside className="flex w-64 flex-col border-r p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="truncate text-sm text-muted-foreground">{user?.email}</span>
          <Button variant="ghost" size="sm" onClick={logout}>
            Log out
          </Button>
        </div>
        <Button className="mb-3" onClick={handleNewThread}>
          New chat
        </Button>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => setActiveThreadId(thread.id)}
              className={`truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
                thread.id === activeThreadId ? 'bg-accent' : ''
              }`}
            >
              {thread.title}
            </button>
          ))}
        </div>
      </aside>

      <main className="flex flex-1 flex-col">
        <div className="flex-1 overflow-y-auto p-4">
          {messages.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">Start a conversation</p>
          )}
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {messages.map((message, i) => (
              <div
                key={i}
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  message.role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted'
                }`}
              >
                {message.content || (sending && i === messages.length - 1 ? '…' : '')}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {voiceStatus && <p className="px-4 text-sm text-muted-foreground">{voiceStatus}</p>}
        {error && <p className="px-4 text-sm text-destructive">{error}</p>}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSend()
          }}
          className="mx-auto flex w-full max-w-2xl gap-2 p-4"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message…"
            disabled={sending}
          />
          <Button
            type="button"
            variant={voiceModeActive ? 'destructive' : 'secondary'}
            size="icon"
            onClick={voiceModeActive ? stopVoiceMode : startVoiceMode}
            title={voiceModeActive ? 'Stop voice mode' : 'Start voice mode'}
          >
            {voiceModeActive ? <Square className="size-4" /> : <Mic className="size-4" />}
          </Button>
          <Button type="submit" disabled={sending || !input.trim()}>
            Send
          </Button>
        </form>
      </main>
    </div>
  )
}
