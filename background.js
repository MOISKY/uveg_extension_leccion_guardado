(() => {
    'use strict';

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const sub = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, sub);
        }
        return btoa(binary);
    }

    async function fetchConFallbackCredenciales(url) {
        try {
            const resp = await fetch(url, {
                credentials: 'include',
                redirect: 'follow'
            });
            if (resp.ok || (resp.status >= 300 && resp.status < 400)) {
                return resp;
            }
            const respOmit = await fetch(url, {
                credentials: 'omit',
                redirect: 'follow'
            });
            return respOmit.ok ? respOmit : resp;
        } catch (errInclude) {
            try {
                return await fetch(url, {
                    credentials: 'omit',
                    redirect: 'follow'
                });
            } catch {
                throw errInclude;
            }
        }
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== 'UVEG_FETCH_RESOURCE' || !msg.url) {
            return false;
        }

        (async () => {
            try {
                const resp = await fetchConFallbackCredenciales(msg.url);
                const finalUrl = resp.url || msg.url;
                const contentType = resp.headers.get('content-type') || '';
                const contentDisposition = resp.headers.get('content-disposition') || '';
                const cTypeLow = contentType.toLowerCase();
                const esTextoHtml = cTypeLow.includes('text/html') || cTypeLow.includes('application/json') || cTypeLow.includes('text/plain');
                const quiereBinario = Boolean(msg.asBase64) ||
                    (!esTextoHtml && (
                        cTypeLow.includes('application/pdf') ||
                        cTypeLow.includes('application/octet-stream') ||
                        /\.pdf(?:[?#]|$)/i.test(finalUrl)
                    ));

                if (quiereBinario) {
                    const buf = await resp.arrayBuffer();
                    sendResponse({
                        ok: resp.ok,
                        status: resp.status,
                        finalUrl,
                        contentType,
                        contentDisposition,
                        isBase64: true,
                        body: arrayBufferToBase64(buf)
                    });
                } else {
                    const text = await resp.text();
                    sendResponse({
                        ok: resp.ok,
                        status: resp.status,
                        finalUrl,
                        contentType,
                        contentDisposition,
                        isBase64: false,
                        body: text
                    });
                }
            } catch (err) {
                const detalle = (err && err.message ? err.message : String(err)) + ` [${msg.url}]`;
                sendResponse({
                    ok: false,
                    status: 0,
                    finalUrl: msg.url,
                    error: detalle
                });
            }
        })();

        return true;
    });
})();
