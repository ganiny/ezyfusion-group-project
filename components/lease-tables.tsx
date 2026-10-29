import { StatusBadge } from "@/components/app-ui"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatSen } from "@/lib/money"
import type { LeaseDetail } from "@/lib/services/leases"
import { formatMytDateTime, formatYmd } from "@/lib/time"

export function InvoicesTable({ invoices }: { invoices: LeaseDetail["invoices"] }) {
  if (invoices.length === 0) return <p className="text-muted-foreground">No invoices.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Period</TableHead>
          <TableHead>Due</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Paid</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((i) => (
          <TableRow key={i.id}>
            <TableCell>
              {i.kind === "deposit" ? "Deposit" : `#${i.periodIndex} · ${formatYmd(i.periodStart!)} – ${formatYmd(i.periodEnd!)}`}
            </TableCell>
            <TableCell>{formatYmd(i.dueDate)}</TableCell>
            <TableCell className="text-right">{formatSen(i.amountSen)}</TableCell>
            <TableCell className="text-right">{formatSen(i.paidSen)}</TableCell>
            <TableCell><StatusBadge status={i.status} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function PaymentsTable({
  payments,
  slipUrls = {},
  actions,
}: {
  payments: LeaseDetail["payments"]
  slipUrls?: Record<string, string>
  actions?: (payment: LeaseDetail["payments"][number]) => React.ReactNode
}) {
  if (payments.length === 0) return <p className="text-muted-foreground">No payments yet.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Received (MYT)</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Unapplied</TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {payments.map((p) => (
          <TableRow key={p.id}>
            <TableCell>{formatMytDateTime(p.receivedAt)}</TableCell>
            <TableCell>
              {p.method.replace("_", " ")}
              {slipUrls[p.id] ? (
                <a className="ml-2 underline" href={slipUrls[p.id]} target="_blank" rel="noreferrer">slip</a>
              ) : null}
            </TableCell>
            <TableCell className="text-right">{formatSen(p.amountSen)}</TableCell>
            <TableCell className="text-right">{formatSen(p.unappliedSen)}</TableCell>
            <TableCell><StatusBadge status={p.status} /></TableCell>
            <TableCell className="text-right">{actions?.(p)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
