import { useAuth } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'

export default function Home() {
  const { user, logout } = useAuth()

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-4">
      <p className="text-lg">
        Signed in as <span className="font-medium">{user?.email}</span>
      </p>
      <Button variant="outline" onClick={logout}>
        Log out
      </Button>
    </div>
  )
}
