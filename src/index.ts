import { Browser, BrowserContext, Page } from 'puppeteer'
import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { Content, extractCleanContent, log, sleep } from '@missionsquad/common'
import SuperLRU, { md5 } from 'superlru'

puppeteer.use(StealthPlugin())

export interface ScraperOptions {
  headless?: boolean
  ignoreHTTPSErrors?: boolean
  proxyUrl?: string
  blockResources?: boolean
  cacheSize: number
  enableGPU?: boolean // New option for GPU support
}

export interface Metadata {
  title: string
  author?: string
  description?: string
  keywords?: string[]
  publishDate?: string
  modifiedDate?: string
  ogTitle?: string
  ogDescription?: string
  ogImage?: string
  twitterCard?: string
  twitterTitle?: string
  twitterDescription?: string
  canonical?: string
  // Additional fields from JSON-LD
  publisher?: string
  articleSection?: string
  image?: string
  creator?: string
  url?: string
}

export interface PageContent {
  metadata: Metadata
  content: Content
}

export interface JsonLdArticle {
  '@type': string
  headline?: string
  description?: string
  dateCreated?: string
  datePublished?: string
  dateModified?: string
  author?: {
    '@type': string
    name: string
    url?: string
  }
  creator?: {
    '@type': string
    name: string
    url?: string
  }
  publisher?: {
    '@type': string
    name: string
    url?: string
  }
  keywords?: string
  articleSection?: string
  image?: string
  url?: string
}

/**
 * Improved JSON-LD extraction with better error handling
 */
export function extractJsonLd(html: string): JsonLdArticle[] {
  const jsonLdRegex = /<script\s+type="application\/ld\+json"\s*>([^<]+)<\/script>/gi
  const results: JsonLdArticle[] = []
  let match

  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      // Clean the JSON string before parsing
      const jsonString = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#8217;/g, "'")
        .replace(/\\"/g, '"')
        .trim()

      const jsonData = JSON.parse(jsonString)
      if (Array.isArray(jsonData)) {
        jsonData.forEach(item => {
          if (item['@type'] === 'NewsArticle' || item['@type'] === 'Article') {
            results.push(item)
          }
        })
      } else if (jsonData['@type'] === 'NewsArticle' || jsonData['@type'] === 'Article') {
        results.push(jsonData)
      }
    } catch (e) {
      console.error('Failed to parse JSON-LD:', e)
    }
  }

  return results
}

/**
 * Extracts value from a meta tag using improved regex
 */
export function extractMetaContent(html: string, name: string): string | undefined {
  // First try exact property/name match
  const regexExact = new RegExp(`<meta\\s+(?:content=["']([^"']*?)["']\\s+(?:name|property)=["']${name}["']|(?:name|property)=["']${name}["']\\s+content=["']([^"']*?)["'])\\s*/?>`, 'i')
  const matchExact = html.match(regexExact)
  if (matchExact) {
    return matchExact[1] || matchExact[2]
  }

  // Fallback to more flexible match
  const regex = new RegExp(`<meta[^>]*?(?:name|property)=["']${name}["'][^>]*?>`)
  const match = html.match(regex)
  if (match) {
    const contentMatch = match[0].match(/content=["']([^"']*?)["']/)
    return contentMatch?.[1]
  }

  return undefined
}

/**
 * Extracts title from HTML using improved regex
 */
export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*?>([^<]+?)<\/title>/)
  return match?.[1]?.trim() || ''
}

/**
 * Extracts canonical link with improved regex
 */
export function extractCanonical(html: string): string | undefined {
  const match = html.match(/<link[^>]*?rel=["']canonical["'][^>]*?href=["']([^"']+?)["'][^>]*?>|<link[^>]*?href=["']([^"']+?)["'][^>]*?rel=["']canonical["'][^>]*?>/)
  return match?.[1] || match?.[2]
}

/**
 * Helper function to decode HTML entities
 */
export function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x27;': "'",
    '&#x2F;': '/',
    '&#8217;': "'",
    '&#8216;': "'",
    '&#8220;': '"',
    '&#8221;': '"'
  }
  return text.replace(/&[^;]+;/g, entity => entities[entity] || entity)
}

/**
 * Extracts metadata from the page's head section and JSON-LD
 */
export async function extractMetadata(page: Page): Promise<Metadata> {
  const html = await page.content()
  const jsonLdData = extractJsonLd(html)
  const articleData = jsonLdData.find(data => data['@type'] === 'NewsArticle') || jsonLdData[0]

  // Extract and clean keywords
  const keywordsRaw = (extractMetaContent(html, 'keywords') || articleData?.keywords) ?? ''
  const keywords = (Array.isArray(keywordsRaw)
    ? keywordsRaw.map(k => decodeHtmlEntities(k.trim()))
    : keywordsRaw.split(',').map(k => decodeHtmlEntities(k.trim()))
  ).filter(k => k.trim() !== '')

  // Consolidate title from multiple sources
  const primaryTitle = decodeHtmlEntities(articleData?.headline || extractTitle(html))
  const ogTitle = decodeHtmlEntities(extractMetaContent(html, 'og:title') || '')
  const twitterTitle = decodeHtmlEntities(extractMetaContent(html, 'twitter:title') || '')
  // If primaryTitle is empty, fall back to ogTitle then twitterTitle.
  const title = primaryTitle || ogTitle || twitterTitle

  // Consolidate description from multiple sources
  const primaryDescription = decodeHtmlEntities(articleData?.description || extractMetaContent(html, 'description') || '')
  const ogDescription = decodeHtmlEntities(extractMetaContent(html, 'og:description') || '')
  const twitterDescription = decodeHtmlEntities(extractMetaContent(html, 'twitter:description') || '')
  // If primaryDescription is empty, fall back to ogDescription then twitterDescription.
  const description = primaryDescription || ogDescription || twitterDescription

  // Consolidate image ensuring it's a string (extract first element if array)
  const rawImage = articleData?.image
  const rawOgImage = extractMetaContent(html, 'og:image')
  const imageCandidate = rawImage || rawOgImage
  const image = decodeHtmlEntities(
    Array.isArray(imageCandidate) ? imageCandidate[0] : (imageCandidate || '')
  )

  const metadata: Metadata = {
    title,
    author: decodeHtmlEntities(
      articleData?.author?.name ||
      articleData?.creator?.name ||
      extractMetaContent(html, 'author') ||
      ''
    ),
    description,
    keywords: keywords.length > 0 ? keywords : undefined,
    publishDate: articleData?.datePublished || articleData?.dateCreated || extractMetaContent(html, 'article:published_time'),
    modifiedDate: articleData?.dateModified || extractMetaContent(html, 'article:modified_time'),
    image,
    canonical: extractCanonical(html),
    publisher: decodeHtmlEntities(articleData?.publisher?.name || ''),
    articleSection: articleData?.articleSection,
    creator: decodeHtmlEntities(articleData?.creator?.name || ''),
    url: articleData?.url
  }

  // Remove keys with undefined or empty string values.
  Object.keys(metadata).forEach(key => {
    const value = (metadata as { [key: string]: any })[key]
    if (value == null || (!Array.isArray(value) && value.trim() === '')) {
      delete (metadata as { [key: string]: any })[key]
    }
  });

  return metadata
}

/**
 * Main function to process scraped HTML
 */
export async function processScrapedPage(page: Page): Promise<PageContent> {
  const metadata = await extractMetadata(page)
  const pageContent = await page.content()
  const content = extractCleanContent(pageContent)

  return {
    metadata,
    content
  }
}

export class PuppeteerScraper {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private pages: Map<string, Page> = new Map()
  private cache: SuperLRU<string, PageContent>
  private readonly options: ScraperOptions

  // Resource types to block for optimization
  private readonly blockResourceType = [
    'beacon',
    'csp_report',
    'font',
    'image',
    'imageset',
    'media',
    'object',
    'texttrack',
  ]

  // Domains to block for optimization
  private readonly blockResourceName = [
    'adition',
    'adzerk',
    'analytics',
    'cdn.api.twitter',
    'clicksor',
    'clicktale',
    'doubleclick',
    'exelator',
    'facebook',
    'fontawesome',
    'splunk',
    'newrelic',
    'google-analytics',
    'googletagmanager',
  ]

  constructor(options: ScraperOptions = { cacheSize: 250 }) {
    this.options = {
      headless: true,
      ignoreHTTPSErrors: true,
      blockResources: false,
      enableGPU: false, // Default to false
      ...options
    }
    this.cache = new SuperLRU({ maxSize: this.options.cacheSize, compress: true })
  }

  async init(): Promise<void> {
    try {
      const launchOptions: any = {
        headless: this.options.headless ? 'new' : false, // Use new headless mode
        ignoreHTTPSErrors: this.options.ignoreHTTPSErrors,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-zygote',
          '--disable-extensions',
          '--disable-accelerated-2d-canvas',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-domain-reliability',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-notifications',
          '--disable-offer-store-unmasked-wallet-cards',
          '--disable-popup-blocking',
          '--disable-print-preview',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--disable-speech-api',
          '--disable-sync',
          '--hide-scrollbars',
          '--ignore-certificate-errors',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--password-store=basic',
          '--use-mock-keychain',
        ],
        protocolTimeout: 30000,
      }

      // Configure GPU settings based on option
      if (!this.options.enableGPU) {
        launchOptions.args.push('--disable-gpu')
      } else {
        // Enable GPU acceleration features with more stable settings
        launchOptions.args.push(
          '--enable-gpu-rasterization',
          '--enable-zero-copy',
        )
      }

      if (this.options.proxyUrl) {
        launchOptions.args.push(`--proxy-server=${this.options.proxyUrl}`)
      }

      this.browser = await puppeteer.launch(launchOptions)
      // Create a new browser context
      this.context = await this.browser.createBrowserContext()
      
    } catch (error) {
      await this.closeBrowser() // Ensure cleanup on error
      throw new Error(`Failed to initialize browser: ${(error as Error).message}`)
    }
    log({ level: 'debug', msg: 'PuppeteerScraper initialized' })
  }

  private async openNewPage(): Promise<Page> {
    if (!this.context) throw new Error('Browser context not initialized')
    const page = await this.context.newPage()
    if (page == null) {
      throw new Error('Failed to create new page')
    }
    // Set default timeout
    page.setDefaultTimeout(30000)
    page.setDefaultNavigationTimeout(30000)

    if (this.options.blockResources) {
      await page.setRequestInterception(true)
      page.on('request', request => {
        const requestUrl = request.url().split('?')[0]
        if (
          this.blockResourceType.includes(request.resourceType()) ||
          this.blockResourceName.some(resource => requestUrl.includes(resource))
        ) {
          request.abort()
        } else {
          request.continue()
        }
      })
    }
    return page
  }

  private async scrollHeight(id: string) {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    const scrollHeight = await page.evaluate('document.body.scrollHeight')
    if (scrollHeight == null) {
      return 0
    }
    if (typeof scrollHeight === 'string') {
      return parseInt(scrollHeight, 10)
    }
    if (typeof scrollHeight === 'number') {
      return scrollHeight
    }
    return 0
  }

  async navigateToPage(
    id: string,
    url: string,
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2' = 'domcontentloaded'
  ): Promise<void> {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    log({ level: 'info', msg: `Scraping page: ${url}` })
    try {
      await page.goto(url, { waitUntil })
    } catch (error) {
      throw new Error(`Failed to navigate to ${url}: ${(error as Error).message}`)
    }
  }

  async waitForSelector(id: string, selector: string, timeout: number = 5000): Promise<void> {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    await page.waitForSelector(selector, { timeout })
  }

  async scrollToBottom(id: string): Promise<void> {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    let prevHeight = -1
    let currentHeight = await this.scrollHeight(id)
    while (prevHeight !== currentHeight) {
      prevHeight = currentHeight
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
      await sleep(1000)
      currentHeight = await this.scrollHeight(id)
    }
  }

  async click(id: string, selector: string): Promise<void> {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    await page.click(selector)
  }

  async type(id: string, selector: string, text: string, delay: number = 100): Promise<void> {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    await page.type(selector, text, { delay })
  }

  async getContent(id: string): Promise<{ metadata: Metadata; content: Content }> {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    return processScrapedPage(page)
  }

  async evaluate<T = any>(
    id: string,
    pageFunction: string | (((...args: any[]) => T) | string),
    ...args: any[]
  ): Promise<T> {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    return page.evaluate(pageFunction as any, ...args) as T
  }

  async closePage(id: string): Promise<void> {
    const page = this.pages.get(id)
    if (page) {
      try {
        await page.close()
        this.pages.delete(id)
        log({ level: 'debug', msg: `Closed page ${id}` })
      } catch (error) {
        log({ level: 'error', msg: `Error cleaning up page: ${error}` })
      }
    }
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }

  async scrapeInfiniteScroll<T>(
    id: string,
    selector: string,
    extractData: (element: Element) => T,
    maxScrolls: number = 10
  ): Promise<T[]> {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    const results: T[] = []
    let scrollCount = 0

    while (scrollCount < maxScrolls) {
      // Extract current data
      const newData = await page.$$eval(
        selector,
        (elements, extractor) => elements.map(el => extractor(el)),
        extractData
      )
      results.push(...newData)

      // Scroll and check if we've reached the bottom
      const isBottom = await this.scrollOnce(id)
      if (!isBottom) break
      scrollCount++
      await sleep(1000)
    }

    return results
  }

  private async scrollOnce(id: string): Promise<boolean> {
    const page = this.pages.get(id)
    if (!page) throw new Error('Page not initialized')
    const prevHeight = await this.scrollHeight(id)
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
    await sleep(1000)
    const newHeight = await this.scrollHeight(id)
    return newHeight !== prevHeight
  }

  public async scrapePage(url: string) {
    const id = md5(url)
    const cached = await this.cache.get(id)
    if (cached) return cached
    try {
      const page = await this.openNewPage()
      this.pages.set(id, page)
      await this.navigateToPage(id, url, 'networkidle0')
      const pageContent = await this.getContent(id)
      await this.closePage(id)
      await this.cache.set(id, pageContent)
      return pageContent
    } catch (err) {
      log({ level: 'error', msg: `Error scraping page: ${err}` })
      return undefined
    }
  }
}