"use client"

import { useRouter } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/client"

export function SignOutButton() {
  const router = useRouter()
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        await createClient().auth.signOut()
        router.replace("/login")
        router.refresh()
      }}
    >
      Sign out
    </Button>
  )
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  paid: "default",
  approved: "default",
  partially_paid: "secondary",
  pending_verification: "secondary",
  pending: "secondary",
  unpaid: "outline",
  overdue: "destructive",
  rejected: "destructive",
  voided: "outline",
  failed: "destructive",
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{status.replaceAll("_", " ")}</Badge>
}

/** POSTs JSON to our own API (cookie session) and returns the parsed body or throws its error message. */
export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data ? String(data.error) : `Request failed (${res.status})`
    throw new Error(message)
  }
  return data as T
}
