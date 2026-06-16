/**
 * Playwright adapter — wraps a real `Page` as a {@link DiscoveryPage}. This is
 * the only browser-touching file in the browse layer; the executor, attempt
 * machine, trigger/selector logic are all driven through the abstract interface
 * and unit-tested with a fake page. This adapter is covered by integration runs,
 * not the unit suite.
 */

import type { Page } from 'playwright'

import type { DiscoveryPage } from './types.js'

/** Wrap a Playwright `Page` so the discovery executor can drive it. */
export function playwrightDiscoveryPage(page: Page): DiscoveryPage {
  return {
    async goto(url: string): Promise<{ finalUrl: string }> {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
      return { finalUrl: page.url() }
    },
    async waitForSelector(selector: string, timeoutMs: number): Promise<boolean> {
      try {
        await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs })
        return true
      } catch {
        return false
      }
    },
    async click(selector: string): Promise<void> {
      await page.click(selector, { timeout: 10_000 })
    },
    async fill(selector: string, value: string): Promise<void> {
      await page.fill(selector, value, { timeout: 10_000 })
    },
    currentUrl(): string {
      return page.url()
    },
  }
}
