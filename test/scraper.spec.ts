import { PuppeteerScraper, PageContent } from '../src/index'

/**
 * These tests exercise scrapePage's resource-cleanup guarantees WITHOUT launching
 * Chromium. openNewPage / navigateToPage / getContent are stubbed via jest.spyOn on
 * the instance, and the internal `pages` / `pageTimestamps` Maps are asserted directly
 * through an `as any` cast (they are private but real at runtime).
 */

interface FakePage {
  close: jest.Mock<Promise<void>, []>
}

function makeFakePage(closeImpl?: () => Promise<void>): FakePage {
  return {
    close: closeImpl ? jest.fn(closeImpl) : jest.fn().mockResolvedValue(undefined)
  }
}

const FAKE_CONTENT: PageContent = {
  metadata: { title: 'Test Title' },
  content: { text: 'hello world' } as any
}

function pagesMap(scraper: PuppeteerScraper): Map<string, unknown> {
  return (scraper as any).pages as Map<string, unknown>
}

function timestampsMap(scraper: PuppeteerScraper): Map<string, number> {
  return (scraper as any).pageTimestamps as Map<string, number>
}

describe('PuppeteerScraper.scrapePage resource cleanup', () => {
  const url = 'https://example.com/article'

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  test('(a) navigation failure returns undefined, closes the page, leaves pages Map empty', async () => {
    const scraper = new PuppeteerScraper({ cacheSize: 10 })
    const fakePage = makeFakePage()

    jest.spyOn(scraper as any, 'openNewPage').mockResolvedValue(fakePage)
    jest.spyOn(scraper, 'navigateToPage').mockRejectedValue(new Error('Navigation timeout'))
    const getContentSpy = jest.spyOn(scraper, 'getContent')

    const result = await scraper.scrapePage(url)

    expect(result).toBeUndefined()
    expect(fakePage.close).toHaveBeenCalledTimes(1)
    expect(getContentSpy).not.toHaveBeenCalled()
    expect(pagesMap(scraper).size).toBe(0)
    expect(timestampsMap(scraper).size).toBe(0)
  })

  test('(b) success returns content, empties the Map, and second call is served from cache', async () => {
    const scraper = new PuppeteerScraper({ cacheSize: 10 })
    const fakePage = makeFakePage()

    const openSpy = jest.spyOn(scraper as any, 'openNewPage').mockResolvedValue(fakePage)
    jest.spyOn(scraper, 'navigateToPage').mockResolvedValue(undefined)
    jest.spyOn(scraper, 'getContent').mockResolvedValue(FAKE_CONTENT)

    const first = await scraper.scrapePage(url)

    expect(first).toEqual(FAKE_CONTENT)
    expect(fakePage.close).toHaveBeenCalledTimes(1)
    expect(pagesMap(scraper).size).toBe(0)
    expect(timestampsMap(scraper).size).toBe(0)
    expect(openSpy).toHaveBeenCalledTimes(1)

    const second = await scraper.scrapePage(url)

    expect(second).toEqual(FAKE_CONTENT)
    // Served from cache: no additional page was opened.
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(pagesMap(scraper).size).toBe(0)
  })

  test('(c) page.close() rejecting still leaves the pages Map at size 0', async () => {
    const scraper = new PuppeteerScraper({ cacheSize: 10 })
    const fakePage = makeFakePage(() => Promise.reject(new Error('close timeout')))

    jest.spyOn(scraper as any, 'openNewPage').mockResolvedValue(fakePage)
    jest.spyOn(scraper, 'navigateToPage').mockResolvedValue(undefined)
    jest.spyOn(scraper, 'getContent').mockResolvedValue(FAKE_CONTENT)

    const result = await scraper.scrapePage(url)

    expect(result).toEqual(FAKE_CONTENT)
    expect(fakePage.close).toHaveBeenCalledTimes(1)
    expect(pagesMap(scraper).size).toBe(0)
    expect(timestampsMap(scraper).size).toBe(0)
  })

  test('(d) two concurrent scrapes of the SAME url close both pages, Map ends at size 0', async () => {
    const scraper = new PuppeteerScraper({ cacheSize: 10 })
    const fakePageA = makeFakePage()
    const fakePageB = makeFakePage()

    jest
      .spyOn(scraper as any, 'openNewPage')
      .mockResolvedValueOnce(fakePageA)
      .mockResolvedValueOnce(fakePageB)

    // Hold navigation open until both pages are registered so their Map entries
    // genuinely coexist, proving the unique-id keying prevents overwrite/orphan.
    let releaseNav: () => void = () => {}
    const navGate = new Promise<void>((resolve) => {
      releaseNav = resolve
    })

    // Resolves once navigateToPage has been entered by both calls, which only
    // happens after each call has registered its page in the Maps. This avoids
    // guessing microtask-tick counts.
    let navEnteredCount = 0
    let bothEntered: () => void = () => {}
    const bothNavEntered = new Promise<void>((resolve) => {
      bothEntered = resolve
    })
    jest.spyOn(scraper, 'navigateToPage').mockImplementation(async () => {
      navEnteredCount++
      if (navEnteredCount === 2) bothEntered()
      await navGate
    })
    jest.spyOn(scraper, 'getContent').mockResolvedValue(FAKE_CONTENT)

    const p1 = scraper.scrapePage(url)
    const p2 = scraper.scrapePage(url)

    // Both pages are registered before navigation resolves.
    await bothNavEntered
    expect(pagesMap(scraper).size).toBe(2)

    releaseNav()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toEqual(FAKE_CONTENT)
    expect(r2).toEqual(FAKE_CONTENT)
    expect(fakePageA.close).toHaveBeenCalledTimes(1)
    expect(fakePageB.close).toHaveBeenCalledTimes(1)
    expect(pagesMap(scraper).size).toBe(0)
    expect(timestampsMap(scraper).size).toBe(0)
  })

  test('(e) stale sweep closes a page older than maxPageAgeMs on the next scrapePage call', async () => {
    const scraper = new PuppeteerScraper({ cacheSize: 10, maxPageAgeMs: 1000 })

    // Inject a stale registered page directly into the internal Maps with an old timestamp.
    const staleId = 'stale-page-id'
    const stalePage = makeFakePage()
    pagesMap(scraper).set(staleId, stalePage)
    timestampsMap(scraper).set(staleId, Date.now() - 5000) // 5s old, exceeds 1s max age

    // A fresh, healthy scrape for a different URL.
    const freshPage = makeFakePage()
    jest.spyOn(scraper as any, 'openNewPage').mockResolvedValue(freshPage)
    jest.spyOn(scraper, 'navigateToPage').mockResolvedValue(undefined)
    jest.spyOn(scraper, 'getContent').mockResolvedValue(FAKE_CONTENT)

    const result = await scraper.scrapePage('https://example.com/other')

    // The stale page was swept (closed and removed) at the start of the call.
    expect(stalePage.close).toHaveBeenCalledTimes(1)
    expect(pagesMap(scraper).has(staleId)).toBe(false)
    expect(timestampsMap(scraper).has(staleId)).toBe(false)

    // The fresh scrape still succeeded and cleaned up after itself.
    expect(result).toEqual(FAKE_CONTENT)
    expect(freshPage.close).toHaveBeenCalledTimes(1)
    expect(pagesMap(scraper).size).toBe(0)
    expect(timestampsMap(scraper).size).toBe(0)
  })
})
