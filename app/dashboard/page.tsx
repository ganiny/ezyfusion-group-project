import Link from "next/link"
import { redirect } from "next/navigation"

import { SignOutButton } from "@/components/app-ui"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getActorOrNull } from "@/lib/auth"
import { mytMonth } from "@/lib/billing"
import { formatSen, toSen } from "@/lib/money"
import { prisma } from "@/lib/prisma"
import { collectionsReport, overdueInvoiceCount } from "@/lib/services/reports"
import { dateToYmd, formatMonth, formatYmd } from "@/lib/time"

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number)
  const index = y * 12 + (m - 1) + delta
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`
}

export default async function DashboardPage() {
  const actor = await getActorOrNull()
  if (!actor) redirect("/login")
  if (actor.role === "tenant") redirect("/portal")

  const thisMonth = mytMonth(new Date())
  const [overdue, collections, leases] = await Promise.all([
    overdueInvoiceCount(actor),
    collectionsReport(actor, shiftMonth(thisMonth, -5), thisMonth),
    prisma.lease.findMany({
      where: { orgId: actor.orgId },
      include: { unit: { select: { name: true } }, tenant: { select: { fullName: true } } },
      orderBy: { startDate: "asc" },
    }),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard <span className="text-muted-foreground text-sm">({actor.role})</span></h1>
        <SignOutButton />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Overdue invoices</CardTitle></CardHeader>
          <CardContent className="text-3xl font-bold">{overdue}</CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader><CardTitle>Collections, last 6 months (MYT)</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {collections.map((row) => (
                  <TableRow key={row.month}>
                    <TableCell>{formatMonth(row.month)}</TableCell>
                    <TableCell className="text-right">{formatSen(row.collectedSen)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Leases</CardTitle></CardHeader>
        <CardContent>
          {leases.length === 0 ? (
            <p className="text-muted-foreground">No leases yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead className="text-right">Monthly rent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leases.map((lease) => (
                  <TableRow key={lease.id}>
                    <TableCell>
                      <Link className="underline" href={`/leases/${lease.id}`}>{lease.unit.name}</Link>
                    </TableCell>
                    <TableCell>{lease.tenant.fullName}</TableCell>
                    <TableCell>{formatYmd(dateToYmd(lease.startDate))} – {formatYmd(dateToYmd(lease.endDate))}</TableCell>
                    <TableCell className="text-right">{formatSen(toSen(lease.monthlyRentSen))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
