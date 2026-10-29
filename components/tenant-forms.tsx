"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { postJson } from "@/components/app-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatSen } from "@/lib/money"
import { createClient } from "@/lib/supabase/client"

export function PayNowButton({ leaseId, disabled }: { leaseId: string; disabled: boolean }) {
  const [pending, setPending] = useState(false)
  const [bill, setBill] = useState<{ billId: string; amountSen: number } | null>(null)
  return (
    <div className="space-y-2">
      <Button
        disabled={disabled || pending}
        onClick={async () => {
          setPending(true)
          try {
            const created = await postJson<{ billId: string; amountSen: number }>(`/api/leases/${leaseId}/gateway-bills`)
            setBill(created)
            toast.success("Gateway bill created")
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not create the bill")
          } finally {
            setPending(false)
          }
        }}
      >
        {pending ? "Creating bill…" : "Pay now"}
      </Button>
      {bill ? (
        <div className="rounded-md border p-3 text-sm">
          <p>Bill id: <code className="break-all">{bill.billId}</code></p>
          <p>Amount: {formatSen(bill.amountSen)}</p>
          <p className="text-muted-foreground">
            In production you would now be redirected to the gateway. After paying, it returns you to{" "}
            <a className="underline" href={`/payments/return?bill_id=${encodeURIComponent(bill.billId)}`}>the return page</a>.
          </p>
        </div>
      ) : null}
    </div>
  )
}

/** Updates the tenant's own phone directly through the Data API (RLS + column grant). */
export function PhoneForm({ tenantId, phone }: { tenantId: string; phone: string | null }) {
  const router = useRouter()
  const [value, setValue] = useState(phone ?? "")
  const [pending, setPending] = useState(false)
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={async (event) => {
        event.preventDefault()
        const next = value.trim()
        if (!/^\+?[0-9][0-9 ()-]{5,29}$/.test(next)) {
          toast.error("Enter a valid phone number, e.g. +60 12-345 6789")
          return
        }
        setPending(true)
        const { error } = await createClient().from("tenants").update({ phone: next }).eq("id", tenantId)
        setPending(false)
        if (error) {
          toast.error(error.message)
          return
        }
        toast.success("Phone number updated")
        router.refresh()
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" value={value} onChange={(e) => setValue(e.target.value)} placeholder="+60 12-345 6789" />
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
    </form>
  )
}
