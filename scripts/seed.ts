// npm run seed — creates the brief's seed data on a freshly reset database,
// through the app's own services (createLease, recordPayment, approvePayment),
// so the invoices and allocations are exactly what the app would produce.
// Env comes from .env.local via `tsx --env-file` (see package.json).

import { createClient } from '@supabase/supabase-js'

import type { Actor } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { createLease } from '@/lib/services/leases'
import { approvePayment, recordPayment } from '@/lib/services/payments'

export const SEED_PASSWORD = 'RentDemo#2026'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// 1x1 transparent PNG, used as the bank-transfer slip.
const SLIP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

async function createUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: SEED_PASSWORD, email_confirm: true })
  if (error || !data.user) throw new Error(`Could not create ${email}: ${error?.message}`)
  return data.user.id
}

async function main() {
  if ((await prisma.organization.count()) > 0) {
    throw new Error('Database is not empty. Run `npx supabase db reset` before seeding.')
  }

  const northwind = await prisma.organization.create({ data: { name: 'Northwind Properties' } })
  const beta = await prisma.organization.create({ data: { name: 'Beta Realty' } })

  const ids = {
    nwManager: await createUser('manager@northwind.test'),
    nwStaff: await createUser('staff@northwind.test'),
    aisyah: await createUser('aisyah@northwind.test'),
    ben: await createUser('ben@northwind.test'),
    probe: await createUser('probe@northwind.test'),
    betaManager: await createUser('manager@beta.test'),
    chen: await createUser('chen@beta.test'),
  }

  await prisma.membership.createMany({
    data: [
      { userId: ids.nwManager, orgId: northwind.id, role: 'manager' },
      { userId: ids.nwStaff, orgId: northwind.id, role: 'staff' },
      { userId: ids.betaManager, orgId: beta.id, role: 'manager' },
    ],
  })

  const unit = (orgId: string, name: string) => prisma.unit.create({ data: { orgId, name } })
  const units = {
    a: await unit(northwind.id, 'A-12-3'),
    b: await unit(northwind.id, 'B-05-1'),
    c: await unit(northwind.id, 'C-01-7'),
    d: await unit(northwind.id, 'D-03-2'),
    kl: await unit(beta.id, 'KL-1'),
  }

  const tenant = (orgId: string, userId: string, fullName: string, email: string) =>
    prisma.tenant.create({ data: { orgId, userId, fullName, email } })
  const tenants = {
    aisyah: await tenant(northwind.id, ids.aisyah, 'Aisyah Rahman', 'aisyah@northwind.test'),
    ben: await tenant(northwind.id, ids.ben, 'Ben Lim', 'ben@northwind.test'),
    probe: await tenant(northwind.id, ids.probe, 'Probe Tenant', 'probe@northwind.test'),
    chen: await tenant(beta.id, ids.chen, 'Chen Wei', 'chen@beta.test'),
  }

  const nwManager: Actor = { userId: ids.nwManager, role: 'manager', orgId: northwind.id }
  const nwStaff: Actor = { userId: ids.nwStaff, role: 'staff', orgId: northwind.id }
  const betaManager: Actor = { userId: ids.betaManager, role: 'manager', orgId: beta.id }

  const aisyahLease = await createLease(nwManager, {
    unitId: units.a.id, tenantId: tenants.aisyah.id, startDate: '2026-01-31', endDate: '2026-07-15', monthlyRentSen: 150000, depositSen: 300000,
  })
  await createLease(nwManager, {
    unitId: units.b.id, tenantId: tenants.ben.id, startDate: '2026-01-01', endDate: '2026-04-15', monthlyRentSen: 100029, depositSen: 0,
  })
  await createLease(nwManager, {
    unitId: units.c.id, tenantId: tenants.probe.id, startDate: '2026-02-28', endDate: '2027-02-27', monthlyRentSen: 200000, depositSen: 400000,
  })
  await createLease(betaManager, {
    unitId: units.kl.id, tenantId: tenants.chen.id, startDate: '2026-03-15', endDate: '2027-03-14', monthlyRentSen: 220000, depositSen: 440000,
  })

  // Cash by the manager: approved and allocated immediately.
  await recordPayment(nwManager, aisyahLease.id, { amountSen: 300000, method: 'cash', receivedAt: '2026-01-31T10:00:00+08:00' })

  // Bank transfer by staff: the slip is uploaded with the STAFF user's own
  // session (exercising the Storage policies), then recorded, then approved.
  const staffClient = createClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const signIn = await staffClient.auth.signInWithPassword({ email: 'staff@northwind.test', password: SEED_PASSWORD })
  if (signIn.error) throw new Error(`Staff sign-in failed: ${signIn.error.message}`)
  const slipPath = `${northwind.id}/seed-aisyah-bank-transfer.png`
  const upload = await staffClient.storage.from('payment-slips').upload(slipPath, SLIP_PNG, { contentType: 'image/png' })
  if (upload.error) throw new Error(`Slip upload failed: ${upload.error.message}`)

  const transfer = await recordPayment(nwStaff, aisyahLease.id, {
    amountSen: 200000, method: 'bank_transfer', receivedAt: '2026-03-01T00:30:00+08:00', slipPath,
  })
  await approvePayment(nwManager, transfer.id)

  console.log(`Seeded. All accounts share the password: ${SEED_PASSWORD}`)
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
