/**
 * Core mount-proof runner. Pure logic — no Playwright import.
 *
 * The engine talks to the page through a narrow {@link PageLike} interface
 * so unit tests can drive it with a fake Page (Vitest), while production
 * passes a real Playwright {@link import('playwright').Page}.
 */

import type {
  MountProof,
  ProofContext,
  ProofDiagnostics,
  ProofType,
} from '../types.js'

// ─── Minimal page surface — Playwright-compatible by structural typing ──────

export interface PageLike {
  /** Resolves to a "non-null" handle if the selector matches, else null. */
  $(selector: string): Promise<unknown>
  /** Returns text content of the first match, or null. */
  textContent(selector: string): Promise<string | null>
  /** Returns serialized HTML of the page. */
  content(): Promise<string>
  /** Runs a script in page context, returns its result. */
  evaluate<R>(script: string): Promise<R>
  /** Optional — present on real Playwright Page; used only by diagnostics. */
  url?(): string
  /** Optional — used by diagnostics to list DOM matches near a failed selector. */
  $$?(selector: string): Promise<unknown[]>
  $$eval?<R>(selector: string, fn: string | ((els: Element[]) => R)): Promise<R>
}

// ─── Runners ────────────────────────────────────────────────────────────────

type Runner = (page: PageLike, proof: ProofType, ctx: ProofContext) => Promise<boolean>

const RUNNERS: Record<ProofType['type'], Runner> = {
  domSelector: async (page, proof) => {
    if (proof.type !== 'domSelector') return false
    return (await page.$(proof.selector)) !== null
  },

  domTag: async (page, proof) => {
    if (proof.type !== 'domTag') return false
    return (await page.$(proof.selector)) !== null
  },

  domTextContains: async (page, proof) => {
    if (proof.type !== 'domTextContains') return false
    const handle = await page.$(proof.selector)
    if (handle === null) return false
    const text = await page.textContent(proof.selector)
    return (text ?? '').includes(proof.text)
  },

  network: async (_page, proof, ctx) => {
    if (proof.type !== 'network') return false
    const re = new RegExp(proof.urlPattern)
    const expectedStatus = proof.status ?? 200
    return ctx.requests.some(r => re.test(r.url) && r.status === expectedStatus)
  },

  console: async (_page, proof, ctx) => {
    if (proof.type !== 'console') return false
    return ctx.consoleLog.some(line => line.includes(proof.text))
  },

  eval: async (page, proof) => {
    if (proof.type !== 'eval') return false
    const result = await page.evaluate<unknown>(proof.script)
    return !!result
  },

  htmlContains: async (page, proof) => {
    if (proof.type !== 'htmlContains') return false
    const html = await page.content()
    return html.includes(proof.text)
  },
}

// ─── Error & diagnostics ────────────────────────────────────────────────────

export class MountProofError extends Error {
  readonly name = 'MountProofError'

  constructor(
    public readonly side: 'baseline' | 'target',
    public readonly failures: ProofType[],
    public readonly diagnostics: ProofDiagnostics,
  ) {
    super(formatMessage(side, failures, diagnostics))
  }
}

function formatMessage(
  side: 'baseline' | 'target',
  failures: ProofType[],
  d: ProofDiagnostics,
): string {
  const lines: string[] = []
  lines.push(`MOUNT_PROOF_FAIL on ${side}: ${failures.length} proof(s) not satisfied at ${d.pageUrl}`)
  for (const proof of failures) {
    lines.push(`  • ${describeProof(proof)}`)
  }
  if (d.closestMatches.length > 0) {
    lines.push('  Closest matches:')
    for (const { proof, matches } of d.closestMatches) {
      lines.push(`    ${describeProof(proof)} →`)
      if (matches.length === 0) {
        lines.push('      (no near matches found)')
      } else {
        for (const m of matches) lines.push(`      ${m}`)
      }
    }
  }
  return lines.join('\n')
}

function describeProof(proof: ProofType): string {
  switch (proof.type) {
    case 'domSelector':
    case 'domTag':
      return `${proof.type} \`${proof.selector}\``
    case 'domTextContains':
      return `domTextContains \`${proof.selector}\` includes ${JSON.stringify(proof.text)}`
    case 'network':
      return `network ${proof.urlPattern} (status ${proof.status ?? 200})`
    case 'console':
      return `console includes ${JSON.stringify(proof.text)}`
    case 'eval':
      return `eval \`${proof.script}\``
    case 'htmlContains':
      return `htmlContains ${JSON.stringify(proof.text)}`
  }
}

async function dumpDiagnostics(
  page: PageLike,
  failures: ProofType[],
  ctx: ProofContext,
): Promise<ProofDiagnostics> {
  const closestMatches: ProofDiagnostics['closestMatches'] = []
  for (const proof of failures) {
    if (proof.type === 'domSelector' || proof.type === 'domTag' || proof.type === 'domTextContains') {
      const matches = await collectClosestSelectorHints(page, proof.selector)
      closestMatches.push({ proof, matches })
    }
  }
  return {
    pageUrl: page.url?.() ?? '(unknown — page.url not implemented by this adapter)',
    closestMatches,
    recentRequests: ctx.requests.slice(-10),
    recentConsole: ctx.consoleLog.slice(-10),
  }
}

/**
 * Suggest near-matches for a failing selector. Best-effort and adapter-aware:
 * if the page can't run `$$eval`, returns an empty list — the error still
 * carries the rest of the diagnostics.
 */
async function collectClosestSelectorHints(page: PageLike, selector: string): Promise<string[]> {
  if (typeof page.$$eval !== 'function') return []
  // Walk back one segment at a time: `style[data-href='x']` → `style` →
  // `*[data-href]` → etc. — collect up to 5 outerHTML snippets for each step.
  const candidates = relaxSelector(selector)
  for (const candidate of candidates) {
    try {
      const matches = await page.$$eval<string[]>(
        candidate,
        ((els: Element[]) => els.slice(0, 5).map(e => e.outerHTML.slice(0, 200))) as unknown as string,
      )
      if (matches.length > 0) return matches.map(m => `[${candidate}] ${m}`)
    } catch {
      // Selector might be invalid — try next relaxation
    }
  }
  return []
}

/**
 * Produce successively looser selectors for diagnostic hints.
 * `style[data-href='header_v3']` → ['style[data-href=\'header_v3\']', 'style[data-href]', 'style']
 */
export function relaxSelector(selector: string): string[] {
  const out: string[] = [selector]
  // Strip attribute value: [foo='bar'] → [foo]
  const stripped = selector.replace(/\[([^=\]]+)=['"][^'"]+['"]\]/g, '[$1]')
  if (stripped !== selector) out.push(stripped)
  // Strip all attributes: tag[…][…] → tag
  const tagOnly = stripped.replace(/\[[^\]]+\]/g, '')
  if (tagOnly && tagOnly !== stripped) out.push(tagOnly)
  return out
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run every proof for ONE side. Throws {@link MountProofError} if any fail.
 *
 * Empty `proofs` array is a no-op — that's how a trajectory says "skip mount
 * proof on this side". It's NOT a silent pass: the caller knows it asked for
 * nothing.
 */
export async function verifyMountProof(
  side: 'baseline' | 'target',
  proofs: ProofType[],
  page: PageLike,
  ctx: ProofContext,
): Promise<void> {
  if (proofs.length === 0) return
  const failures: ProofType[] = []
  for (const proof of proofs) {
    const runner = RUNNERS[proof.type]
    if (!runner) {
      // Unknown proof type — treat as failure with a clear message.
      // This catches typos in JSON before they cause silent passes.
      failures.push(proof)
      continue
    }
    const ok = await runner(page, proof, ctx)
    if (!ok) failures.push(proof)
  }
  if (failures.length > 0) {
    const diagnostics = await dumpDiagnostics(page, failures, ctx)
    throw new MountProofError(side, failures, diagnostics)
  }
}

/**
 * Run proofs for both sides of a comparison. Convenience wrapper that runs
 * baseline first, target second, and surfaces the first failure.
 *
 * Asymmetric is normal: `{ baseline: [], target: [...] }` is the usual
 * Promova-style setup — baseline has no marker, target must have one.
 */
export async function verifyMountProofBothSides(
  proof: MountProof | undefined,
  pages: { baseline: PageLike; target: PageLike },
  ctxs: { baseline: ProofContext; target: ProofContext },
): Promise<void> {
  if (!proof) return
  await verifyMountProof('baseline', proof.baseline ?? [], pages.baseline, ctxs.baseline)
  await verifyMountProof('target', proof.target ?? [], pages.target, ctxs.target)
}
