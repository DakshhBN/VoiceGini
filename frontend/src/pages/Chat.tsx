import { useEffect, useRef, useState } from 'react'
import { AudioLines, Mic, Pencil, Plus, Send, Sparkles, Square, Trash2, Waves } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  type Message,
  type Thread,
  createThread,
  deleteThread,
  getMessages,
  listThreads,
  renameThread,
  streamChat,
} from '@/lib/chat-api'
import { connectVoiceSocket, sendInterrupt, type VoiceEvent } from '@/lib/voice-api'
import { VoiceActivityDetector } from '@/lib/vad'

const MAX_RECONNECT_ATTEMPTS = 4
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const SIDEBAR_DEFAULT_WIDTH = 288

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
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH)
  const bottomRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)

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

  // Sidebar drag-to-resize - listens on window rather than the handle
  // itself so dragging still tracks the mouse once it outruns the (thin)
  // handle element between fast mousemove events.
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizingRef.current) return
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX))
      setSidebarWidth(next)
    }
    function onMouseUp() {
      resizingRef.current = false
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
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

  function updateThreadTitle(threadId: string, title: string) {
    setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title } : t)))
  }

  async function handleNewThread() {
    const thread = await createThread()
    setThreads((prev) => [thread, ...prev])
    setActiveThreadId(thread.id)
  }

  function startEditingThread(thread: Thread) {
    setEditingThreadId(thread.id)
    setEditingTitle(thread.title)
  }

  async function commitEditingThread() {
    const id = editingThreadId
    const title = editingTitle.trim()
    setEditingThreadId(null)
    if (!id || !title) return

    try {
      const updated = await renameThread(id, title)
      setThreads((prev) => prev.map((t) => (t.id === id ? updated : t)))
    } catch {
      setError('Failed to rename chat')
    }
  }

  async function handleDeleteThread(thread: Thread) {
    if (!window.confirm(`Delete "${thread.title}"? This can't be undone.`)) return

    try {
      await deleteThread(thread.id)
      const remaining = threads.filter((t) => t.id !== thread.id)
      setThreads(remaining)
      if (activeThreadId === thread.id) {
        setActiveThreadId(remaining.length > 0 ? remaining[0].id : null)
      }
    } catch {
      setError('Failed to delete chat')
    }
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
      await streamChat(threadId, content, appendToken, (title) => updateThreadTitle(threadId, title))
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
      case 'title':
        if (voiceThreadIdRef.current) updateThreadTitle(voiceThreadIdRef.current, event.title)
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
    <div className="flex h-svh bg-warm-canvas">
      <aside
        className="relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4"
        style={{ width: sidebarWidth }}
      >
        <div className="mb-5 flex items-center gap-2.5 px-1">
          <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-coral">
            <Sparkles className="size-4" />
          </span>
          <span className="font-heading text-base font-semibold tracking-tight text-foreground">
            VoiceGini
          </span>
        </div>

        <Button className="mb-4 justify-start gap-2" onClick={handleNewThread}>
          <Plus className="size-4" />
          New chat
        </Button>

        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className={`group/thread flex items-center gap-0.5 rounded-xl transition-colors ${
                thread.id === activeThreadId ? 'bg-accent' : 'hover:bg-accent/60'
              }`}
            >
              {editingThreadId === thread.id ? (
                <input
                  autoFocus
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={commitEditingThread}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEditingThread()
                    if (e.key === 'Escape') setEditingThreadId(null)
                  }}
                  className="min-w-0 flex-1 rounded-lg bg-transparent px-3 py-2.5 text-sm text-foreground outline-none ring-2 ring-ring"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setActiveThreadId(thread.id)}
                  className={`min-w-0 flex-1 truncate px-3 py-2.5 text-left text-sm ${
                    thread.id === activeThreadId ? 'font-medium text-accent-foreground' : 'text-foreground/80'
                  }`}
                >
                  {thread.title}
                </button>
              )}
              {editingThreadId !== thread.id && (
                <div className="flex shrink-0 items-center gap-0.5 pr-1.5 opacity-0 transition-opacity group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 has-[:focus-visible]:opacity-100">
                  <button
                    type="button"
                    onClick={() => startEditingThread(thread)}
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                    title="Rename chat"
                    aria-label="Rename chat"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteThread(thread)}
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title="Delete chat"
                    aria-label="Delete chat"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 border-t border-sidebar-border pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
              {user?.email?.[0]?.toUpperCase()}
            </span>
            <span className="truncate text-sm text-muted-foreground">{user?.email}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={logout}>
            Log out
          </Button>
        </div>

        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          onMouseDown={() => {
            resizingRef.current = true
          }}
          className="group absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none"
        >
          <div className="absolute inset-y-0 right-0 w-0.5 bg-transparent transition-colors group-hover:bg-primary/70" />
        </div>
      </aside>

      <main className="relative flex flex-1 flex-col overflow-hidden">
        {/* Faint voice-art watermark echoing the auth pages' decorative
            panel - kept very low-opacity so it reads as ambient texture
            behind the (light, functional) chat surface rather than
            competing with message content. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <AudioLines className="absolute top-16 right-12 size-10 rotate-12 text-primary/10" />
          <Waves className="absolute bottom-24 left-10 size-14 -rotate-6 text-primary/8" />
          <Sparkles className="absolute top-1/3 right-1/4 size-5 text-primary/10" />
          <div className="absolute top-1/2 left-1/2 size-72 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/10" />
          <div className="absolute top-1/2 left-1/2 size-96 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/5" />
        </div>

        <div className="relative flex-1 overflow-y-auto px-4 py-8">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="relative flex items-center justify-center">
                <div className="absolute -inset-6 rounded-full border border-primary/15" />
                <div className="absolute -inset-3 rounded-full border border-primary/20" />
                <span className="relative flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-coral">
                  <Mic className="size-5" />
                </span>
              </div>
              <p className="text-base font-medium text-foreground">Start a conversation</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                Type a message or hold the mic to talk.
              </p>
            </div>
          )}
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {messages.map((message, i) => (
              <div
                key={i}
                className={`max-w-[80%] animate-fade-in-up rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap shadow-soft ${
                  message.role === 'user'
                    ? 'ml-auto rounded-br-md bg-primary text-primary-foreground'
                    : 'rounded-bl-md bg-card text-card-foreground'
                }`}
              >
                {message.content || (sending && i === messages.length - 1 ? '…' : '')}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-1.5 px-4">
          {voiceStatus && (
            <p className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              {voiceStatus}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSend()
          }}
          className="mx-auto w-full max-w-2xl p-4 pb-6"
        >
          <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-1.5 shadow-soft-lg">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message…"
              disabled={sending}
              className="border-0 bg-transparent shadow-none"
            />
            <Button
              type="button"
              variant={voiceModeActive ? 'destructive' : 'secondary'}
              size="icon"
              className={voiceModeActive ? 'animate-soft-pulse' : ''}
              onClick={voiceModeActive ? stopVoiceMode : startVoiceMode}
              title={voiceModeActive ? 'Stop voice mode' : 'Start voice mode'}
            >
              {voiceModeActive ? <Square className="size-4" /> : <Mic className="size-4" />}
            </Button>
            <Button
              type="submit"
              disabled={sending || !input.trim()}
              size="icon"
              aria-label="Send message"
              title="Send message"
            >
              <Send className="size-4" />
            </Button>
          </div>
        </form>
      </main>
    </div>
  )
}
