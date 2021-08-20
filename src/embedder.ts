import { Message } from './messages'

window.addEventListener('message', event => {
	const message = event.data as Message
	switch (message.method) {
		case 'preview': {
			console.log('Received preview message in embedder frame for URL', message.linkUrl)

			// We need to recreate the iframe so that the origin is "fresh" and will send Cookies properly with SameSite=Lax.
			// For some reason updating the `src` of an existing iframe will not cause the Cookies for the updated origin to be sent.
			document.querySelector<HTMLIFrameElement>('#preview-iframe')?.remove()
			const div = document.createElement('div')
			div.id = 'preview-iframe'
			document.body.append(div)
			return
		}
		default: {
			switch (event.origin) {
				case 'https://www.crunchbase.com': {
					return
				}
				default: {
					throw new Error('Unknown message ' + message.method)
				}
			}
		}
	}
})
