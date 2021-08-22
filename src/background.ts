import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

import './polyfill'

import { assert, isOnBeforeSendHeadersOption, isOnHeadersReceivedOption, logErrors } from './util'
import { Message, PreviewMessage } from './util/messages'

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

browser.browserAction.onClicked.addListener(
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

		let linkUrl = new URL('https://www.crunchbase.com/organization/tyk-io')
		if (cbUrl) {
			linkUrl = new URL(cbUrl)
		}
		
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

	const onBeforeSendHeadersListener = (
		details: browser.webRequest._OnBeforeSendHeadersDetails
		// eslint-disable-next-line unicorn/consistent-function-scoping
	): browser.webRequest.BlockingResponse | undefined => {
		console.log('onBeforeSendHeaders', details.url, details)
		if (!details.requestHeaders) {
			return
		}
		const response: browser.webRequest.BlockingResponse = {
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
	browser.webRequest.onBeforeSendHeaders.addListener(
		onBeforeSendHeadersListener,
		requestFilter,
		// Firefox does not support 'extraHeaders', Chrome needs it.
		['blocking', 'requestHeaders', 'extraHeaders'].filter(isOnBeforeSendHeadersOption)
	)

	const onHeadersReceivedListener = (
		details: browser.webRequest._OnHeadersReceivedDetails
	): browser.webRequest.BlockingResponse | undefined => {
		console.log('onHeadersReceived', details.url, details)
		if (!details.responseHeaders) {
			return
		}
		const response: browser.webRequest.BlockingResponse = {
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
	browser.webRequest.onHeadersReceived.addListener(
		onHeadersReceivedListener,
		requestFilter,
		// Firefox does not support 'extraHeaders', Chrome needs it.
		['blocking', 'responseHeaders', 'extraHeaders'].filter(isOnHeadersReceivedOption)
	)

	/** Removes listeners again */
	function disallow(): void {
		console.log('Removing webRequest listeners')
		browser.webRequest.onHeadersReceived.removeListener(onHeadersReceivedListener)
		browser.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeadersListener)
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
