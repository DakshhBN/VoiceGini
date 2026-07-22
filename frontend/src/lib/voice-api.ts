import { api } from '@/lib/api'

export type VoiceEvent =
  | { type: 'transcript'; text: string }
  | { type: 'token'; token: string }
  | { type: 'audio'; format: string }
  | { type: 'done' }
  | { type: 'interrupted' }
  | { type: 'error'; detail: string }

// Sent the instant the client's VAD detects the user talking again, ahead
// of the new utterance's audio - lets the server cancel a still-in-flight
// reply as early as possible instead of waiting for the full recording.
export function sendInterrupt(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'interrupt' }))
  }
}

async function getWsTicket(): Promise<string> {
  const res = await api.post<{ ticket: string }>('/auth/ws-ticket')
  return res.data.ticket
}

// Fetches a fresh one-off ticket and opens the socket with it - tickets are
// short-lived (30s) and single-purpose, so a new one is minted per connect
// rather than reused across reconnects.
export async function connectVoiceSocket(threadId: string): Promise<WebSocket> {
  const ticket = await getWsTicket()
  const baseURL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
  const wsURL = baseURL.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsURL}/ws/threads/${threadId}/voice?ticket=${ticket}`)
  ws.binaryType = 'blob'

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener(
      'error',
      () => reject(new Error('Voice WebSocket connection failed')),
      { once: true },
    )
  })
}
