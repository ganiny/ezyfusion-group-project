import { redirect } from "next/navigation"

import { SignOutButton } from "@/components/app-ui"
import { InvoicesTable, PaymentsTable } from "@/components/lease-tables"
import { PayNowButton, PhoneForm } from "@/components/tenant-forms"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getActorOrNull } from "@/lib/auth"
import { formatSen } from "@/lib/money"
import { prisma } from "@/lib/prisma"
import { amountDueNowSen } from "@/lib/services/gateway"
import { getLeaseDetail } from "@/lib/services/leases"
import { formatYmd } from "@/lib/time"

export default async function PortalPage() {
  const actor = await getActorOrNull()
  if (!actor) redirect("/login")
  if (actor.role !== "tenant") redirect("/dashboard")

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: actor.tenantId } })
  const leases = await prisma.lease.findMany({
    where: { tenantId: actor.tenantId, orgId: actor.orgId },
    include: { unit: { select: { name: true } } },
    orderBy: { startDate: "asc" },
  })
  const details = await Promise.all(
    leases.map(async (lease) => ({
      unit: lease.unit.name,
      detail: await getLeaseDetail(actor, lease.id),
      dueNowSen: await amountDueNowSen(lease.id),
    })),
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Hello, {tenant.fullName}</h1>
        <SignOutButton />
      </div>

      <Card>
        <CardHeader><CardTitle>Your profile</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-muted-foreground text-sm">{tenant.email}</p>
          <PhoneForm tenantId={tenant.id} phone={tenant.phone} />
        </CardContent>
      </Card>

      {details.length === 0 ? <p className="text-muted-foreground">You have no leases.</p> : null}
      {details.map(({ unit, detail, dueNowSen }) => (
        <Card key={detail.lease.id}>
          <CardHeader>
            <CardTitle>
              {unit} · {formatYmd(detail.lease.startDate)} – {formatYmd(detail.lease.endDate)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-muted-foreground text-sm">Amount due now</p>
                <p className="text-2xl font-bold">{formatSen(dueNowSen)}</p>
              </div>
              <PayNowButton leaseId={detail.lease.id} disabled={dueNowSen <= 0} />
            </div>
            <InvoicesTable invoices={detail.invoices} />
            <h3 className="font-medium">Payments</h3>
            <PaymentsTable payments={detail.payments} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
