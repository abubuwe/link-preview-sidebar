import * as Sentry from '@sentry/browser'

export const logErrors =
	<A extends any[]>( // eslint-disable-line @typescript-eslint/no-explicit-any
		func: (...args: A) => Promise<void>
	) =>
	(...args: A): void => {
		Sentry.wrap(() => {
			func(...args).catch(console.error)
		})
	}

class AssertionError extends Error {
	public readonly name = 'AssertionError'
}

export function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new AssertionError(message)
	}
}
