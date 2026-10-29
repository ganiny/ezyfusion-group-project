"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { postJson } from "@/components/app-ui"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseRinggitToSen } from "@/lib/billing"
import { createClient } from "@/lib/supabase/client"
import { mytLocalInputToIso } from "@/lib/time"

const SLIP_TYPES = ["image/jpeg", "image/png", "application/pdf"]
const MAX_SLIP_BYTES = 5 * 1024 * 1024

export function RecordPaymentForm({ leaseId, orgId }: { leaseId: string; orgId: string }) {
  const router = useRouter()
  const [method, setMethod] = useState<"cash" | "bank_transfer">("cash")
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    let amountSen: number
    try {
      amountSen = parseRinggitToSen(String(form.get("amount") ?? ""))
    } catch {
      toast.error("Enter the amount in ringgit, e.g. 1,500.00")
      return
    }
    if (amountSen <= 0) return void toast.error("The amount must be more than RM 0.00")
    const received = String(form.get("receivedAt") ?? "")
    if (!received) return void toast.error("Enter the date and time the money was received (Malaysia time)")

    const supabase = createClient()
    let slipPath: string | undefined
    setPending(true)
    try {
      if (method === "bank_transfer") {
        const file = form.get("slip")
        if (!(file instanceof File) || file.size === 0) throw new Error("A bank transfer needs a slip file")
        if (!SLIP_TYPES.includes(file.type)) throw new Error("The slip must be a JPEG, PNG or PDF")
        if (file.size > MAX_SLIP_BYTES) throw new Error("The slip must be at most 5 MB")
        const path = `${orgId}/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`
        const upload = await supabase.storage.from("payment-slips").upload(path, file, { contentType: file.type })
        if (upload.error) throw new Error(`Slip upload failed: ${upload.error.message}`)
        slipPath = path
      }
      const result = await postJson<{ id: string; status: string }>(`/api/leases/${leaseId}/payments`, {
        amountSen,
        method,
        receivedAt: mytLocalInputToIso(received),
        ...(slipPath ? { slipPath } : {}),
      })
      toast.success(result.status === "approved" ? "Payment recorded and approved" : "Payment recorded; waiting for manager approval")
      formElement.reset()
      setMethod("cash")
      router.refresh()
    } catch (error) {
      // The server also removes the slip on failure; this covers network errors.
      if (slipPath) await supabase.storage.from("payment-slips").remove([slipPath])
      toast.error(error instanceof Error ? error.message : "Could not record the payment")
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="amount">Amount (RM)</Label>
        <Input id="amount" name="amount" inputMode="decimal" placeholder="1,500.00" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="method">Method</Label>
        <select
          id="method"
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          value={method}
          onChange={(e) => setMethod(e.target.value === "bank_transfer" ? "bank_transfer" : "cash")}
        >
          <option value="cash">Cash</option>
          <option value="bank_transfer">Bank transfer</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="receivedAt">Received at (Malaysia time)</Label>
        <Input id="receivedAt" name="receivedAt" type="datetime-local" required />
      </div>
      {method === "bank_transfer" ? (
        <div className="space-y-2">
          <Label htmlFor="slip">Slip (JPEG, PNG or PDF, max 5 MB)</Label>
          <Input id="slip" name="slip" type="file" accept="image/jpeg,image/png,application/pdf" required />
        </div>
      ) : null}
      <div className="md:col-span-2">
        <Button type="submit" disabled={pending}>{pending ? "Recording…" : "Record payment"}</Button>
      </div>
    </form>
  )
}

export function PaymentActions({ paymentId, status }: { paymentId: string; status: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function run(action: "approve" | "reject" | "void", reason?: string): Promise<boolean> {
    setPending(true)
    try {
      const result = await postJson<{ status: string }>(`/api/payments/${paymentId}/${action}`, reason === undefined ? {} : { reason })
      toast.success(`Payment ${result.status}`)
      router.refresh()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed")
      return false
    } finally {
      setPending(false)
    }
  }

  if (status === "pending_verification") {
    return (
      <div className="flex justify-end gap-2">
        <Button size="sm" disabled={pending} onClick={() => run("approve")}>Approve</Button>
        <ReasonDialog label="Reject" title="Reject this payment?" pending={pending} onConfirm={(r) => run("reject", r)} />
      </div>
    )
  }
  if (status === "approved") {
    return <ReasonDialog label="Void" title="Void this payment? Its allocations will be removed." pending={pending} onConfirm={(r) => run("void", r)} />
  }
  return null
}

function ReasonDialog({
  label,
  title,
  pending,
  onConfirm,
}: {
  label: string
  title: string
  pending: boolean
  onConfirm: (reason: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const tooShort = reason.trim().length < 5
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="destructive">{label}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">Reason (at least 5 characters)</Label>
          <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          {reason && tooShort ? <p className="text-destructive text-sm">The reason must be at least 5 characters.</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={pending || tooShort}
            onClick={async () => {
              if (await onConfirm(reason.trim())) {
                setOpen(false)
                setReason("")
              }
            }}
          >
            Confirm {label.toLowerCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
