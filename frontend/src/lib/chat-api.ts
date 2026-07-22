import { api } from '@/lib/api'

export interface Thread {
  id: string
  title: string
  created_at: string
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
}

export async function listThreads(): Promise<Thread[]> {
  const res = await api.get<Thread[]>('/threads')
  return res.data
}

export async function createThread(title?: string): Promise<Thread> {
  const res = await api.post<Thread>('/threads', { title })
  return res.data
}

export async function getMessages(threadId: string): Promise<Message[]> {
  const res = await api.get<Message[]>(`/threads/${threadId}/messages`)
  return res.data
}

export async function renameThread(threadId: string, title: string): Promise<Thread> {
  const res = await api.patch<Thread>(`/threads/${threadId}`, { title })
  return res.data
}

export async function deleteThread(threadId: string): Promise<void> {
  await api.delete(`/threads/${threadId}`)
}

// Hand-rolled fetch() + ReadableStream rather than EventSource or axios:
// EventSource can't send a POST body or an Authorization header, and
// axios doesn't expose a streaming read in the browser. Mirrors ChatGini's
// SSE approach.
export async function streamChat(
  threadId: string,
  content: string,
  onToken: (token: string) => void,
): Promise<void> {
  const token = localStorage.getItem('access_token')
  const baseURL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

  const res = await fetch(`${baseURL}/threads/${threadId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ content }),
  })

  if (!res.ok || !res.body) {
    throw new Error(`Chat request failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''

    for (const event of events) {
      if (!event.startsWith('data: ')) continue
      const data = event.slice('data: '.length)
      if (data === '[DONE]') return
      const parsed = JSON.parse(data) as { token: string }
      onToken(parsed.token)
    }
  }
}
