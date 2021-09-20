import axios from 'axios';
// import * as Sentry from '@sentry/browser';
// import { Integrations } from '@sentry/tracing';

import { assert, isOnBeforeSendHeadersOption, isOnHeadersReceivedOption, logErrors } from './src/util'
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
	const response = await axios.post('https://api.crunchbase.com/api/v4/searches/organizations', 
	{
		'field_ids': [
			'identifier',
			'location_identifiers',
			'short_description',
			'rank_org'
		],
		'order': [
			{
				'field_id': 'rank_org',
				'sort': 'asc'
			}
		],
		'query': [
			{
				'type': 'predicate',
				'field_id': 'website_url',
				'operator_id': 'domain_eq',
				'values': [
					domain
				]
			}
		],
		'limit': 50
	},
	{
		headers: { 'X-cb-user-key':  process.env.CB_API_KEY },
	});
	console.log(response);
	if (response.data.count === 1) {
		return `https://www.crunchbase.com/organization/${response.data.entities[0].properties.identifier.permalink}`
	}
}

chrome.action.onClicked.addListener(
	logErrors(async tab => {

		console.log('Browser action invoked', { tab })
		assert(tab?.id, 'Expected tab with ID')
		if (!tab.url) {
			console.log('No tab url detected')
			return
		}
		const tabDomain = new URL(tab.url).hostname
		console.log('function to be called')
		const cbUrl = await getCrunchbaseUrl(tabDomain)

		let linkUrl = new URL(chrome.runtime.getURL('./src/templates/company_not_found.html'))
		if (cbUrl) {
			linkUrl = new URL(cbUrl)
		}
		
		allowIframe(tab, linkUrl)

		console.log('Executing content script')
		await chrome.scripting.executeScript({ target: {tabId: tab.id}, files: ['/src/content.js'] })
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
	assert(tab.id, 'Expected tab to have ID')

	// Narrowly scope to only the requested URL in frames in the
	// requested tab to not losen security more than necessary.
	const requestFilter: chrome.webRequest.RequestFilter = {
		tabId: tab.id,
		urls: [filterUrl.href],
		types: ['sub_frame'],
	}
	const key = iframeAllowEntryKey(tab.id, filterUrl)
	if (allowedIframes.has(key)) {
		console.log('iframe already allowed', tab.id, filterUrl.href)
		return
	}

	const onBeforeSendHeadersListener = (
		details: chrome.webRequest.WebRequestHeadersDetails
		// eslint-disable-next-line unicorn/consistent-function-scoping
	): chrome.webRequest.BlockingResponse | undefined => {
		console.log('onBeforeSendHeaders', details.url, details)
		if (!details.requestHeaders) {
			return
		}
		const response: chrome.webRequest.BlockingResponse = {
			requestHeaders: details.requestHeaders.filter(
				// Do not reveal to the server that the page is being fetched into an iframe
				header => header.name.toLowerCase() !== 'sec-fetch-dest'
			),
		}
		console.log('filtered request', response)
		return response
	}
	// To allow the link URL to be displayed in the iframe, we need to make sure the Sec-Fetch-Dest: iframe
	// header does not get sent so the server does not reject the request.
	chrome.webRequest.onBeforeSendHeaders.addListener(
		onBeforeSendHeadersListener,
		requestFilter,
		// Firefox does not support 'extraHeaders', Chrome needs it.
		['blocking', 'requestHeaders', 'extraHeaders'].filter(isOnBeforeSendHeadersOption)
	)

	const onHeadersReceivedListener = (
		details: chrome.webRequest.WebResponseHeadersDetails
	): chrome.webRequest.BlockingResponse | undefined => {
		console.log('onHeadersReceived', details.url, details)
		if (!details.responseHeaders) {
			return
		}
		const response: chrome.webRequest.BlockingResponse = {
			responseHeaders: details.responseHeaders
				// To allow the link URL to be displayed in the iframe, we need to make sure its
				// X-Frame-Option: deny header gets removed if present.
				.filter(header => header.name.toLowerCase() !== 'x-frame-options')
				// If the server returns a CSP with frame-ancestor restrictions,
				// add the tab's URL to allowed frame ancestors.
				.map(header => {
					const name = header.name.toLowerCase()
					assert(tab.url, 'Expected tab to have URL')
					if (name === 'content-security-policy' && header.value) {
						const cspDirectives = parseCsp(header.value)
						const frameAncestorsDirective = cspDirectives.find(
							directive => directive.name === 'frame-ancestors'
						)
						if (!frameAncestorsDirective) {
							return header
						}
						frameAncestorsDirective.values = [
							...frameAncestorsDirective.values.filter(value => value !== "'none'"),
							new URL(tab.url).origin,
						]
						const updatedCsp = serializeCsp(cspDirectives)
						return { name: header.name, value: updatedCsp }
					}
					return header
				}),
		}
		console.log('filtered response', response)
		return response
	}
	chrome.webRequest.onHeadersReceived.addListener(
		onHeadersReceivedListener,
		requestFilter,
		// Firefox does not support 'extraHeaders', Chrome needs it.
		['blocking', 'responseHeaders', 'extraHeaders'].filter(isOnHeadersReceivedOption)
	)

	/** Removes listeners again */
	function disallow(): void {
		console.log('Removing webRequest listeners')
		chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceivedListener)
		chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeadersListener)
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
