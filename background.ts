// import axios from 'axios';
// import * as Sentry from '@sentry/browser';
// import { Integrations } from '@sentry/tracing';

import { assert, logErrors } from './src/util'
import { Message, PreviewMessage } from './src/util/messages'

// Sentry.init({
//   dsn: 'https://feec4ec7d262475e949108f183408506@o982691.ingest.sentry.io/5939619',
//   integrations: [new Integrations.BrowserTracing()],

//   // Set tracesSampleRate to 1.0 to capture 100%
//   // of transactions for performance monitoring.
//   // We recommend adjusting this value in production
//   tracesSampleRate: 1.0,
// });

// TODO: Take 1st word on page and search

async function getCrunchbaseUrl(domain: string) {
	console.log('function started')
	const options = {
		method: 'POST',
		body: JSON.stringify({
			field_ids: [
				'identifier',
				'location_identifiers',
				'short_description',
				'rank_org',
			],
			order: [
				{
					field_id: 'rank_org',
					sort: 'asc',
				},
			],
			query: [
				{
					type: 'predicate',
					field_id: 'website_url',
					operator_id: 'domain_eq',
					values: [domain],
				},
			],
			limit: 50,
		}),
		headers: { 'X-cb-user-key': process.env.CB_API_KEY! },
	}
	const data = await (
		await fetch(
			'https://api.crunchbase.com/api/v4/searches/organizations',
			options
		)
	).json()
	console.log(data)
	if (data.count === 1) {
		return `https://www.crunchbase.com/organization/${data.entities[0].properties.identifier.permalink}`
	}
}

chrome.action.onClicked.addListener(
	logErrors(async (tab) => {
		console.log('Browser action invoked', { tab })
		assert(tab?.id != null, 'Expected tab with ID')
		if (!tab.url) {
			console.log('No tab url detected')
			return
		}
		const tabDomain = new URL(tab.url).hostname
		console.log('function to be called')
		const cbUrl = await getCrunchbaseUrl(tabDomain)

		let linkUrl = new URL(
			chrome.runtime.getURL('./src/templates/company_not_found.html')
		)
		if (cbUrl) {
			linkUrl = new URL(cbUrl)
		}

		allowIframe(tab, linkUrl)

		console.log('Executing content script')
		await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			files: ['/src/content.js'],
		})
		const message: PreviewMessage = {
			method: 'preview',
			linkUrl: linkUrl.href,
		}
		await chrome.tabs.sendMessage(tab.id, message)
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
chrome.runtime.onMessage.addListener(async (message: Message, sender) => {
	assert(sender.tab != null, 'Expected sender to have tab')
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
			throw new Error('onMessage - Unknown message ' + message.method)
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

console.log(chrome.runtime.getURL(''))

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(function (info) {
	console.log('Rule matched', info)
})

/**
 * Registers `webRequest` interceptors  to make sure the specific given URL is allowed to be displayed in an iframe
 * in the given specific tab, for the lifetime of the tab.
 *
 * @param tab The tab the iframe is contained in.
 * @param sourceUrl The `src` URL of the iframe to allow.
 */
function allowIframe(tab: chrome.tabs.Tab, sourceUrl: Readonly<URL>): void {
	// The hash is dropped for webRequests and will cause the filter to never match.
	const filterUrl = urlWithoutHash(sourceUrl)

	console.log('Allowing iframe', filterUrl.href, 'in tab', tab)
	assert(tab.id != null, 'Expected tab to have ID')

	// Narrowly scope to only the requested URL in frames in the
	// requested tab to not losen security more than necessary.
	console.log('href', filterUrl.href)
	const key = iframeAllowEntryKey(tab.id, filterUrl)
	if (allowedIframes.has(key)) {
		console.log('iframe already allowed', tab.id, filterUrl.href)
		return
	}

	/** Removes listeners again */
	function disallow(): void {
		console.log('Removing webRequest listeners')
		chrome.tabs.onRemoved.removeListener(tabClosedListener)
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
	chrome.tabs.onRemoved.addListener(tabClosedListener)
}
