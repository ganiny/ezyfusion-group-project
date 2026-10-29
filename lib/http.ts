import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

/** An error that maps directly to an HTTP status and `{ error }` body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status })
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HttpError) return json({ error: error.message }, error.status)
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    return json({ error: `Invalid input. ${where}${issue?.message ?? ''}`.trim() }, 400)
  }
  // Log the message only; never request bodies or secrets.
  console.error('Unhandled error:', error instanceof Error ? error.message : 'unknown error')
  return json({ error: 'Internal server error' }, 500)
}

/** Wraps a route handler so thrown HttpError/ZodError become `{ error }` responses. */
export function route<Ctx>(handler: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await handler(req, ctx)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON')
  }
}
