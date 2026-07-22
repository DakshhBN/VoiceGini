import { useEffect, useRef, useState } from 'react'
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

export default function Chat() {
  const { user, logout } = useAuth()
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

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
      await streamChat(threadId, content, (token) => {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          next[next.length - 1] = { role: 'assistant', content: last.content + token }
          return next
        })
      })
    } catch {
      setError('Failed to get a response')
    } finally {
      setSending(false)
    }
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
          <Button type="submit" disabled={sending || !input.trim()}>
            Send
          </Button>
        </form>
      </main>
    </div>
  )
}
