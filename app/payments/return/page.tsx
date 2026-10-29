import Link from "next/link"
import { redirect } from "next/navigation"

import { StatusBadge } from "@/components/app-ui"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { leaseScope } from "@/lib/access"
import { getActorOrNull } from "@/lib/auth"
import { formatSen, toSen } from "@/lib/money"
import { prisma } from "@/lib/prisma"

// Read-only: shows the bill's real status from the database. The `paid` query
// parameter is ignored on purpose; only the signed webhook can settle a bill.
export default async function PaymentReturnPage({ searchParams }: { searchParams: Promise<{ bill_id?: string }> }) {
  const actor = await getActorOrNull()
  if (!actor) redirect("/login")
  const { bill_id: billId } = await searchParams

  const bill = billId
    ? await prisma.gatewayBill.findFirst({ where: { id: billId, lease: leaseScope(actor) }, select: { status: true, amountSen: true } })
    : null

  return (
    <Card className="mx-auto mt-10 max-w-md">
      <CardHeader><CardTitle>Payment status</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {bill ? (
          <>
            <p>Amount: {formatSen(toSen(bill.amountSen))}</p>
            <p>Status: <StatusBadge status={bill.status} /></p>
            {bill.status === "pending" ? (
              <p className="text-muted-foreground text-sm">We have not received confirmation from the gateway yet. Refresh in a moment.</p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">We could not find that bill.</p>
        )}
        <Link className="underline" href="/">Back</Link>
      </CardContent>
    </Card>
  )
}
