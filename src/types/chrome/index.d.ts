declare namespace chrome {
	namespace webRequest {
		export enum OnBeforeSendHeadersOptions {
			'blocking',
			'requestHeaders',
			'extraHeaders',
		}
		export enum OnHeadersReceivedOptions {
			'blocking',
			'responseHeaders',
			'extraHeaders',
		}
	}
}
