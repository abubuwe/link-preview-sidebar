import * as Sentry from '@sentry/browser'

export const isOnBeforeSendHeadersOption = (value: unknown): value is chrome.webRequest.OnBeforeSendHeadersOptions =>
	Object.values<unknown>(chrome.webRequest.OnBeforeSendHeadersOptions).includes(value)

export const isOnHeadersReceivedOption = (value: unknown): value is chrome.webRequest.OnHeadersReceivedOptions =>
	Object.values<unknown>(chrome.webRequest.OnHeadersReceivedOptions).includes(value)

export const logErrors = <A extends any[]>(func: (...args: A) => Promise<void>) => (...args: A): void => {
	Sentry.wrap(() => {
		func(...args).catch(console.error)
	})
}

class AssertionError extends Error {
	public readonly name = 'AssertionError'
}

export function assert(condition: any, message: string): asserts condition {
	if (!condition) {
		throw new AssertionError(message)
	}
}
