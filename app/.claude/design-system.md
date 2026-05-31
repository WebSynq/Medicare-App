# GHW Portal — Design System & Conventions
# Place this file at: /app/.claude/design-system.md
# Read this before writing ANY frontend code.

---

## Stack
- **Framework:** Next.js 14 (App Router) — `app/` directory
- **Styling:** Tailwind CSS v3 + shadcn/ui
- **State:** Zustand (`useAuthStore`, `useAgentStore`)
- **Data fetching:** React Query (TanStack Query v5)
- **Forms:** react-hook-form + zod validation
- **Charts:** Recharts
- **Icons:** lucide-react
- **Calendar:** react-big-calendar
- **Auth store:** `app/src/lib/auth-store.ts` — `useAuthStore()`

---

## Color Tokens (Tailwind + CSS vars)

### Brand Colors
```
Navy (primary bg):   #0B1F3A  →  bg-[#0B1F3A]  or  var(--color-navy)
Blue (accent):       #1B4F8C  →  text-blue-700
Orange (highlight):  #E8730A  →  text-orange-500 / bg-orange-500
Gold (achievement):  #C9A227  →  text-yellow-600
```

### Status Colors
```
Green  (success/active):   text-green-500  /  bg-green-500/10
Red    (error/danger):     text-red-500    /  bg-red-500/10
Amber  (warning/pending):  text-amber-500  /  bg-amber-500/10
Blue   (info/neutral):     text-blue-500   /  bg-blue-500/10
```

### Dark Theme (default — portal is dark)
```
Page background:    bg-[#0B1F3A] or bg-background
Card background:    bg-card  (slightly lighter navy)
Border:             border-border
Muted text:         text-muted-foreground
```

---

## Typography Scale
```
Page title:     text-2xl font-bold text-foreground
Section header: text-lg font-semibold text-foreground
Card title:     text-base font-semibold
Body:           text-sm text-foreground
Muted:          text-sm text-muted-foreground
Label:          text-xs font-medium text-muted-foreground uppercase tracking-wider
Metric (large): text-3xl font-bold text-foreground
```

---

## Page Shell Pattern

Every authenticated page follows this structure:

```tsx
// app/src/app/(authed)/your-page/page.tsx
'use client'

import { useAuthStore } from '@/lib/auth-store'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export default function YourPage() {
  const { user, status } = useAuthStore()
  const router = useRouter()

  // Role gate (if needed)
  useEffect(() => {
    if (status === 'authed' && !ALLOWED_ROLES.includes(user?.role)) {
      router.replace('/dashboard')
    }
  }, [status, user])

  if (status === 'loading' || status === 'unknown') {
    return <PageSkeleton />
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Page Title</h1>
          <p className="text-muted-foreground text-sm">Subtitle</p>
        </div>
        <div className="flex gap-2">
          {/* Action buttons */}
        </div>
      </div>

      {/* Content */}
    </div>
  )
}
```

---

## KPI / Stat Card Pattern

```tsx
<div className="rounded-lg border bg-card p-6">
  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
    LABEL
  </p>
  <p className="text-3xl font-bold mt-1">{value}</p>
  <p className="text-xs text-muted-foreground mt-1">
    <span className={trend > 0 ? 'text-green-500' : 'text-red-500'}>
      {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}%
    </span>
    {' '}vs prior period
  </p>
</div>
```

---

## Table Pattern (shadcn/ui Table)

```tsx
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table'

<div className="rounded-lg border">
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Column</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {(data ?? []).map((row) => (
        <TableRow
          key={row.id}
          className="cursor-pointer hover:bg-muted/50"
          onClick={() => router.push(`/clients/${row.id}`)}
        >
          <TableCell>{row.field}</TableCell>
        </TableRow>
      ))}
      {(data ?? []).length === 0 && (
        <TableRow>
          <TableCell colSpan={N} className="text-center text-muted-foreground py-8">
            No records found
          </TableCell>
        </TableRow>
      )}
    </TableBody>
  </Table>
</div>
```

---

## Form Pattern (react-hook-form + zod)

```tsx
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
})

type FormData = z.infer<typeof schema>

export function MyForm() {
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', name: '' },
  })

  const onSubmit = async (data: FormData) => {
    try {
      await apiCall(data)
      toast.success('Saved')
    } catch {
      toast.error('Failed to save')
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      {/* Never use HTML <form> submit — always use Button onClick or form onSubmit */}
    </form>
  )
}
```

---

## API Client Pattern

All API calls go through `app/src/lib/api/client.ts`:

```typescript
// GET
const data = await apiClient.get<ResponseType>('/endpoint')

// POST
const result = await apiClient.post<ResponseType>('/endpoint', payload)

// PATCH
await apiClient.patch('/endpoint/id', partial)
```

All requests automatically include:
- JWT cookie (httpOnly, sent via `credentials: 'include'`)
- CSRF token header
- `NEXT_PUBLIC_BACKEND_URL` base URL

**Never** use raw `fetch()` or `axios` directly — always use the api client.

---

## React Query Pattern

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// Query
const { data, isLoading, error } = useQuery({
  queryKey: ['leads', filters],
  queryFn: () => getLeads(filters),
  refetchInterval: 60_000, // for live data
})

// Mutation + invalidation
const queryClient = useQueryClient()
const mutation = useMutation({
  mutationFn: (payload) => createLead(payload),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['leads'] })
    toast.success('Lead created')
  },
  onError: () => toast.error('Failed'),
})
```

**Query key conventions:**
```
['leads']                    — lead list
['leads', id]                — single lead
['appointments', filters]    — appointment list
['leaderboard', period]      — leaderboard
['agency-dashboard', period] — agency KPIs
['today']                    — today page actions
```

---

## Auth & Role Check Pattern

```tsx
import { useAuthStore } from '@/lib/auth-store'

const { user, status } = useAuthStore()

// Role constants (match backend exactly)
const COMMAND_CENTER_ROLES = ['owner', 'admin', 'coach', 'sales_manager', 'compliance', 'accounting']
const ADMIN_ROLES = ['owner', 'admin']
const ADMIN_OR_COMPLIANCE_ROLES = ['owner', 'admin', 'compliance', 'cyber_security', 'sales_manager']

// Role check
const isAdmin = ADMIN_ROLES.includes(user?.role ?? '')
const isSuperAdmin = user?.super_admin === true

// Impersonation banner (include on every data page)
import { ImpersonationBanner } from '@/components/ImpersonationBanner'
```

---

## Toast Pattern

```tsx
import { toast } from 'sonner'

toast.success('Saved successfully')
toast.error('Something went wrong')
toast.loading('Saving...')
```

---

## Loading / Skeleton Pattern

```tsx
import { Skeleton } from '@/components/ui/skeleton'

// While loading
if (isLoading) {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

// Empty state
if (!data || data.length === 0) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <Icon className="h-12 w-12 mb-4 opacity-50" />
      <p className="text-lg font-medium">No records yet</p>
      <p className="text-sm">Description of what goes here</p>
    </div>
  )
}
```

---

## Modal / Dialog Pattern

```tsx
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog'

<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent className="max-w-lg">
    <DialogHeader>
      <DialogTitle>Title</DialogTitle>
    </DialogHeader>
    {/* Content */}
    <DialogFooter>
      <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
      <Button onClick={handleSave} disabled={loading}>
        {loading ? 'Saving...' : 'Save'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

---

## Chart Pattern (Recharts)

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

<ResponsiveContainer width="100%" height={240}>
  <BarChart data={data ?? []}>
    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
    <YAxis tick={{ fontSize: 12 }} />
    <Tooltip />
    <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
  </BarChart>
</ResponsiveContainer>
```

**Always use `hsl(var(--primary))` for chart colors, not hardcoded hex.**

---

## Critical Rules — Never Violate

1. **Never use HTML `<form>` tags** — Claude Code will fail on form submit. Use `onSubmit` on the form element or `onClick` on buttons.
2. **All arrays must be guarded:** `(data ?? []).map(...)` — never `data.map()`
3. **Never render objects directly:** `{user}` crashes if user is an object. Use `{user?.name}` etc.
4. **No `localStorage` in artifacts** — use React state
5. **Always `credentials: 'include'`** on API calls — httpOnly cookie auth
6. **Public pages** (booking, SOA sign) — no auth wrapper, no sidebar
7. **`'use client'`** directive required on any component using hooks, state, or browser APIs

---

## File Structure

```
app/src/
  app/
    (authed)/           — authenticated pages (layout wraps auth check)
      dashboard/        — Today/Dashboard combined
      clients/          — client list + [id] profile
      appointments/
      calendar/
      applications/
      commissions/
      leaderboard/
      settings/
      admin/
        accounting/
        ops/
        import/
        team/
        super-admin/
    book/[slug]/         — PUBLIC booking page (no auth wrapper)
    leaderboard/tv/      — PUBLIC TV mode (no auth wrapper)
    auth/magic/          — magic link verify
    login/
  components/
    ui/                  — shadcn/ui components (never modify)
    sidebar/             — nav-config.ts defines all nav items + role gates
    clients/tabs/        — client profile tab components
    commissions/         — commission panel components
  lib/
    api/                 — api client + per-entity api functions
    auth-store.ts        — Zustand auth store
```
