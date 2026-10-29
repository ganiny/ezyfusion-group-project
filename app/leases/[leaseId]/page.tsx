import Link from "next/link"
import { notFound, redirect } from "next/navigation"

import { InvoicesTable, PaymentsTable } from "@/components/lease-tables"
import { PaymentActions, RecordPaymentForm } from "@/components/payment-forms"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getActorOrNull } from "@/lib/auth"
import { HttpError } from "@/lib/http"
import { formatSen } from "@/lib/money"
import { prisma } from "@/lib/prisma"
import { getLeaseDetail, type LeaseDetail } from "@/lib/services/leases"
import { signedSlipUrl } from "@/lib/services/slips"
import { formatYmd } from "@/lib/time"

export default async function LeasePage({ params }: { params: Promise<{ leaseId: string }> }) {
  const actor = await getActorOrNull()
  if (!actor) redirect("/login")
  if (actor.role === "tenant") redirect("/portal")
  const { leaseId } = await params

  let detail: LeaseDetail
  try {
    // Same access check as the API: org-scoped, 404 outside it.
    detail = await getLeaseDetail(actor, leaseId)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) notFound()
    throw error
  }

  const [lease, slips] = await Promise.all([
    prisma.lease.findUniqueOrThrow({
      where: { id: leaseId },
      select: { unit: { select: { name: true } }, tenant: { select: { fullName: true } } },
    }),
    prisma.payment.findMany({ where: { leaseId, slipPath: { not: null } }, select: { id: true, slipPath: true } }),
  ])
  // Short-lived (60 s) signed URLs, generated only after the access check above.
  const slipUrls: Record<string, string> = {}
  for (const slip of slips) {
    const url = slip.slipPath ? await signedSlipUrl(slip.slipPath) : null
    if (url) slipUrls[slip.id] = url
  }

  return (
    <div className="space-y-6">
      <Link href="/dashboard" className="text-sm underline">← Dashboard</Link>
      <h1 className="text-2xl font-semibold">
        {lease.unit.name} · {lease.tenant.fullName}
      </h1>
      <p className="text-muted-foreground">
        {formatYmd(detail.lease.startDate)} – {formatYmd(detail.lease.endDate)} · {formatSen(detail.lease.monthlyRentSen)}/month · deposit{" "}
        {formatSen(detail.lease.depositSen)}
      </p>

      <Card>
        <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
        <CardContent><InvoicesTable invoices={detail.invoices} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
        <CardContent>
          <PaymentsTable
            payments={detail.payments}
            slipUrls={slipUrls}
            actions={actor.role === "manager" ? (p) => <PaymentActions paymentId={p.id} status={p.status} /> : undefined}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Record a payment</CardTitle></CardHeader>
        <CardContent>
          <RecordPaymentForm leaseId={leaseId} orgId={actor.orgId} />
        </CardContent>
      </Card>
    </div>
  )
}
