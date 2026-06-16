/**
 * Authentication adapters. Discovery hits a login wall when a protected route
 * redirects; an {@link AuthAdapter} decides whether a URL is that wall and knows
 * how to get past it.
 *
 * `formLoginAdapter` covers the plain email/password form (the common case).
 * OAuth / Firebase / passwordless flows are expected to ship as custom adapters
 * (the config phase exposes a plugin hook); they implement the same interface.
 */

import type { AuthAdapter, DiscoveryPage } from './types.js'

export interface FormLoginConfig {
  /** Matches URLs that are the login wall. */
  loginUrlPattern: RegExp
  /** Explicit login page to navigate to; defaults to wherever the redirect landed. */
  loginUrl?: string
  email: string
  password: string
  /** Defaults to `input[type="email"]`. */
  emailSelector?: string
  /** Defaults to `input[type="password"]`. */
  passwordSelector?: string
  /** Defaults to `button[type="submit"]`. */
  submitSelector?: string
  /** If set, wait for this selector after submit to confirm success. */
  successSelector?: string
  /** Wait budget for the success selector (default 10000ms). */
  successTimeoutMs?: number
}

/** Build an {@link AuthAdapter} for a standard email/password login form. */
export function formLoginAdapter(cfg: FormLoginConfig): AuthAdapter {
  const emailSel = cfg.emailSelector ?? 'input[type="email"]'
  const passwordSel = cfg.passwordSelector ?? 'input[type="password"]'
  const submitSel = cfg.submitSelector ?? 'button[type="submit"]'
  const successTimeout = cfg.successTimeoutMs ?? 10000

  return {
    isLoginUrl(url: string): boolean {
      return cfg.loginUrlPattern.test(url)
    },
    async login(page: DiscoveryPage): Promise<void> {
      if (cfg.loginUrl) await page.goto(cfg.loginUrl)
      await page.fill(emailSel, cfg.email)
      await page.fill(passwordSel, cfg.password)
      await page.click(submitSel)
      if (cfg.successSelector) await page.waitForSelector(cfg.successSelector, successTimeout)
    },
  }
}
