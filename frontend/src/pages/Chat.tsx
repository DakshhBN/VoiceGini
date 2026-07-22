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
import { connectVoiceSocket, type VoiceEvent } from '@/lib/voice-api'

export default function Chat() {
  const { user, logout } = useAuth()
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Voice socket state lives in refs, not React state - it's mutated from
  // event callbacks (MediaRecorder, WebSocket) that shouldn't trigger
  // re-renders on every chunk, and the socket must survive across
  // multiple push-to-talk utterances within the same thread.
  const voiceSocketRef = useRef<WebSocket | null>(null)
  const voiceThreadIdRef = useRef<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const activeThreadIdRef = useRef<string | null>(null)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId
  }, [activeThreadId])

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
    getMessages(activeThreadId).then(setMessages)
  }, [activeThreadId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    return () => {
      voiceSocketRef.current?.close()
      currentAudioRef.current?.pause()
    }
  }, [])

  function appendToken(token: string) {
    setMessages((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
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
      case 'error':
        setError(event.detail)
        setSending(false)
        break
    }
  }

  function playAudio(blob: Blob) {
    currentAudioRef.current?.pause()

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
    existing?.close()

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
    }
    voiceSocketRef.current = ws
    voiceThreadIdRef.current = threadId
    return ws
  }

  async function startRecording() {
    if (recording || sending) return
    setError(null)

    let threadId = activeThreadId
    if (!threadId) {
      const thread = await createThread()
      setThreads((prev) => [thread, ...prev])
      threadId = thread.id
      setActiveThreadId(threadId)
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Microphone access denied')
      return
    }

    const socketPromise = ensureVoiceSocket(threadId)

    const chunks: BlobPart[] = []
    const recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop())
      const blob = new Blob(chunks, { type: recorder.mimeType })
      try {
        const ws = await socketPromise
        setSending(true)
        ws.send(blob)
      } catch {
        setError('Failed to connect voice channel')
      }
    }

    mediaRecorderRef.current = recorder
    recorder.start()
    setRecording(true)
  }

  function stopRecording() {
    if (!recording) return
    mediaRecorderRef.current?.stop()
    setRecording(false)
  }

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

        {speaking && <p className="px-4 text-sm text-muted-foreground">Speaking…</p>}
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
            variant={recording ? 'destructive' : 'secondary'}
            size="icon"
            disabled={sending && !recording}
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onMouseLeave={stopRecording}
            onTouchStart={(e) => {
              e.preventDefault()
              startRecording()
            }}
            onTouchEnd={(e) => {
              e.preventDefault()
              stopRecording()
            }}
            title="Hold to talk"
          >
            {recording ? <Square className="size-4" /> : <Mic className="size-4" />}
          </Button>
          <Button type="submit" disabled={sending || !input.trim()}>
            Send
          </Button>
        </form>
      </main>
    </div>
  )
}
