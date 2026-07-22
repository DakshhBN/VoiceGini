import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { isAxiosError } from 'axios'
import { AudioLines, Eye, EyeOff, Lock, Mail, Mic, Sparkles, Waves } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email, password)
      navigate('/')
    } catch (err) {
      const detail = isAxiosError(err) ? err.response?.data?.detail : undefined
      setError(typeof detail === 'string' ? detail : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid min-h-svh md:grid-cols-2">
      {/* Decorative voice-art panel - mic, radiating listening rings, and
          scattered audio iconography as the voice-first counterpart to a
          botanical/photo panel. Hidden on small screens; the form side
          carries its own compact brand mark there instead. */}
      <div className="relative hidden bg-voice-panel md:block">
        <p className="absolute top-12 left-12 font-serif text-4xl leading-none tracking-tight text-white italic">
          Voice<span className="text-white/60">Gini</span>
        </p>
        <p className="absolute top-28 left-12 max-w-56 text-sm text-white/50">
          A real-time voice AI you can talk to.
        </p>

        <AudioLines className="absolute top-14 right-16 size-8 rotate-12 text-white/20" />
        <Waves className="absolute bottom-20 left-16 size-10 rotate-3 text-white/15" />
        <Sparkles className="absolute right-20 bottom-32 size-5 text-white/20" />

        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="absolute -inset-28 rounded-full border border-white/10" />
          <div className="absolute -inset-20 rounded-full border border-white/15" />
          <div className="absolute -inset-10 rounded-full border border-white/20" />
          <span className="relative flex size-20 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-coral">
            <Mic className="size-8" />
          </span>
        </div>
      </div>

      {/* Form side */}
      <div className="flex items-center justify-center bg-background p-6 md:p-16">
        <div className="w-full max-w-sm animate-fade-in-up">
          <div className="mb-8 flex items-center gap-2.5 md:hidden">
            <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-coral">
              <Sparkles className="size-4" />
            </span>
            <span className="font-heading text-lg font-semibold tracking-tight text-foreground">
              VoiceGini
            </span>
          </div>

          <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">
            <span className="text-foreground">Log in</span>
            {' / '}
            <Link to="/register" className="hover:text-foreground">
              Sign up
            </Link>
          </p>

          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
            Welcome back
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Don't have an account?{' '}
            <Link to="/register" className="font-semibold text-primary underline-offset-4 hover:underline">
              Sign up
            </Link>
          </p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-9 pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={submitting} className="mt-2 w-full rounded-full">
              {submitting ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
