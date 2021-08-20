import './polyfill'

import { assert, logErrors } from './util'
import { Message, PreviewMessage } from './messages'

// TODO: Take 1st word on page and search

browser.browserAction.onClicked.addListener(
	logErrors(async tab => {
		console.log('Page action invoked', { tab })
		assert(tab?.id, 'Expected tab with ID')
		if (!tab.url) {
			console.log('No tab url detected')
			return
		}
		const linkUrl = new URL('https://www.crunchbase.com/organization/rapidapi')

		allowIframe(tab, linkUrl)

		console.log('Executing content script')
		await browser.tabs.executeScript({ file: '/src/content.js' })
		const message: PreviewMessage = {
			method: 'preview',
			linkUrl: linkUrl.href,
		}
		await browser.tabs.sendMessage(tab.id, message)
	})
)

/**
 * Map from tabId:URL to function that removes all webRequest listeners again.
 * Keeps track of allowed iframes to not double-register listeners.
 */
const allowedIframes = new Map<string, () => void>()
const iframeAllowEntryKey = (tabId: number, sourceUrl: Readonly<URL>): string =>
	`${tabId}:${urlWithoutHash(sourceUrl).href}`

// Register message listener to support alt-clicking links
// eslint-disable-next-line @typescript-eslint/require-await
browser.runtime.onMessage.addListener(async (message: Message, sender) => {
	assert(sender.tab, 'Expected sender to have tab')
	const linkUrl = new URL(message.linkUrl)
	switch (message.method) {
		case 'allowIframe': {
			allowIframe(sender.tab, linkUrl)
			return
		}
		case 'disallowIframe': {
			if (!sender.tab.id) {
				return
			}
			// Call cleanup function that unregisters all webRequest listeners
			allowedIframes.get(iframeAllowEntryKey(sender.tab.id, linkUrl))?.()
			return
		}
		default: {
			throw new Error('Unknown message ' + message.method)
		}
	}
})

/**
 * Removes the `#` fragment from a URL.
 */
function urlWithoutHash(url: Readonly<URL>): Readonly<URL> {
	const noHash = new URL(url.href)
	noHash.hash = ''
	return noHash
}

/**
 * Registers `webRequest` interceptors  to make sure the specific given URL is allowed to be displayed in an iframe
 * in the given specific tab, for the lifetime of the tab.
 *
 * @param tab The tab the iframe is contained in.
 * @param sourceUrl The `src` URL of the iframe to allow.
 */
function allowIframe(tab: browser.tabs.Tab, sourceUrl: Readonly<URL>): void {
	// The hash is dropped for webRequests and will cause the filter to never match.
	const filterUrl = urlWithoutHash(sourceUrl)

	console.log('Allowing iframe', filterUrl.href, 'in tab', tab)
	assert(tab.id, 'Expected tab to have ID')

	// Narrowly scope to only the requested URL in frames in the
	// requested tab to not losen security more than necessary.
	const requestFilter: browser.webRequest.RequestFilter = {
		tabId: tab.id,
		urls: [filterUrl.href],
		types: ['sub_frame'],
	}
	const key = iframeAllowEntryKey(tab.id, filterUrl)
	if (allowedIframes.has(key)) {
		console.log('iframe already allowed', tab.id, filterUrl.href)
		return
	}

	/** Removes listeners again */
	function disallow(): void {
		console.log('Removing webRequest listeners')
		browser.tabs.onRemoved.removeListener(tabClosedListener)
		allowedIframes.delete(key)
	}
	allowedIframes.set(key, disallow)

	// Remove listeners again when tab is closed
	const tabId = tab.id
	function tabClosedListener(removedTabId: number): void {
		if (removedTabId === tabId) {
			disallow()
		}
	}
	browser.tabs.onRemoved.addListener(tabClosedListener)
}

interface CspDirective {
	name: string
	values: string[]
}

function parseCsp(csp: string): CspDirective[] {
	return csp.split(/\s*;\s*/).map(directive => {
		const [name, ...values] = directive.split(/\s+/)
		if (!name) {
			throw new Error(`Invalid CSP directive: ${directive}`)
		}
		return { name, values }
	})
}

function serializeCsp(cspDirectives: CspDirective[]): string {
	return cspDirectives.map(({ name, values }) => [name, ...values].join(' ')).join('; ')
}
