import { redirect } from "next/navigation"

import { getActorOrNull } from "@/lib/auth"

export default async function Home() {
  const actor = await getActorOrNull()
  if (!actor) redirect("/login")
  redirect(actor.role === "tenant" ? "/portal" : "/dashboard")
}
