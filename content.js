(() => {
    'use strict';

    // 1. Solo permitir ejecución si corre en el contexto de la extensión de Chrome
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        return;
    }

    // 2. Evitar ejecución dentro de iframes
    if (window.top !== window.self) {
        return;
    }

    // 3. Candado global en el DOM compartido (evita doble ejecución 100%)
    if (document.documentElement.dataset.uvegGuardadoIniciada === 'true') {
        return;
    }
    document.documentElement.dataset.uvegGuardadoIniciada = 'true';

    // 4. Configuración de API Cloud y Supabase Storage
    const API_BASE_URL = 'https://planificador-personal-production-jm5erh.laravel.cloud/api/contabilidad';
    const SUPABASE_URL = 'https://yrdovjgddnjkgwommbqp.supabase.co';
    const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyZG92amdkZG5qa2d3b21tYnFwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MjM4NjQ2MCwiZXhwIjoyMTA3OTYyNDYwfQ.WQRcXW5GEF-tfvofJwQpVHqAp6DxiGXftAEmaC-wbsg';
    const SUPABASE_BUCKET = 'lecciones-scorm';

    const hostname = window.location.hostname.toLowerCase();
    const esDominioValido = hostname.endsWith('uveg.edu.mx') ||
                            hostname === 'localhost' ||
                            hostname === '127.0.0.1' ||
                            window.location.protocol === 'file:';

    if (!esDominioValido) {
        return;
    }

    // 5. Evitar ejecución dentro de páginas internas del reproductor SCORM (solo operar desde la vista del curso o si salta directamente a un PDF)
    if (/\/mod\/scorm\/|\/mod_scorm\//i.test(window.location.pathname)) {
        return;
    }

    const HOSTS_GENIALLY = ['view.genial.ly', 'view.genially.com', 'genial.ly', 'genially.com'];
    const HOSTS_YOUTUBE = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'];
    const ID_HOST = 'uveg-guardado-notif-host';
    const SIN_TITULO = '(sin título)';
    const REGEX_CODIGO_LECCION = /(?:LEC[_-]?L|[A-Z0-9]+_L|_L|L[_-]|LECCION[_-]?\s*|\bL)[_-]?0*(\d+)(?!\d)/i;
    const REGEX_NUMERO_PLECCION = /lecci[oó]n\s*0*(\d+)(?!\d)/i;
    const STORAGE_KEY_MODULO = 'uveg_ultimo_modulo_id';
    const STORAGE_KEY_MODULO_NOMBRE = 'uveg_ultimo_modulo_nombre';
    const STORAGE_KEY_MAPA_LECCIONES = 'uveg_mapa_pleccion_';

    let sincronizando = false;
    let yaProcesado = false;
    let itemsAcumulados = [];
    let escaneandoSecciones = false;

    // --- MIME TYPES & SLUG PARA SUPABASE ---

    function getMimeType(filename) {
        const ext = (filename || '').split('?')[0].split('#')[0].split('.').pop().toLowerCase();
        const map = {
            'html': 'text/html',
            'htm': 'text/html',
            'pdf': 'application/pdf',
            'js': 'application/javascript',
            'css': 'text/css',
            'json': 'application/json',
            'xml': 'application/xml',
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'gif': 'image/gif',
            'svg': 'image/svg+xml',
            'webp': 'image/webp',
            'mp3': 'audio/mpeg',
            'wav': 'audio/wav',
            'mp4': 'video/mp4',
            'woff': 'font/woff',
            'woff2': 'font/woff2',
            'ttf': 'font/ttf',
            'vtt': 'text/vtt'
        };
        return map[ext] || 'application/octet-stream';
    }

    function crearSlug(texto) {
        if (!texto) return 'leccion_' + Date.now();
        return texto.toString()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .toLowerCase()
            .substring(0, 80);
    }

    function extraerNumeroLeccion(texto) {
        if (!texto) return null;
        const mPLec = String(texto).match(REGEX_NUMERO_PLECCION);
        if (mPLec) return parseInt(mPLec[1], 10);
        const m = String(texto).match(REGEX_CODIGO_LECCION);
        return m ? parseInt(m[1], 10) : null;
    }

    function esUrlPdfDirecto(urlStr) {
        if (!urlStr) return false;
        return /\.pdf(?:[?#]|$)/i.test(String(urlStr).trim());
    }

    function extraerNombreArchivoPdf(urlStr) {
        if (!urlStr) return null;
        try {
            const u = new URL(urlStr, window.location.origin);
            const partes = u.pathname.split('/').filter(Boolean);
            const ultimo = partes.length > 0 ? decodeURIComponent(partes[partes.length - 1]) : '';
            if (/\.pdf$/i.test(ultimo)) {
                return ultimo;
            }
        } catch {}
        const m = String(urlStr).match(/\/([^/?#]+\.pdf)(?:[?#]|$)/i);
        if (m) {
            try { return decodeURIComponent(m[1]); } catch { return m[1]; }
        }
        return null;
    }

    // --- NORMALIZACIÓN PARA DEDUPLICACIÓN EXACTA ---

    function normalizarTextoSimple(txt) {
        if (!txt) return '';
        return String(txt)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    function obtenerNombreDesdeDisposition(disposition) {
        if (!disposition) return null;
        const mUtf = disposition.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i);
        if (mUtf && mUtf[1]) {
            try { return decodeURIComponent(mUtf[1].trim().replace(/^["']|["']$/g, '')); } catch {}
        }
        const mStd = disposition.match(/filename\s*=\s*["']?([^"';\r\n]+)["']?/i);
        if (mStd && mStd[1]) {
            return mStd[1].trim();
        }
        return null;
    }

    function base64ToBlob(b64, contentType = 'application/octet-stream') {
        const bin = atob(b64 || '');
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        return new Blob([bytes], { type: contentType || 'application/octet-stream' });
    }

    function fetchPorBackground(url, asBase64 = false) {
        return new Promise((resolve, reject) => {
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
                reject(new Error('Background fetch no disponible'));
                return;
            }
            chrome.runtime.sendMessage(
                { type: 'UVEG_FETCH_RESOURCE', url, asBase64 },
                (resp) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (!resp || !resp.ok) {
                        reject(new Error((resp && resp.error) || `HTTP ${(resp && resp.status) || 0}`));
                        return;
                    }
                    resolve(resp);
                }
            );
        });
    }

    async function fetchSeguroRecurso(url, asBase64 = false) {
        let esCrossOrigin = false;
        try {
            const u = new URL(url, window.location.href);
            esCrossOrigin = u.origin !== window.location.origin;
        } catch {}

        if (esCrossOrigin && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            const respBg = await fetchPorBackground(url, asBase64);
            const blob = respBg.isBase64 ? base64ToBlob(respBg.body, respBg.contentType) : null;
            const text = !respBg.isBase64 ? (respBg.body || '') : null;
            return {
                ok: true,
                finalUrl: respBg.finalUrl || url,
                contentType: respBg.contentType || '',
                contentDisposition: respBg.contentDisposition || '',
                blob,
                text
            };
        }

        try {
            const res = await fetchConReintento(url, { credentials: 'include' }, 2, 450);
            const finalUrl = res.url || url;
            const contentType = res.headers.get('content-type') || '';
            const contentDisposition = res.headers.get('content-disposition') || '';
            const cTypeLow = contentType.toLowerCase();
            const esTextoHtml = cTypeLow.includes('text/html') || cTypeLow.includes('application/json') || cTypeLow.includes('text/plain');
            const esBinario = asBase64 ||
                (!esTextoHtml && (
                    cTypeLow.includes('application/pdf') ||
                    cTypeLow.includes('octet-stream') ||
                    /\.pdf(?:[?#]|$)/i.test(finalUrl)
                ));

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            if (esBinario) {
                const blob = await res.blob();
                return { ok: true, finalUrl, contentType, contentDisposition, blob, text: null };
            }
            const text = await res.text();
            return { ok: true, finalUrl, contentType, contentDisposition, blob: null, text };
        } catch (errDirecto) {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                const respBg = await fetchPorBackground(url, asBase64);
                const blob = respBg.isBase64 ? base64ToBlob(respBg.body, respBg.contentType) : null;
                const text = !respBg.isBase64 ? (respBg.body || '') : null;
                return {
                    ok: true,
                    finalUrl: respBg.finalUrl || url,
                    contentType: respBg.contentType || '',
                    contentDisposition: respBg.contentDisposition || '',
                    blob,
                    text
                };
            }
            throw errDirecto;
        }
    }

    function extraerGoogleDriveId(urlStr) {
        if (!urlStr) return null;
        try {
            const u = new URL(urlStr, window.location.href);
            const h = u.hostname.toLowerCase();
            if (h !== 'drive.google.com' && h !== 'docs.google.com' && h !== 'drive.usercontent.google.com') {
                return null;
            }
            const mPath = u.pathname.match(/\/(?:file|document|presentation|spreadsheets)\/d\/([a-zA-Z0-9_-]{15,})/i);
            if (mPath && mPath[1]) return mPath[1];
            const qId = u.searchParams.get('id');
            if (qId && /^[a-zA-Z0-9_-]{15,}$/.test(qId)) return qId;
        } catch {}
        return null;
    }

    function esUrlGoogleDrive(urlStr) {
        return Boolean(extraerGoogleDriveId(urlStr));
    }

    function construirUrlDrivePreview(fileId) {
        return `https://drive.google.com/file/d/${fileId}/preview`;
    }

    function construirUrlDriveDownload(fileId) {
        return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
    }

    function extraerYoutubeId(urlStr) {
        if (!urlStr) return null;
        try {
            const u = new URL(urlStr, window.location.href);
            const h = u.hostname.toLowerCase();
            const esYtHost = HOSTS_YOUTUBE.some(base => h === base || h.endsWith('.' + base));
            if (!esYtHost) return null;

            let cand = null;
            if (h === 'youtu.be' || h.endsWith('.youtu.be')) {
                cand = u.pathname.split('/').filter(Boolean)[0] || null;
            } else {
                const vParam = u.searchParams.get('v') || u.searchParams.get('vi');
                if (vParam) {
                    cand = vParam;
                } else {
                    const mPath = u.pathname.match(/\/(?:embed|shorts|v|live)\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/i);
                    if (mPath) cand = mPath[1];
                }
            }
            if (cand && /^[a-zA-Z0-9_-]{11}$/.test(cand)) {
                return cand;
            }
        } catch {
            const m = String(urlStr).match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^"'\s#]*&)?v=|embed\/|shorts\/|v\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:[?&#/]|$)/i);
            if (m && /^[a-zA-Z0-9_-]{11}$/.test(m[1])) return m[1];
        }
        return null;
    }

    function esUrlYoutube(urlStr) {
        return Boolean(extraerYoutubeId(urlStr));
    }

    function construirUrlYoutubeEmbed(urlOrId) {
        const id = /^[a-zA-Z0-9_-]{11}$/.test(String(urlOrId || ''))
            ? String(urlOrId)
            : extraerYoutubeId(urlOrId);
        return id ? `https://www.youtube.com/embed/${id}` : urlOrId;
    }

    function esUrlEnlacesUveg(urlStr) {
        if (!urlStr) return false;
        try {
            const u = new URL(urlStr, window.location.href);
            return u.hostname.toLowerCase() === 'enlaces.uveg.edu.mx' &&
                   u.pathname.toLowerCase().includes('/enlaces');
        } catch {
            return /enlaces\.uveg\.edu\.mx\/enlaces/i.test(String(urlStr));
        }
    }

    function esUrlEstenografica(urlStr, textoEnlace = '') {
        if (!esUrlEnlacesUveg(urlStr)) return false;
        if (textoEnlace) {
            const txtNorm = normalizarTextoSimple(textoEnlace);
            return /estenograf|transcrip/.test(txtNorm);
        }
        return /[?&]token=/i.test(String(urlStr));
    }

    function esUrlActividadMoodleContenedor(urlStr) {
        if (!urlStr) return false;
        try {
            const u = new URL(urlStr, window.location.href);
            const h = u.hostname.toLowerCase();
            const p = u.pathname.toLowerCase();
            if (!h.endsWith('uveg.edu.mx')) return false;
            if (/action=|edit/i.test(u.search) || p.includes('modedit.php')) return false;
            return /\/mod\/(?:page|hvp|lesson|book|url)\/(?:view|embed)\.php$/i.test(p);
        } catch {
            return false;
        }
    }

    function normalizarUrl(urlStr) {
        if (!urlStr) return '';
        try {
            const ytId = extraerYoutubeId(urlStr);
            if (ytId) {
                return `https://www.youtube.com/embed/${ytId}`;
            }

            const driveId = extraerGoogleDriveId(urlStr);
            if (driveId) {
                return `https://drive.google.com/file/d/${driveId}/view`;
            }

            let u = new URL(urlStr, window.location.href);
            let h = u.hostname.toLowerCase();
            if (HOSTS_GENIALLY.some(base => h === base || h.endsWith('.' + base))) {
                h = 'view.genial.ly';
            }
            let p = u.pathname.replace(/\/+$/, '');
            const matchIdGenially = p.match(/([a-f0-9]{24})/i);
            if (matchIdGenially) {
                return `https://view.genial.ly/${matchIdGenially[1].toLowerCase()}`;
            }
            if (h === 'enlaces.uveg.edu.mx' && u.searchParams && u.searchParams.has('token')) {
                return `${u.protocol}//${h}${p.toLowerCase()}?token=${u.searchParams.get('token')}`;
            }
            if (u.searchParams && u.searchParams.has('id')) {
                return `${u.protocol}//${h}${p}?id=${u.searchParams.get('id')}`.toLowerCase();
            }
            return `${u.protocol}//${h}${p}`.toLowerCase();
        } catch {
            return urlStr.trim().toLowerCase().replace(/\/+$/, '');
        }
    }

    function normalizarTexto(txt) {
        if (!txt) return '';
        return txt.toString()
                  .normalize('NFD')
                  .replace(/[\u0300-\u036f]/g, '')
                  .replace(/[^a-zA-Z0-9\s]/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .toLowerCase();
    }

    // --- IDENTIFICACIÓN DEL MÓDULO (IdModuloUveg + Nombre H1) ---

    function obtenerIdModulo() {
        const params = new URLSearchParams(window.location.search);
        const urlId = params.get('id');
        if (urlId && urlId.trim() && /\/course\/view\.php/i.test(window.location.pathname)) {
            const idLimpio = urlId.trim();
            try { localStorage.setItem(STORAGE_KEY_MODULO, idLimpio); } catch {}
            return idLimpio;
        }
        try {
            const linkCurso = document.querySelector('a[href*="/course/view.php?id="]');
            if (linkCurso) {
                const mCurso = (linkCurso.getAttribute('href') || '').match(/[?&]id=(\d+)/i);
                if (mCurso && mCurso[1]) {
                    try { localStorage.setItem(STORAGE_KEY_MODULO, mCurso[1]); } catch {}
                    return mCurso[1];
                }
            }
        } catch {}
        try {
            const guardado = localStorage.getItem(STORAGE_KEY_MODULO);
            if (guardado && guardado.trim()) return guardado.trim();
        } catch {}
        if (urlId && urlId.trim()) {
            return urlId.trim();
        }
        return '324';
    }

    function obtenerNombreModuloH1(doc = document, idModuloFallback = '') {
        try {
            if (/\/course\/view\.php/i.test(window.location.pathname) || hostname === 'localhost' || hostname === '127.0.0.1' || window.location.protocol === 'file:') {
                const h1 = doc.querySelector('h1');
                if (h1) {
                    const txt = (h1.innerText || h1.textContent || '').replace(/\s+/g, ' ').trim();
                    if (txt.length > 1 && !/^(campus virtual|uveg)$/i.test(txt)) {
                        try { localStorage.setItem(STORAGE_KEY_MODULO_NOMBRE, txt); } catch {}
                        return txt;
                    }
                }
            }
        } catch {}
        try {
            const guardado = localStorage.getItem(STORAGE_KEY_MODULO_NOMBRE);
            if (guardado && guardado.trim()) return guardado.trim();
        } catch {}
        return idModuloFallback || obtenerIdModulo();
    }

    function esUrlGenially(urlStr) {
        if (!urlStr) return false;
        try {
            const url = new URL(urlStr, window.location.href);
            const h = url.hostname.toLowerCase();
            return HOSTS_GENIALLY.some(base => h === base || h.endsWith('.' + base));
        } catch {
            return /view\.genial\.ly|view\.genially\.com/i.test(urlStr);
        }
    }

    function esUrlRecurso(urlStr) {
        if (!urlStr) return false;
        if (esUrlGenially(urlStr)) return true;
        if (esUrlYoutube(urlStr)) return true;
        if (esUrlGoogleDrive(urlStr)) return true;
        if (esUrlEstenografica(urlStr)) return true;
        try {
            const url = new URL(urlStr, window.location.href);
            const h = url.hostname.toLowerCase();
            const p = url.pathname.toLowerCase();
            if (h.endsWith('uveg.edu.mx')) {
                if (p.includes('/mod/scorm/') || p.includes('/mod_scorm/')) return true;
                if (p.includes('/mod/resource/') || p.includes('/mod_resource/')) return true;
                if (p.endsWith('.pdf')) return true;
            }
        } catch {
            if (/mod\/scorm|mod_scorm|mod\/resource|mod_resource|\.pdf/i.test(urlStr)) return true;
        }
        return false;
    }

    function esRecursoScorm(urlStr) {
        if (!urlStr) return false;
        if (esUrlYoutube(urlStr) || esUrlGenially(urlStr)) return false;
        const u = urlStr.toLowerCase();
        return u.includes('/mod/scorm/') ||
               u.includes('/mod_scorm/') ||
               u.includes('/mod/resource/') ||
               u.includes('/mod_resource/') ||
               u.includes('scoid=') ||
               u.includes('story.html') ||
               esUrlGoogleDrive(urlStr) ||
               esUrlEstenografica(urlStr) ||
               esUrlPdfDirecto(urlStr);
    }

    // --- EXTRACCIÓN DE TÍTULOS (<p class="leccion2-pLeccion">) Y CÓDIGOS (LEC_L1, CPFI_L4, L3_Comic) ---

    function cargarMapaPLeccion(idModulo) {
        const clave = STORAGE_KEY_MAPA_LECCIONES + (idModulo || obtenerIdModulo());
        try {
            const raw = localStorage.getItem(clave);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') return parsed;
            }
        } catch {}
        return {};
    }

    function guardarMapaPLeccion(idModulo, mapa) {
        if (!mapa || typeof mapa !== 'object') return;
        const clave = STORAGE_KEY_MAPA_LECCIONES + (idModulo || obtenerIdModulo());
        try {
            const actual = cargarMapaPLeccion(idModulo);
            const combinado = { ...actual, ...mapa };
            localStorage.setItem(clave, JSON.stringify(combinado));
        } catch {}
    }

    const REGEX_GENERICO_TITULO = /^(genially|view|iframe|embedded|youtube(\s+video\s+player)?|reproductor(\s+de\s+video)?(\s+de)?\s+youtube)$/i;

    function limpiarTextoElemento(el) {
        if (!el) return '';
        try {
            const copia = el.cloneNode(true);
            if (copia.querySelectorAll) {
                copia.querySelectorAll('.accesshide, .sr-only').forEach(s => s.remove());
            }
            return (copia.innerText || copia.textContent || '').split('\n')[0].replace(/\s+/g, ' ').trim();
        } catch {
            return (el.innerText || el.textContent || '').split('\n')[0].replace(/\s+/g, ' ').trim();
        }
    }

    function extraerMapaPLeccionDeDocumento(doc = document, idModulo = '') {
        const mapa = cargarMapaPLeccion(idModulo);
        if (!doc || !doc.querySelectorAll) return mapa;

        try {
            const parrafos = doc.querySelectorAll('p.leccion2-pLeccion, .leccion2-pLeccion, [class*="pLeccion"]');
            for (const p of parrafos) {
                const txt = (p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim();
                if (!txt || txt.length < 3) continue;

                let num = extraerNumeroLeccion(txt);
                if (num === null) {
                    const idAnc = extraerIdContenedorLeccion(p);
                    num = extraerNumeroLeccion(idAnc);
                }
                if (num !== null && num !== 999) {
                    mapa[String(num)] = txt;
                }
            }

            const scope = doc.querySelector('#region-main, .course-content, [role="main"]') || doc;
            const encabezados = scope.querySelectorAll('h1, h2, h3, h4');
            for (const h of encabezados) {
                if (h.closest && h.closest('nav, header, footer, #page-header, .breadcrumb, [data-region="drawer"]')) continue;
                const txt = limpiarTextoElemento(h);
                if (!txt || txt.length < 4 || /^(recursos|tiempo estimado)/i.test(txt)) continue;
                const num = extraerNumeroLeccion(txt);
                if (num !== null && num !== 999 && !mapa[String(num)]) {
                    mapa[String(num)] = txt;
                }
            }

            guardarMapaPLeccion(idModulo, mapa);
        } catch {}

        return mapa;
    }

    function obtenerEncabezadoLeccionPrecedente(el, doc = document) {
        if (!el || !doc) return '';
        try {
            const scope = (el.closest && el.closest('#region-main, .course-content, [role="main"], .box')) || doc.querySelector('#region-main, [role="main"]') || doc;
            if (!scope || !scope.querySelectorAll) return '';

            const candidatos = Array.from(scope.querySelectorAll('h1, h2, h3, h4, p.leccion2-pLeccion, .leccion2-pLeccion, [class*="pLeccion"]'));
            let ultimoNumerado = '';
            let ultimoGenerico = '';

            for (const h of candidatos) {
                if (h.closest && h.closest('nav, header, footer, #page-header, .breadcrumb, [data-region="drawer"]')) continue;
                if (h === el) break;
                const rel = h.compareDocumentPosition ? h.compareDocumentPosition(el) : 0;
                const estaAntes = Boolean(rel & Node.DOCUMENT_POSITION_FOLLOWING);
                if (!estaAntes) continue;

                const txt = limpiarTextoElemento(h);
                if (!txt || txt.length < 3 || /^(recursos|tiempo estimado|evaluaci[oó]n|actividades)/i.test(txt)) continue;

                if (REGEX_CODIGO_LECCION.test(txt) || REGEX_NUMERO_PLECCION.test(txt)) {
                    ultimoNumerado = txt;
                } else if (/^H[1-3]$/i.test(h.tagName)) {
                    ultimoGenerico = txt;
                }
            }

            return ultimoNumerado || ultimoGenerico || '';
        } catch {
            return '';
        }
    }

    function obtenerNombrePLeccion(el, doc, contenedorExplicito, numLeccion, codigoFallback, mapaPLeccion = {}) {
        try {
            const contenedor = contenedorExplicito || (el && el.closest ? el.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"]') : null);
            if (contenedor && contenedor.querySelectorAll) {
                const pList = contenedor.querySelectorAll('p.leccion2-pLeccion, .leccion2-pLeccion, [class*="pLeccion"], h2, h3');
                if (pList.length === 1) {
                    const txt = limpiarTextoElemento(pList[0]);
                    if (txt.length > 2) return txt;
                } else if (pList.length > 1 && numLeccion !== null && numLeccion !== 999) {
                    for (const p of pList) {
                        const txt = limpiarTextoElemento(p);
                        if (extraerNumeroLeccion(txt) === numLeccion) return txt;
                    }
                }
            }

            if (numLeccion !== null && numLeccion !== 999) {
                if (mapaPLeccion && mapaPLeccion[String(numLeccion)]) {
                    return mapaPLeccion[String(numLeccion)];
                }
                const guardado = cargarMapaPLeccion(obtenerIdModulo());
                if (guardado[String(numLeccion)]) {
                    return guardado[String(numLeccion)];
                }
            }

            if (el && el.closest) {
                const sec = el.closest('.activity, .activityinstance, .contentitem, .section, .box, li, div');
                if (sec && sec.querySelector) {
                    const pCercano = sec.querySelector('p.leccion2-pLeccion, .leccion2-pLeccion, [class*="pLeccion"]');
                    if (pCercano) {
                        const txt = limpiarTextoElemento(pCercano);
                        if (txt.length > 2) return txt;
                    }
                }
            }

            const encPrecedente = obtenerEncabezadoLeccionPrecedente(el, doc);
            if (encPrecedente) return encPrecedente;
        } catch {}

        return codigoFallback || SIN_TITULO;
    }

    function extraerIdContenedorLeccion(el) {
        if (!el) return '';
        try {
            let actual = el;
            while (actual && actual !== document.body && actual !== document.documentElement) {
                const idAttr = (actual.getAttribute && actual.getAttribute('id')) || actual.id || '';
                if (idAttr && REGEX_CODIGO_LECCION.test(idAttr) && !/^module-/i.test(idAttr)) {
                    return idAttr.trim();
                }
                const dataLesson = actual.getAttribute ? (actual.getAttribute('data-lesson') || actual.getAttribute('data-leccion') || '') : '';
                if (dataLesson && REGEX_CODIGO_LECCION.test(dataLesson)) {
                    return dataLesson.trim();
                }
                actual = actual.parentElement;
            }
        } catch {}
        return '';
    }

    function extraerTitulo(iframe, contextDoc = document) {
        const titleAttr = (iframe.getAttribute('title') || '').trim();
        const ariaAttr = (iframe.getAttribute('aria-label') || '').trim();
        const nameAttr = (iframe.getAttribute('name') || '').trim();

        if (titleAttr && !REGEX_GENERICO_TITULO.test(titleAttr)) return titleAttr;
        if (ariaAttr && !REGEX_GENERICO_TITULO.test(ariaAttr)) return ariaAttr;

        const idContenedor = extraerIdContenedorLeccion(iframe);
        if (idContenedor) return idContenedor;

        try {
            const actividad = iframe.closest ? iframe.closest('.container-lesson, .activity, .activityinstance, .contentitem, .section, .box, [id^="module-"]') : null;
            if (actividad) {
                const header = actividad.querySelector('.instancename, .activityname, h2, h3, h4, .mod-indent-outer');
                if (header) {
                    const textoLimpio = limpiarTextoElemento(header);
                    if (textoLimpio.length > 2 && !/^(recursos|tiempo estimado)/i.test(textoLimpio)) return textoLimpio;
                }
            }
        } catch {}

        const encPrecedente = obtenerEncabezadoLeccionPrecedente(iframe, contextDoc);
        if (encPrecedente) return encPrecedente;

        if (titleAttr && !REGEX_GENERICO_TITULO.test(titleAttr)) return titleAttr;
        if (nameAttr && !REGEX_GENERICO_TITULO.test(nameAttr)) return nameAttr;
        return SIN_TITULO;
    }

    function extraerCodigoElemento(el, contextDoc = document, contenedorExplicito = null, rawUrl = '') {
        if (!el) return SIN_TITULO;
        if (el.tagName === 'IFRAME') {
            return extraerTitulo(el, contextDoc);
        }

        try {
            const contenedor = contenedorExplicito || (el.closest ? el.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"], .activity, .activityinstance, .contentitem, .section, .box, [id^="module-"]') : null);

            if (contenedor) {
                // Si el contenedor tiene un ID de lección tipo id="LEC_L1", usarlo directamente como código
                const idCont = (contenedor.getAttribute && contenedor.getAttribute('id')) || contenedor.id || '';
                if (idCont && REGEX_CODIGO_LECCION.test(idCont) && !/^module-/i.test(idCont)) {
                    return idCont.trim();
                }
            }

            const idAncestro = extraerIdContenedorLeccion(el);
            if (idAncestro) {
                return idAncestro;
            }

            // Si la URL apunta directamente a un PDF (ej. L3_Comic.pdf), extraer el código desde el archivo
            if (rawUrl && esUrlPdfDirecto(rawUrl)) {
                const nomPdf = extraerNombreArchivoPdf(rawUrl);
                if (nomPdf) {
                    return nomPdf.replace(/\.pdf$/i, '').trim();
                }
            }

            const encPrecedente = obtenerEncabezadoLeccionPrecedente(el, contextDoc);
            if (encPrecedente) {
                return encPrecedente;
            }

            if (contenedor) {
                const tituloUveg = contenedor.querySelector('.titulo, .title, .nombre-leccion');
                if (tituloUveg) {
                    const txt = (tituloUveg.innerText || tituloUveg.textContent || '').replace(/\s+/g, ' ').trim();
                    if (txt.length > 2 && !/^(recursos|tiempo estimado)/i.test(txt)) {
                        return txt;
                    }
                }

                const header = contenedor.querySelector('.instancename, .activityname, h2, h3, h4, .mod-indent-outer');
                if (header) {
                    const txt = limpiarTextoElemento(header);
                    if (txt.length > 2 && !/^(recursos|tiempo estimado)/i.test(txt)) {
                        return txt;
                    }
                }
            }

            const titleAttr = (el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim();
            if (titleAttr && !REGEX_GENERICO_TITULO.test(titleAttr) && !/^(icono|imagen|recurso)$/i.test(titleAttr)) {
                return titleAttr.replace(/\s+/g, ' ');
            }
        } catch {}

        return SIN_TITULO;
    }

    function extraerElementoYUrlDeContenedor(cont) {
        if (!cont || !cont.querySelector) return null;

        // 1. Priorizar imagen .img-leccion (con data-link directo o envuelta en un <a>)
        const imgLeccion = cont.querySelector('.img-leccion');
        if (imgLeccion) {
            const dl = imgLeccion.getAttribute('data-link') || imgLeccion.getAttribute('href');
            if (dl && esUrlRecurso(dl)) {
                return { el: imgLeccion, rawAttr: dl };
            }
            const linkPadre = imgLeccion.closest ? imgLeccion.closest('a[href], [data-link]') : null;
            if (linkPadre && cont.contains(linkPadre)) {
                const attrPadre = linkPadre.getAttribute('data-link') || linkPadre.getAttribute('href');
                if (attrPadre && esUrlRecurso(attrPadre)) {
                    return { el: linkPadre, rawAttr: attrPadre };
                }
            }
            const onclickImg = imgLeccion.getAttribute('onclick') || '';
            const mOnclick = onclickImg.match(/['"](https?:\/\/[^'"]+|\/[^'"]+)['"]/i);
            if (mOnclick && esUrlRecurso(mOnclick[1])) {
                return { el: imgLeccion, rawAttr: mOnclick[1] };
            }
        }

        // 2. Buscar selectores de lección SCORM, mod/resource o PDF dentro del contenedor
        const selectores = [
            '.img-leccion[data-link]',
            '.img-leccion [data-link]',
            '[data-link*="/mod/scorm/"]',
            '[data-link*="/mod_scorm/"]',
            '[data-link*="/mod/resource/"]',
            '[data-link*="/mod_resource/"]',
            '[data-link*=".pdf"]',
            'a[href*="/mod/scorm/"]',
            'a[href*="/mod_scorm/"]',
            'a[href*="/mod/resource/"]',
            'a[href*="/mod_resource/"]',
            'a[href*=".pdf"]',
            '[data-link]'
        ];

        for (const sel of selectores) {
            const candidato = cont.querySelector(sel);
            if (candidato) {
                const raw = candidato.getAttribute('data-link') || candidato.getAttribute('href');
                if (raw && esUrlRecurso(raw)) {
                    return { el: candidato, rawAttr: raw };
                }
            }
        }

        const propioAttr = cont.getAttribute ? (cont.getAttribute('data-link') || cont.getAttribute('href')) : null;
        if (propioAttr && esUrlRecurso(propioAttr)) {
            return { el: cont, rawAttr: propioAttr };
        }

        return null;
    }

    function extraerUrlsYoutubeDeTexto(texto) {
        if (!texto) return [];
        const limpio = normalizarHtmlScorm(texto);
        const regexYt = /https?:\/\/(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^"'\s<>\\#]*&)?v=|embed\/|shorts\/|v\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:[^"'\s<>\\]*)?/gi;
        const ids = new Set();
        let m;
        while ((m = regexYt.exec(limpio)) !== null) {
            if (m[1] && /^[a-zA-Z0-9_-]{11}$/.test(m[1])) {
                ids.add(m[1]);
            }
        }
        return Array.from(ids);
    }

    function obtenerTituloBaseDocumentoMoodle(doc, contextoFallback = null) {
        if (contextoFallback && (contextoFallback.nombre || contextoFallback.titulo || contextoFallback.codigo)) {
            const nom = contextoFallback.nombre || contextoFallback.titulo || contextoFallback.codigo;
            if (nom && nom !== SIN_TITULO) return nom;
        }
        try {
            const scope = doc.querySelector('#region-main, [role="main"], .course-content') || doc;
            for (const sel of ['h2', 'h3', '.page-header-headings h1', 'h1']) {
                for (const h of scope.querySelectorAll(sel)) {
                    if (h.closest && h.closest('nav, header, footer, #page-header, .breadcrumb, [data-region="drawer"]')) continue;
                    const txt = limpiarTextoElemento(h);
                    if (!txt || txt.length < 3 || /^(campus virtual|uveg|recursos|tiempo estimado)$/i.test(txt)) continue;
                    if (REGEX_CODIGO_LECCION.test(txt) || REGEX_NUMERO_PLECCION.test(txt)) {
                        return txt;
                    }
                }
            }
            const primerH2 = scope.querySelector('h2, h3');
            if (primerH2) {
                const txt = limpiarTextoElemento(primerH2);
                if (txt.length > 2 && !/^(recursos|tiempo estimado)$/i.test(txt)) return txt;
            }
        } catch {}
        return SIN_TITULO;
    }

    function recolectarActividadesMoodleEnDocumento(doc = document) {
        const actividades = [];
        const vistosAct = new Set();
        if (!doc || !doc.querySelectorAll) return actividades;

        try {
            const scope = doc.querySelector('#region-main, .course-content, [role="main"]') || doc.body || doc;
            const elementos = scope.querySelectorAll('a[href], [data-link], iframe[src], iframe[data-src]');

            for (const el of elementos) {
                if (el.closest && el.closest('nav, header, footer, #page-header, .breadcrumb, [data-region="drawer"], .course-navigation, .activity-navigation')) {
                    continue;
                }
                const raw = el.getAttribute('href') || el.getAttribute('data-link') || el.getAttribute('src') || el.getAttribute('data-src');
                if (!raw || !esUrlActividadMoodleContenedor(raw)) continue;

                let absUrl = raw;
                try { absUrl = new URL(raw, window.location.href).href; } catch {}

                const norm = normalizarUrl(absUrl);
                if (vistosAct.has(norm)) continue;
                vistosAct.add(norm);

                const contPadre = el.closest ? el.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"], .activity, .activityinstance, .contentitem, li.section, .box') : null;
                let codigo = extraerCodigoElemento(el, doc, contPadre, absUrl);
                if (codigo === SIN_TITULO) {
                    const txtEl = limpiarTextoElemento(el);
                    if (txtEl && txtEl.length > 2 && !/^(entrar|abrir|ver|clic|aqui|aquí)$/i.test(txtEl)) {
                        codigo = txtEl;
                    }
                }
                const enc = obtenerEncabezadoLeccionPrecedente(el, doc);
                const num = extraerNumeroLeccion(codigo) ?? extraerNumeroLeccion(enc) ?? (contPadre ? extraerNumeroLeccion(contPadre.id) : null);
                const titulo = (enc && (REGEX_CODIGO_LECCION.test(enc) || REGEX_NUMERO_PLECCION.test(enc)))
                    ? enc
                    : (codigo !== SIN_TITULO ? codigo : obtenerTituloBaseDocumentoMoodle(doc));

                actividades.push({
                    url: absUrl,
                    codigo: codigo,
                    nombre: titulo,
                    titulo: titulo,
                    numero: num
                });
            }
        } catch {}

        return actividades;
    }

    function encontrarLeccionesEnDocumento(doc = document, contextoFallback = null, estenograficasGlobales = null) {
        const vistos = new Set();
        const encontrados = [];
        const contenedoresConGenially = new Set();
        const numerosConGenially = new Set();
        const estenograficasPorLeccion = estenograficasGlobales || new Set();
        const idModuloActual = obtenerIdModulo();

        if (doc === document) {
            obtenerNombreModuloH1(doc, idModuloActual);
        }
        const mapaPLeccion = extraerMapaPLeccionDeDocumento(doc, idModuloActual);
        const tituloDocFallback = obtenerTituloBaseDocumentoMoodle(doc, contextoFallback);

        // 0. Si el navegador dio un salto directo a un archivo PDF de UVEG (ej. .../pluginfile.php/8852/mod_resource/content/5/L3_Comic.pdf)
        if (doc === document && esUrlPdfDirecto(window.location.href)) {
            const nombrePdf = extraerNombreArchivoPdf(window.location.href) || 'Documento.pdf';
            const codigoPdf = nombrePdf.replace(/\.pdf$/i, '').trim() || 'Documento_PDF';
            const numPdf = extraerNumeroLeccion(codigoPdf);
            const nombreVisual = (numPdf !== null && mapaPLeccion[String(numPdf)])
                ? mapaPLeccion[String(numPdf)]
                : codigoPdf;
            return [{
                codigo: codigoPdf,
                nombre: nombreVisual,
                titulo: codigoPdf,
                url: window.location.href,
                numero: numPdf !== null ? numPdf : 999,
                esPdf: true
            }];
        }

        // 1. Rastreo de Iframes de Genially y YouTube (y sub-iframes del mismo origen como H5P embed)
        for (const iframe of doc.querySelectorAll('iframe')) {
            const rawSrc = iframe.getAttribute('src') || iframe.getAttribute('data-src') || iframe.src;
            if (!rawSrc) continue;

            try {
                if (doc === document && iframe.contentDocument && iframe.contentDocument.documentElement) {
                    const encIframe = obtenerEncabezadoLeccionPrecedente(iframe, doc) || tituloDocFallback;
                    const numIf = extraerNumeroLeccion(encIframe) ?? (contextoFallback ? contextoFallback.numero : null);
                    const subItems = encontrarLeccionesEnDocumento(
                        iframe.contentDocument,
                        { nombre: encIframe, titulo: encIframe, codigo: encIframe, numero: numIf },
                        estenograficasPorLeccion
                    );
                    for (const sub of subItems) {
                        const subNorm = normalizarUrl(sub.url);
                        if (!vistos.has(subNorm)) {
                            vistos.add(subNorm);
                            encontrados.push(sub);
                        }
                    }
                }
            } catch {}

            const esGenially = esUrlGenially(rawSrc);
            const ytId = extraerYoutubeId(rawSrc);
            if (!esGenially && !ytId) continue;

            let src = rawSrc;
            if (ytId) {
                src = construirUrlYoutubeEmbed(ytId);
            } else {
                try { src = new URL(rawSrc, window.location.href).href; } catch {}
            }

            let codigo = extraerTitulo(iframe, doc);
            if ((!codigo || codigo === SIN_TITULO || REGEX_GENERICO_TITULO.test(codigo)) && tituloDocFallback !== SIN_TITULO) {
                codigo = tituloDocFallback;
            }
            if (/^(english|español|saltar|salir)/i.test(codigo.trim())) continue;

            const urlNorm = normalizarUrl(src);
            if (vistos.has(urlNorm)) continue;
            vistos.add(urlNorm);

            let numCont = null;
            const contPadre = iframe.closest ? iframe.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"]') : null;
            if (contPadre) {
                if (esGenially) contenedoresConGenially.add(contPadre);
                numCont = extraerNumeroLeccion(contPadre.id);
                if (esGenially && numCont !== null) numerosConGenially.add(numCont);
            }

            const numCodigo = extraerNumeroLeccion(codigo) ?? numCont ?? (contextoFallback ? contextoFallback.numero : null);
            if (esGenially && numCodigo !== null) {
                numerosConGenially.add(numCodigo);
            }

            const nombreVisual = obtenerNombrePLeccion(iframe, doc, contPadre, numCodigo, codigo, mapaPLeccion);
            const nombreFinal = (!nombreVisual || nombreVisual === SIN_TITULO || REGEX_GENERICO_TITULO.test(nombreVisual))
                ? (tituloDocFallback !== SIN_TITULO ? tituloDocFallback : codigo)
                : nombreVisual;
            const codigoFinal = ytId
                ? (numCodigo !== null && numCodigo !== 999 ? `L${numCodigo}_Video` : `Video_${ytId}`)
                : codigo;

            encontrados.push({
                codigo: codigoFinal,
                nombre: nombreFinal,
                titulo: codigoFinal,
                url: src,
                numero: numCodigo !== null ? numCodigo : 999,
                esYoutube: Boolean(ytId)
            });
        }

        // 1b. Rastreo de YouTube incrustado en scripts H5P (H5PIntegration) u HTML de la lección
        try {
            const scripts = doc.querySelectorAll('script');
            for (const scr of scripts) {
                const contenido = scr.textContent || '';
                if (!/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(contenido)) continue;
                if (!/H5PIntegration|H5P\.YouTube|interactiveVideo|jsonContent|video/i.test(contenido)) continue;

                const idsScript = extraerUrlsYoutubeDeTexto(contenido);
                for (const ytId of idsScript) {
                    const urlEmbed = construirUrlYoutubeEmbed(ytId);
                    const urlNorm = normalizarUrl(urlEmbed);
                    if (vistos.has(urlNorm)) continue;
                    vistos.add(urlNorm);

                    const encScript = obtenerEncabezadoLeccionPrecedente(scr, doc);
                    const tituloBase = (encScript && encScript !== SIN_TITULO) ? encScript : tituloDocFallback;
                    const numYt = extraerNumeroLeccion(tituloBase) ?? (contextoFallback ? contextoFallback.numero : null);
                    const nombreVisual = (numYt !== null && mapaPLeccion[String(numYt)])
                        ? mapaPLeccion[String(numYt)]
                        : (tituloBase !== SIN_TITULO ? tituloBase : `Video_${ytId}`);
                    const codigoYt = (numYt !== null && numYt !== 999) ? `L${numYt}_Video` : `Video_${ytId}`;

                    encontrados.push({
                        codigo: codigoYt,
                        nombre: nombreVisual,
                        titulo: codigoYt,
                        url: urlEmbed,
                        numero: numYt !== null ? numYt : 999,
                        esYoutube: true
                    });
                }
            }
        } catch {}

        // 2. Rastreo de contenedores de lección (.container-lesson, #LEC_L1..#LEC_L12) que NO están en Genially
        const contenedoresProcesados = new Set();
        const contenedores = doc.querySelectorAll('.container-lesson, [id^="LEC_L"], [id^="lec_l"]');

        for (const cont of contenedores) {
            contenedoresProcesados.add(cont);

            if (contenedoresConGenially.has(cont)) continue;
            if (cont.querySelector && cont.querySelector('iframe[src*="genial"]')) continue;

            const numLeccion = extraerNumeroLeccion(cont.id || '');
            if (numLeccion !== null && numerosConGenially.has(numLeccion)) continue;

            const infoEl = extraerElementoYUrlDeContenedor(cont);
            if (!infoEl) continue;

            let rawUrl = infoEl.rawAttr;
            const ytIdCont = extraerYoutubeId(rawUrl);
            if (ytIdCont) {
                rawUrl = construirUrlYoutubeEmbed(ytIdCont);
            } else {
                try { rawUrl = new URL(infoEl.rawAttr, window.location.href).href; } catch {}
            }

            const codigo = extraerCodigoElemento(infoEl.el, doc, cont, rawUrl);
            if (!codigo || codigo === SIN_TITULO) continue;
            if (/^(english|español|saltar|salir)/i.test(codigo.trim())) continue;

            const urlNorm = normalizarUrl(rawUrl);
            if (vistos.has(urlNorm)) continue;
            vistos.add(urlNorm);

            const num = numLeccion !== null ? numLeccion : (extraerNumeroLeccion(codigo) ?? 999);
            const nombreVisual = obtenerNombrePLeccion(infoEl.el, doc, cont, num, codigo, mapaPLeccion);
            const codFinal = ytIdCont && num !== 999 ? `L${num}_Video` : codigo;

            encontrados.push({
                codigo: codFinal,
                nombre: nombreVisual,
                titulo: codFinal,
                url: rawUrl,
                numero: num,
                esPdf: esUrlPdfDirecto(rawUrl),
                esYoutube: Boolean(ytIdCont)
            });
        }

        // 3. Respaldo para .img-leccion, PDFs (ej. L3_Comic.pdf), mod/resource, enlaces YouTube y enlaces de Versión estenográfica (1 por lección)
        const selectorRespaldo = [
            '.img-leccion[data-link]',
            '[data-link*="/mod/scorm/"]',
            '[data-link*="/mod_scorm/"]',
            '[data-link*="/mod/resource/"]',
            '[data-link*="/mod_resource/"]',
            '[data-link*=".pdf"]',
            '[data-link*="youtube.com"]',
            '[data-link*="youtu.be"]',
            '[data-link*="youtube-nocookie.com"]',
            '[data-link*="enlaces.uveg.edu.mx"]',
            'a[href*="/mod/resource/"]',
            'a[href*="/mod_resource/"]',
            'a[href*=".pdf"]',
            'a[href*="youtube.com"]',
            'a[href*="youtu.be"]',
            'a[href*="youtube-nocookie.com"]',
            'a[href*="enlaces.uveg.edu.mx/enlaces"]'
        ].join(', ');

        for (const el of doc.querySelectorAll(selectorRespaldo)) {
            if (el.closest && el.closest('nav, header, footer, #page-header, .breadcrumb, [data-region="drawer"]')) {
                continue;
            }
            const padreCont = el.closest ? el.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"]') : null;
            const rawAttrCheck = el.getAttribute('data-link') || el.getAttribute('href');
            if (padreCont && contenedoresProcesados.has(padreCont) && !esUrlYoutube(rawAttrCheck) && !esUrlEnlacesUveg(rawAttrCheck)) {
                continue;
            }

            const rawAttr = rawAttrCheck;
            const textoEl = (el.innerText || el.textContent || el.getAttribute('title') || '').trim();
            const esEsteno = esUrlEstenografica(rawAttr, textoEl);
            const ytIdLink = extraerYoutubeId(rawAttr);

            if (!rawAttr || (!esEsteno && !ytIdLink && !esUrlRecurso(rawAttr))) continue;

            let rawUrl = rawAttr;
            if (ytIdLink) {
                rawUrl = construirUrlYoutubeEmbed(ytIdLink);
            } else {
                try { rawUrl = new URL(rawAttr, window.location.href).href; } catch {}
            }

            const urlNorm = normalizarUrl(rawUrl);
            if (vistos.has(urlNorm)) continue;

            let codigo = extraerCodigoElemento(el, doc, padreCont, rawUrl);
            if ((!codigo || codigo === SIN_TITULO || REGEX_GENERICO_TITULO.test(codigo)) && tituloDocFallback !== SIN_TITULO) {
                codigo = tituloDocFallback;
            }
            if (/^(english|español|saltar|salir)/i.test(codigo.trim())) continue;

            const esPdfDirecto = esUrlPdfDirecto(rawUrl);
            const esModRes = /\/mod\/resource\/|\/mod_resource\//i.test(rawUrl);

            if (esEsteno) {
                const encEst = obtenerEncabezadoLeccionPrecedente(el, doc) || (codigo !== SIN_TITULO ? codigo : tituloDocFallback);
                const numEst = extraerNumeroLeccion(encEst) ?? extraerNumeroLeccion(codigo) ?? (contextoFallback ? contextoFallback.numero : null);
                const nomBase = (numEst !== null && mapaPLeccion[String(numEst)])
                    ? mapaPLeccion[String(numEst)]
                    : (encEst && encEst !== SIN_TITULO ? encEst : `Lección ${numEst || ''}`.trim());
                const claveEst = (numEst !== null && numEst !== 999)
                    ? `num_${numEst}`
                    : `tit_${normalizarTextoSimple(nomBase)}`;

                if (estenograficasPorLeccion.has(claveEst)) continue;
                estenograficasPorLeccion.add(claveEst);
                vistos.add(urlNorm);

                const codigoEst = (numEst !== null && numEst !== 999) ? `L${numEst}_Estenografica` : 'Version_Estenografica';
                const nombreEst = /versi[oó]n estenogr[aá]fica/i.test(nomBase)
                    ? nomBase
                    : `${nomBase} - Versión estenográfica`;

                encontrados.push({
                    codigo: codigoEst,
                    nombre: nombreEst,
                    titulo: codigoEst,
                    url: rawUrl,
                    numero: numEst !== null ? numEst : 999,
                    esPdf: true,
                    esEstenografica: true
                });
                continue;
            }

            if (ytIdLink) {
                const encYt = obtenerEncabezadoLeccionPrecedente(el, doc) || (codigo !== SIN_TITULO ? codigo : tituloDocFallback);
                const numYt = extraerNumeroLeccion(encYt) ?? extraerNumeroLeccion(codigo) ?? (contextoFallback ? contextoFallback.numero : null);
                const nombreYt = (numYt !== null && mapaPLeccion[String(numYt)])
                    ? mapaPLeccion[String(numYt)]
                    : (encYt && encYt !== SIN_TITULO ? encYt : (textoEl || `Video_${ytIdLink}`));
                const codigoYt = (numYt !== null && numYt !== 999) ? `L${numYt}_Video` : `Video_${ytIdLink}`;

                vistos.add(urlNorm);
                encontrados.push({
                    codigo: codigoYt,
                    nombre: nombreYt,
                    titulo: codigoYt,
                    url: rawUrl,
                    numero: numYt !== null ? numYt : 999,
                    esYoutube: true
                });
                continue;
            }

            // Si es un recurso suelto fuera de .container-lesson:
            if (!padreCont) {
                if (esPdfDirecto) {
                    const nomPdf = extraerNombreArchivoPdf(rawUrl) || '';
                    if (!REGEX_CODIGO_LECCION.test(nomPdf) && !REGEX_CODIGO_LECCION.test(codigo)) {
                        continue;
                    }
                    if (!codigo || codigo === SIN_TITULO || !REGEX_CODIGO_LECCION.test(codigo)) {
                        codigo = nomPdf.replace(/\.pdf$/i, '');
                    }
                } else if (esModRes) {
                    // Se validará al dar el salto HTTP si redirige a un PDF de lección (como L3_Comic.pdf)
                    const numRes = extraerNumeroLeccion(codigo) ?? 999;
                    const nombreRes = obtenerNombrePLeccion(el, doc, padreCont, numRes, codigo, mapaPLeccion);
                    vistos.add(urlNorm);
                    encontrados.push({
                        codigo: codigo,
                        nombre: nombreRes,
                        titulo: codigo,
                        url: rawUrl,
                        numero: numRes,
                        esPdf: true,
                        requiereValidarSaltoPdf: true
                    });
                    continue;
                } else if (!el.classList || !el.classList.contains('img-leccion')) {
                    continue;
                }
            }

            if (!codigo || codigo === SIN_TITULO) continue;

            const num = extraerNumeroLeccion(codigo);
            if (num !== null && numerosConGenially.has(num) && !esPdfDirecto && !esModRes) continue;

            const nombreVisual = obtenerNombrePLeccion(el, doc, padreCont, num, codigo, mapaPLeccion);

            vistos.add(urlNorm);
            encontrados.push({
                codigo: codigo,
                nombre: nombreVisual,
                titulo: codigo,
                url: rawUrl,
                numero: num !== null ? num : 999,
                esPdf: esPdfDirecto || esModRes
            });
        }

        return encontrados;
    }

    function encontrarIframesEnDocumento(doc = document) {
        return encontrarLeccionesEnDocumento(doc);
    }

    function esperar(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function fetchConReintento(url, opciones = {}, reintentos = 3, esperaBaseMs = 500) {
        let ultimoError = null;
        for (let intento = 1; intento <= reintentos; intento++) {
            try {
                const res = await fetch(url, opciones);
                if (res.ok || (res.status >= 300 && res.status < 500 && res.status !== 408 && res.status !== 429)) {
                    return res;
                }
                ultimoError = new Error(`HTTP ${res.status}`);
            } catch (err) {
                ultimoError = err;
            }
            if (intento < reintentos) {
                await esperar(esperaBaseMs * intento);
            }
        }
        if (ultimoError) throw ultimoError;
        return fetch(url, opciones);
    }

    async function resolverActividadesMoodle(actividadesPendientes, urlsVistas, estenograficasGlobales) {
        const cola = [...actividadesPendientes];
        const procesadas = new Set();

        while (cola.length > 0) {
            const act = cola.shift();
            if (!act || !act.url) continue;
            const normAct = normalizarUrl(act.url);
            if (procesadas.has(normAct)) continue;
            procesadas.add(normAct);

            try {
                const resp = await fetchConReintento(act.url, { credentials: 'include' }, 2, 450);
                const finalUrl = resp.url || act.url;

                const ytDirecto = extraerYoutubeId(finalUrl);
                if (ytDirecto) {
                    const urlEmbed = construirUrlYoutubeEmbed(ytDirecto);
                    const normYt = normalizarUrl(urlEmbed);
                    if (!urlsVistas.has(normYt)) {
                        urlsVistas.add(normYt);
                        const num = act.numero ?? extraerNumeroLeccion(act.nombre || act.codigo);
                        const cod = (num !== null && num !== 999) ? `L${num}_Video` : `Video_${ytDirecto}`;
                        itemsAcumulados.push({
                            codigo: cod,
                            nombre: act.nombre || cod,
                            titulo: cod,
                            url: urlEmbed,
                            numero: num !== null ? num : 999,
                            esYoutube: true
                        });
                    }
                    continue;
                }

                if (!resp.ok) continue;
                const html = await resp.text();
                const docAct = new DOMParser().parseFromString(html, 'text/html');
                const hallados = encontrarLeccionesEnDocumento(docAct, act, estenograficasGlobales);

                for (const h of hallados) {
                    const normH = normalizarUrl(h.url);
                    if (!urlsVistas.has(normH)) {
                        urlsVistas.add(normH);
                        itemsAcumulados.push(h);
                    }
                }

                // Seguir iframes H5P incrustados dentro de una página Moodle (/mod/hvp/embed.php)
                if (!/\/mod\/hvp\//i.test(act.url)) {
                    for (const subIframe of docAct.querySelectorAll('iframe[src*="/mod/hvp/"], iframe[data-src*="/mod/hvp/"]')) {
                        const rawSub = subIframe.getAttribute('src') || subIframe.getAttribute('data-src');
                        if (!rawSub) continue;
                        let urlSub = rawSub;
                        try { urlSub = new URL(rawSub, finalUrl).href; } catch {}
                        const normSub = normalizarUrl(urlSub);
                        if (!procesadas.has(normSub)) {
                            const encSub = obtenerEncabezadoLeccionPrecedente(subIframe, docAct) || act.nombre || act.codigo;
                            const numSub = extraerNumeroLeccion(encSub) ?? act.numero ?? null;
                            cola.push({
                                url: urlSub,
                                codigo: encSub,
                                nombre: encSub,
                                titulo: encSub,
                                numero: numSub
                            });
                        }
                    }
                }
            } catch (errAct) {
                console.warn('[UVEG Guardado] Error resolviendo actividad Moodle:', act.url, errAct);
            }

            await esperar(120);
        }
    }

    // Escaneo secuencial con reintentos de las secciones 2, 3 y 4 en el campus virtual UVEG (evita bloqueo de sesión PHP en Moodle)
    async function escanearTodasLasSecciones(courseId) {
        if (escaneandoSecciones || !courseId || hostname === 'localhost' || hostname === '127.0.0.1' || window.location.protocol === 'file:') {
            return;
        }

        escaneandoSecciones = true;
        const seccionesAExplorar = [2, 3, 4];

        try {
            const urlsVistas = new Set(itemsAcumulados.map(it => normalizarUrl(it.url)));
            const estenograficasGlobales = new Set();
            for (const it of itemsAcumulados) {
                if (it.esEstenografica) {
                    const cl = (it.numero && it.numero !== 999) ? `num_${it.numero}` : `tit_${normalizarTextoSimple(it.nombre || it.codigo)}`;
                    estenograficasGlobales.add(cl);
                }
            }

            const actividadesMoodle = [...recolectarActividadesMoodleEnDocumento(document)];

            for (const sec of seccionesAExplorar) {
                const urlSeccion = `${window.location.origin}/course/view.php?id=${courseId}&mainsection=${sec}`;
                let halladosEnSeccion = [];

                for (let intentoSec = 1; intentoSec <= 3; intentoSec++) {
                    try {
                        const resp = await fetchConReintento(urlSeccion, { credentials: 'include' }, 3, 500);
                        if (resp.ok) {
                            const html = await resp.text();
                            const parser = new DOMParser();
                            const docSec = parser.parseFromString(html, 'text/html');
                            halladosEnSeccion = encontrarLeccionesEnDocumento(docSec, null, estenograficasGlobales);
                            for (const act of recolectarActividadesMoodleEnDocumento(docSec)) {
                                if (!actividadesMoodle.some(a => normalizarUrl(a.url) === normalizarUrl(act.url))) {
                                    actividadesMoodle.push(act);
                                }
                            }
                            if (halladosEnSeccion.length > 0 || actividadesMoodle.length > 0) {
                                break;
                            }
                        }
                    } catch (errSec) {
                        console.warn(`[UVEG Guardado] Intento ${intentoSec} fallido en sección ${sec}:`, errSec);
                    }
                    if (intentoSec < 3) {
                        await esperar(500 * intentoSec);
                    }
                }

                for (const it of halladosEnSeccion) {
                    const norm = normalizarUrl(it.url);
                    if (!urlsVistas.has(norm)) {
                        urlsVistas.add(norm);
                        itemsAcumulados.push(it);
                    }
                }

                await esperar(150);
            }

            if (actividadesMoodle.length > 0) {
                await resolverActividadesMoodle(actividadesMoodle, urlsVistas, estenograficasGlobales);
            }
        } catch (e) {
            console.warn('[UVEG Guardado] Error al escanear secciones remotas:', e);
        } finally {
            escaneandoSecciones = false;
        }
    }

    // --- RESOLUCIÓN Y SUBIDA SCORM / PDF A SUPABASE STORAGE ---

    function normalizarHtmlScorm(texto) {
        if (!texto) return '';
        let limpio = String(texto)
            .replace(/\\\\u0026/gi, '&')
            .replace(/\\\\u002f/gi, '/')
            .replace(/\\u0026/gi, '&')
            .replace(/\\u002f/gi, '/')
            .replace(/\\x26/gi, '&')
            .replace(/\\\\\//g, '/')
            .replace(/\\\//g, '/')
            .replace(/\\"/g, '"')
            .replace(/&amp;/gi, '&');
        try {
            if (/%2F|%3A|%3F|%26/i.test(limpio)) {
                limpio += ' ' + decodeURIComponent(limpio);
            }
        } catch {}
        return limpio;
    }

    function limpiarRutaManifest(rutaRaw) {
        if (!rutaRaw) return '';
        return String(rutaRaw)
            .trim()
            .replace(/&amp;/gi, '&')
            .replace(/\\/g, '/')
            .replace(/^(\.\/|\/)+/, '');
    }

    function extraerRutaContent(texto) {
        if (!texto) return null;
        const limpio = normalizarHtmlScorm(texto);

        const match = limpio.match(/(https?:\/\/[^"'\s<>\\]+\/pluginfile\.php\/\d+\/mod_scorm\/content\/\d+\/)/i);
        if (match) return match[1];

        const matchRel = limpio.match(/(\/pluginfile\.php\/\d+\/mod_scorm\/content\/\d+\/)/i);
        if (matchRel) {
            try {
                return new URL(matchRel[1], window.location.origin).href;
            } catch {}
        }
        return null;
    }

    function extraerUrlPdfDesdeTexto(texto, baseUrl = window.location.origin) {
        if (!texto) return null;
        const limpio = normalizarHtmlScorm(texto);

        const matchAbs = limpio.match(/(https?:\/\/[^"'\s<>\\]+\/pluginfile\.php\/\d+\/[^"'\s<>\\]+\.pdf(?:\?[^"'\s<>\\]*)?)/i);
        if (matchAbs) return matchAbs[1];

        const matchRel = limpio.match(/(\/pluginfile\.php\/\d+\/[^"'\s<>\\]+\.pdf(?:\?[^"'\s<>\\]*)?)/i);
        if (matchRel) {
            try {
                return new URL(matchRel[1], baseUrl).href;
            } catch {}
        }
        return null;
    }

    function extraerUrlLoadSco(html, baseUrl) {
        if (!html) return null;
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const el = doc.querySelector('iframe[src*="loadSCO.php"], #scorm_object[src], object[data*="loadSCO.php"], a[href*="loadSCO.php"]');
            if (el) {
                const raw = el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('href');
                if (raw) return new URL(raw.replace(/&amp;/gi, '&'), baseUrl).href;
            }
        } catch {}

        const limpio = normalizarHtmlScorm(html);
        const matchSco = limpio.match(/((?:https?:\/\/[^"'\s<>\\]+|[a-zA-Z0-9_./:-]*)\bloadSCO\.php\?[^"'\s<>\\]+)/i);
        if (matchSco) {
            try {
                return new URL(matchSco[1], baseUrl).href;
            } catch {}
        }
        return null;
    }

    function extraerParametrosScorm(html, pageUrl, previo = {}) {
        const out = {
            cmId: previo.cmId || '',
            aId: previo.aId || '',
            scoid: previo.scoid || '',
            currentorg: previo.currentorg || '',
            mode: previo.mode || '',
            attempt: previo.attempt || '1'
        };

        if (pageUrl) {
            try {
                const u = new URL(pageUrl, window.location.origin);
                if (u.searchParams.get('id') && /view\.php/i.test(u.pathname)) out.cmId = out.cmId || u.searchParams.get('id');
                if (u.searchParams.get('cm')) out.cmId = u.searchParams.get('cm');
                if (u.searchParams.get('a')) out.aId = u.searchParams.get('a');
                if (u.searchParams.get('scoid')) out.scoid = u.searchParams.get('scoid');
                if (u.searchParams.get('currentorg')) out.currentorg = u.searchParams.get('currentorg');
            } catch {}
        }

        if (!html) return out;
        const limpio = normalizarHtmlScorm(html);

        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const formScope = doc.querySelector('form#scormviewform, form[action*="player.php"]') || doc;
            for (const input of formScope.querySelectorAll('input[name], select[name]')) {
                const name = (input.getAttribute('name') || '').toLowerCase();
                const type = (input.getAttribute('type') || '').toLowerCase();
                if ((type === 'radio' || type === 'checkbox') && !input.checked && !input.hasAttribute('checked')) continue;
                const val = (input.value || input.getAttribute('value') || '').trim();
                if (!val) continue;
                if ((name === 'cm' || name === 'id') && /^[1-9]\d*$/.test(val)) out.cmId = out.cmId || val;
                if (name === 'a' && /^[1-9]\d*$/.test(val)) out.aId = out.aId || val;
                if (name === 'scoid' && /^[1-9]\d*$/.test(val)) out.scoid = out.scoid || val;
                if (name === 'currentorg') out.currentorg = out.currentorg || val;
                if (name === 'mode') out.mode = out.mode || val;
                if (name === 'attempt') out.attempt = out.attempt || val;
            }
        } catch {}

        // 1. Extraer combinación directa a=XXXX&scoid=YYYY (presente en player.php y en el JSON de M.mod_scorm.init)
        const mCombo = limpio.match(/(?:^|[^a-zA-Z0-9_])a=([1-9]\d*)&scoid=([1-9]\d*)(?:&currentorg=([^&"'\s<>\\]*))?(?:&mode=([^&"'\s<>\\]*))?(?:&attempt=(\d+))?/i);
        if (mCombo) {
            out.aId = mCombo[1];
            out.scoid = mCombo[2];
            if (mCombo[3] && !out.currentorg) {
                try { out.currentorg = decodeURIComponent(mCombo[3]); } catch { out.currentorg = mCombo[3]; }
            }
            if (mCombo[4] && !out.mode) out.mode = mCombo[4];
            if (mCombo[5]) out.attempt = mCombo[5];
        }

        // 2. Respaldo individual de parámetros en URLs o JSON
        const mScoid = limpio.match(/[?&]scoid=([1-9]\d*)/i) || limpio.match(/["']scoid["']\s*[:=,]\s*["']?([1-9]\d*)/i);
        if (mScoid && !out.scoid) out.scoid = mScoid[1];

        const mCm = limpio.match(/[?&]cm=([1-9]\d*)/i);
        if (mCm && !out.cmId) out.cmId = mCm[1];

        const mA = limpio.match(/(?:[?&]|["'])a=([1-9]\d*)(?:&|["'])/i);
        if (mA && !out.aId) out.aId = mA[1];

        const mOrg = limpio.match(/[?&]currentorg=([^&"'\s<>\\]+)/i);
        if (mOrg && !out.currentorg) {
            try { out.currentorg = decodeURIComponent(mOrg[1]); } catch { out.currentorg = mOrg[1]; }
        }

        // 3. Extraer desde M.mod_scorm.init(Y, ..., launch_sco, {TOC_JSON}, currentorg, aId, cmId, attempt, mode, ...)
        const idxInit = limpio.search(/M\.mod_scorm\.init\s*\(/i);
        if (idxInit !== -1) {
            const argsStr = limpio.slice(idxInit, idxInit + 25000);
            if (!out.scoid) {
                const mLaunchSco = argsStr.match(/,\s*["']?([1-9]\d*)["']?\s*,\s*(?:\{\s*["']|null\b)/);
                if (mLaunchSco) out.scoid = mLaunchSco[1];
            }
            if (out.cmId) {
                const reBeforeCm = new RegExp('["\']([^"\']*)["\']\\s*,\\s*["\']?([1-9]\\d*)["\']?\\s*,\\s*["\']?' + out.cmId + '["\']?\\b');
                const mBeforeCm = argsStr.match(reBeforeCm);
                if (mBeforeCm) {
                    if (!out.currentorg && mBeforeCm[1]) out.currentorg = mBeforeCm[1];
                    if (!out.aId && mBeforeCm[2]) out.aId = mBeforeCm[2];
                }
            }
        }

        return out;
    }

    async function probarLoadSco(urlSco) {
        if (!urlSco) return null;
        try {
            const resSco = await fetchConReintento(urlSco, { credentials: 'include' }, 2, 450);
            if (esUrlPdfDirecto(resSco.url)) {
                try { if (resSco.body) resSco.body.cancel(); } catch {}
                return { tipo: 'pdf', url: resSco.url };
            }
            const desdeUrl = extraerRutaContent(resSco.url);
            if (desdeUrl) return { tipo: 'scorm', url: desdeUrl, launchUrl: resSco.url };

            if (resSco.ok) {
                const cType = (resSco.headers.get('content-type') || '').toLowerCase();
                if (cType.includes('application/pdf')) {
                    return { tipo: 'pdf', url: resSco.url || urlSco };
                }
                const htmlSco = await resSco.text();
                const pdfEnHtml = extraerUrlPdfDesdeTexto(htmlSco, resSco.url || urlSco);
                if (pdfEnHtml) return { tipo: 'pdf', url: pdfEnHtml };

                const desdeHtml = extraerRutaContent(htmlSco);
                if (desdeHtml) return { tipo: 'scorm', url: desdeHtml };
            }
        } catch {}
        return null;
    }

    async function probarCandidatosLoadSco(origin, p) {
        const candidatos = [];
        const orgParam = p.currentorg ? `&currentorg=${encodeURIComponent(p.currentorg)}&mode=${encodeURIComponent(p.mode || '')}&attempt=${encodeURIComponent(p.attempt || '1')}` : '';

        if (p.aId && p.scoid) {
            if (orgParam) candidatos.push(`${origin}/mod/scorm/loadSCO.php?a=${encodeURIComponent(p.aId)}&scoid=${encodeURIComponent(p.scoid)}${orgParam}`);
            candidatos.push(`${origin}/mod/scorm/loadSCO.php?a=${encodeURIComponent(p.aId)}&scoid=${encodeURIComponent(p.scoid)}`);
        }
        if (p.cmId && p.scoid) {
            if (orgParam) candidatos.push(`${origin}/mod/scorm/loadSCO.php?id=${encodeURIComponent(p.cmId)}&scoid=${encodeURIComponent(p.scoid)}${orgParam}`);
            candidatos.push(`${origin}/mod/scorm/loadSCO.php?id=${encodeURIComponent(p.cmId)}&scoid=${encodeURIComponent(p.scoid)}`);
        }
        if (p.cmId) {
            candidatos.push(`${origin}/mod/scorm/loadSCO.php?id=${encodeURIComponent(p.cmId)}`);
        }

        for (const cand of candidatos) {
            const resultado = await probarLoadSco(cand);
            if (resultado) return resultado;
        }
        return null;
    }

    // Resuelve el destino de una lección (ya sea que aterrice en un paquete SCORM o dé un salto a un PDF como L3_Comic.pdf)
    async function resolverDestinoRecurso(url, opciones = {}) {
        const descargarBlobPdf = Boolean(opciones.descargarBlobPdf);

        if (esUrlPdfDirecto(url)) {
            return { tipo: 'pdf', url: new URL(url, window.location.href).href };
        }

        const directo = extraerRutaContent(url);
        if (directo) return { tipo: 'scorm', url: directo, launchUrl: url };

        try {
            const uObj = new URL(url, window.location.href);
            const origin = uObj.origin;
            let estadoParams = extraerParametrosScorm('', uObj.href, {});

            // Paso 1: Consultar la URL inicial (por ejemplo, /mod/scorm/view.php?id=... o /mod/resource/view.php?id=...)
            const resView = await fetchConReintento(uObj.href, { credentials: 'include' }, 3, 500);
            const baseActual = resView.url || uObj.href;
            const cTypeView = (resView.headers.get('content-type') || '').toLowerCase();

            // Si al dar el salto redirige directamente a un PDF (ej. .../pluginfile.php/8852/mod_resource/content/5/L3_Comic.pdf)
            if (esUrlPdfDirecto(baseActual) || cTypeView.includes('application/pdf')) {
                if (descargarBlobPdf) {
                    const blobPdf = await resView.blob();
                    return { tipo: 'pdf', url: baseActual, blob: blobPdf };
                }
                try { if (resView.body) resView.body.cancel(); } catch {}
                return { tipo: 'pdf', url: baseActual };
            }

            const desdeViewUrl = extraerRutaContent(baseActual);
            if (desdeViewUrl) return { tipo: 'scorm', url: desdeViewUrl, launchUrl: baseActual };

            if (!resView.ok) return null;
            const htmlView = await resView.text();

            const pdfEnView = extraerUrlPdfDesdeTexto(htmlView, baseActual);
            if (pdfEnView) return { tipo: 'pdf', url: pdfEnView };

            const desdeViewHtml = extraerRutaContent(htmlView);
            if (desdeViewHtml) return { tipo: 'scorm', url: desdeViewHtml };

            estadoParams = extraerParametrosScorm(htmlView, baseActual, estadoParams);

            const urlScoDirecto = extraerUrlLoadSco(htmlView, baseActual);
            if (urlScoDirecto) {
                const resDirecto = await probarLoadSco(urlScoDirecto);
                if (resDirecto) return resDirecto;
            }

            // Si ya obtuvimos scoid desde view.php (o porque view.php redirigió a player.php), probar loadSCO.php de inmediato
            if (estadoParams.scoid && (estadoParams.aId || estadoParams.cmId)) {
                const desdeParamsView = await probarCandidatosLoadSco(origin, estadoParams);
                if (desdeParamsView) return desdeParamsView;
            }

            // Paso 2: Extraer formulario #scormviewform y consultar player.php
            const docView = new DOMParser().parseFromString(htmlView, 'text/html');
            const form = docView.querySelector('form#scormviewform, form[action*="player.php"]');
            const formParams = new URLSearchParams();

            if (form) {
                for (const input of form.querySelectorAll('input, select')) {
                    const name = input.getAttribute('name');
                    if (!name) continue;
                    const type = (input.getAttribute('type') || '').toLowerCase();
                    if ((type === 'radio' || type === 'checkbox') && !input.checked && !input.hasAttribute('checked')) continue;
                    formParams.set(name, input.value || input.getAttribute('value') || '');
                }
            }

            if (!formParams.get('cm') && estadoParams.cmId) formParams.set('cm', estadoParams.cmId);
            if (!formParams.get('scoid') && estadoParams.scoid) formParams.set('scoid', estadoParams.scoid);
            if (!formParams.get('a') && estadoParams.aId) formParams.set('a', estadoParams.aId);
            if (!formParams.get('currentorg') && estadoParams.currentorg) formParams.set('currentorg', estadoParams.currentorg);

            let urlPlayer = `${origin}/mod/scorm/player.php`;
            if (form && form.getAttribute('action')) {
                urlPlayer = new URL(form.getAttribute('action').replace(/&amp;/gi, '&'), baseActual).href;
            } else {
                const linkPlayer = docView.querySelector('a[href*="player.php"], iframe[src*="player.php"]');
                if (linkPlayer) {
                    const href = linkPlayer.getAttribute('href') || linkPlayer.getAttribute('src');
                    if (href) urlPlayer = new URL(href.replace(/&amp;/gi, '&'), baseActual).href;
                }
            }

            const intentosPlayer = [];
            if (Array.from(formParams.keys()).length > 0) {
                intentosPlayer.push(() => fetchConReintento(urlPlayer, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: formParams.toString()
                }, 2, 450));
            }

            const sep = urlPlayer.includes('?') ? '&' : '?';
            const urlPlayerGet = Array.from(formParams.keys()).length > 0 ? `${urlPlayer}${sep}${formParams.toString()}` : urlPlayer;
            intentosPlayer.push(() => fetchConReintento(urlPlayerGet, { credentials: 'include' }, 2, 450));

            for (const ejecutarFetchPlayer of intentosPlayer) {
                try {
                    const resPlayer = await ejecutarFetchPlayer();
                    if (esUrlPdfDirecto(resPlayer.url)) {
                        try { if (resPlayer.body) resPlayer.body.cancel(); } catch {}
                        return { tipo: 'pdf', url: resPlayer.url };
                    }
                    const desdePlayerUrl = extraerRutaContent(resPlayer.url);
                    if (desdePlayerUrl) return { tipo: 'scorm', url: desdePlayerUrl, launchUrl: resPlayer.url };

                    if (resPlayer.ok) {
                        const htmlPlayer = await resPlayer.text();
                        const pdfEnPlayer = extraerUrlPdfDesdeTexto(htmlPlayer, resPlayer.url || urlPlayer);
                        if (pdfEnPlayer) return { tipo: 'pdf', url: pdfEnPlayer };

                        const desdePlayerHtml = extraerRutaContent(htmlPlayer);
                        if (desdePlayerHtml) return { tipo: 'scorm', url: desdePlayerHtml };

                        estadoParams = extraerParametrosScorm(htmlPlayer, resPlayer.url || urlPlayer, estadoParams);

                        const urlSco = extraerUrlLoadSco(htmlPlayer, resPlayer.url || urlPlayer);
                        if (urlSco) {
                            const resSco = await probarLoadSco(urlSco);
                            if (resSco) return resSco;
                        }

                        if (estadoParams.scoid) {
                            const desdeParamsPlayer = await probarCandidatosLoadSco(origin, estadoParams);
                            if (desdeParamsPlayer) return desdeParamsPlayer;
                        }
                    }
                } catch {}
            }

            // Paso 3: Último intento con los parámetros acumulados
            return await probarCandidatosLoadSco(origin, estadoParams);
        } catch (e) {
            console.warn('[UVEG Guardado] Error al resolver destino del recurso:', e);
        }
        return null;
    }

    async function obtenerArchivosScorm(baseScorm, launchUrl = '') {
        const listaArchivos = new Set();
        listaArchivos.add('story.html');
        listaArchivos.add('index.html');
        listaArchivos.add('index_lms.html');

        if (launchUrl && launchUrl.startsWith(baseScorm)) {
            const relLaunch = limpiarRutaManifest(launchUrl.slice(baseScorm.length).split('?')[0]);
            if (relLaunch) listaArchivos.add(relLaunch);
        }

        const manifestRes = await fetchConReintento(baseScorm + 'imsmanifest.xml', { credentials: 'include' }, 3, 500);
        if (manifestRes.ok) {
            const manifestXml = await manifestRes.text();
            listaArchivos.add('imsmanifest.xml');

            let m;
            const fileRegex = /<file\b[^>]*\bhref=["']([^"']+)["']/gi;
            while ((m = fileRegex.exec(manifestXml)) !== null) {
                const r = limpiarRutaManifest(m[1]);
                if (r) listaArchivos.add(r);
            }

            const resRegex = /<resource\b[^>]*\bhref=["']([^"']+)["']/gi;
            while ((m = resRegex.exec(manifestXml)) !== null) {
                const r = limpiarRutaManifest(m[1]);
                if (r) listaArchivos.add(r);
            }
        } else if (listaArchivos.size === 0) {
            throw new Error('Error al leer imsmanifest.xml (' + manifestRes.status + ')');
        }

        return Array.from(listaArchivos);
    }

    async function subirArchivoSupabase(rutaBucket, blobOrBuffer, contentType) {
        const url = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${rutaBucket}`;
        let ultimoErr = null;

        for (let intento = 1; intento <= 3; intento++) {
            try {
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                        'Content-Type': contentType,
                        'x-upsert': 'true'
                    },
                    body: blobOrBuffer
                });
                if (resp.ok) {
                    return true;
                }
                const errTxt = await resp.text();
                ultimoErr = new Error(`Supabase [${resp.status}]: ${errTxt}`);
            } catch (e) {
                ultimoErr = e;
            }
            if (intento < 3) {
                await esperar(500 * intento);
            }
        }
        throw ultimoErr || new Error('Error al subir archivo a Supabase');
    }

    function detectarPdfPorBytes(blob) {
        if (!blob || blob.size < 4 || !blob.slice) return Promise.resolve(false);
        return blob.slice(0, 5).text().then(t => t.startsWith('%PDF-')).catch(() => false);
    }

    function extraerDestinoDeHtmlAcortador(html, baseUrl) {
        if (!html) return null;
        try {
            const docTmp = new DOMParser().parseFromString(html, 'text/html');
            const metaRefresh = docTmp.querySelector('meta[http-equiv="refresh" i]');
            const mMeta = metaRefresh && (metaRefresh.getAttribute('content') || '').match(/url\s*=\s*([^;\s"']+)/i);
            if (mMeta && mMeta[1]) {
                return new URL(mMeta[1], baseUrl).href;
            }
            const enlaceDirecto = docTmp.querySelector(
                'a[href*="drive.google.com"], iframe[src*="drive.google.com"], ' +
                'a[href*="youtube.com"], a[href*="youtu.be"], iframe[src*="youtube"], ' +
                'a[href*="genial"], iframe[src*="genial"], ' +
                'a[href*=".pdf"], iframe[src*=".pdf"], embed[src*=".pdf"], a[href*="pluginfile.php"]'
            );
            if (enlaceDirecto) {
                const rawHref = enlaceDirecto.getAttribute('href') || enlaceDirecto.getAttribute('src');
                if (rawHref) return new URL(rawHref, baseUrl).href;
            }
        } catch {}

        const pdfEnHtml = extraerUrlPdfDesdeTexto(html, baseUrl);
        if (pdfEnHtml) return pdfEnHtml;

        const limpio = normalizarHtmlScorm(html);
        const mDrive = limpio.match(/https?:\/\/(?:drive|docs)\.google\.com\/(?:file|document|presentation|spreadsheets)\/d\/[a-zA-Z0-9_-]{15,}[^"'\s<>\\]*/i) ||
                       limpio.match(/https?:\/\/drive\.google\.com\/open\?id=[a-zA-Z0-9_-]{15,}[^"'\s<>\\]*/i);
        if (mDrive) return mDrive[0];

        const ytIds = extraerUrlsYoutubeDeTexto(limpio);
        if (ytIds.length > 0) return construirUrlYoutubeEmbed(ytIds[0]);

        const mRedir = limpio.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
                       limpio.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
        if (mRedir && mRedir[1]) {
            try { return new URL(mRedir[1], baseUrl).href; } catch {}
        }
        return null;
    }

    async function descargarPdfDeGoogleDrive(fileId) {
        const urlDescarga = construirUrlDriveDownload(fileId);
        let resp = await fetchSeguroRecurso(urlDescarga, false);
        let cType = (resp.contentType || '').toLowerCase();
        let esPdf = Boolean(resp.blob) && (cType.includes('application/pdf') || (await detectarPdfPorBytes(resp.blob)));

        if (!esPdf) {
            let html = resp.text;
            if (!html && resp.blob) {
                try { html = await resp.blob.text(); } catch {}
            }
            if (html) {
                try {
                    const docDrv = new DOMParser().parseFromString(html, 'text/html');
                    const form = docDrv.querySelector('form#download-form, form[action*="download"], form[action*="uc"]');
                    let urlConfirm = null;
                    if (form && form.getAttribute('action')) {
                        const actionUrl = new URL(form.getAttribute('action'), resp.finalUrl || urlDescarga);
                        for (const inp of form.querySelectorAll('input[name]')) {
                            actionUrl.searchParams.set(inp.getAttribute('name'), inp.value || inp.getAttribute('value') || '');
                        }
                        urlConfirm = actionUrl.href;
                    } else {
                        const linkConfirm = docDrv.querySelector('a[href*="confirm="], a[href*="drive.usercontent.google.com"]');
                        if (linkConfirm && linkConfirm.getAttribute('href')) {
                            urlConfirm = new URL(linkConfirm.getAttribute('href'), resp.finalUrl || urlDescarga).href;
                        }
                    }

                    if (urlConfirm) {
                        resp = await fetchSeguroRecurso(urlConfirm, true);
                        cType = (resp.contentType || '').toLowerCase();
                        esPdf = Boolean(resp.blob) && (cType.includes('application/pdf') || (await detectarPdfPorBytes(resp.blob)));
                    }
                } catch {}
            }
        }

        if (esPdf && resp.blob) {
            const nomDisp = obtenerNombreDesdeDisposition(resp.contentDisposition);
            const nomUrl = extraerNombreArchivoPdf(resp.finalUrl);
            return {
                tipo: 'pdf',
                url: resp.finalUrl || urlDescarga,
                blob: resp.blob,
                nombreArchivo: nomDisp || nomUrl || null
            };
        }

        return {
            noDescargablePdf: true,
            previewUrl: construirUrlDrivePreview(fileId)
        };
    }

    async function resolverEnlaceAcortadoUveg(url) {
        let urlActual = url;
        for (let salto = 0; salto < 2; salto++) {
            const resp = await fetchSeguroRecurso(urlActual, false);
            const cType = (resp.contentType || '').toLowerCase();
            const nomDisp = obtenerNombreDesdeDisposition(resp.contentDisposition);
            const nomUrl = extraerNombreArchivoPdf(resp.finalUrl);

            if (resp.blob && (cType.includes('application/pdf') || esUrlPdfDirecto(resp.finalUrl) || (await detectarPdfPorBytes(resp.blob)))) {
                return {
                    urlDestino: resp.finalUrl || urlActual,
                    blob: resp.blob,
                    nombreArchivo: nomDisp || nomUrl || null
                };
            }

            if (resp.finalUrl && !esUrlEnlacesUveg(resp.finalUrl)) {
                return { urlDestino: resp.finalUrl };
            }

            let html = resp.text;
            if (!html && resp.blob) {
                try { html = await resp.blob.text(); } catch {}
            }
            const extraido = extraerDestinoDeHtmlAcortador(html, resp.finalUrl || urlActual);
            if (extraido) {
                if (!esUrlEnlacesUveg(extraido)) {
                    return { urlDestino: extraido };
                }
                urlActual = extraido;
                continue;
            }
            break;
        }
        return null;
    }

    async function resolverItemsEnlacesUveg(lista) {
        if (!Array.isArray(lista) || lista.length === 0) return;
        for (const item of lista) {
            if (!item || !item.url || item._enlaceResuelto) continue;
            if (!esUrlEnlacesUveg(item.url)) continue;

            try {
                const res = await resolverEnlaceAcortadoUveg(item.url);
                if (res && res.urlDestino) {
                    const ytId = extraerYoutubeId(res.urlDestino);
                    if (ytId) {
                        item.url = construirUrlYoutubeEmbed(ytId);
                        item.esYoutube = true;
                        item.esPdf = false;
                    } else {
                        item.url = res.urlDestino;
                        if (esUrlGenially(res.urlDestino)) {
                            item.esPdf = false;
                        }
                    }
                    if (res.blob) {
                        item._blobPreCargado = res.blob;
                    }
                    if (res.nombreArchivo) {
                        item._nombreArchivoSugerido = res.nombreArchivo;
                    }
                }
            } catch (e) {
                console.warn('[UVEG Guardado] No se pudo resolver enlace UVEG:', item.url, e);
            }
            item._enlaceResuelto = true;
        }
    }

    async function resolverDestinoEstenografica(url) {
        const driveIdDirecto = extraerGoogleDriveId(url);
        if (driveIdDirecto) {
            return await descargarPdfDeGoogleDrive(driveIdDirecto);
        }

        const resuelto = await resolverEnlaceAcortadoUveg(url);
        if (!resuelto) return null;

        if (resuelto.blob) {
            return {
                tipo: 'pdf',
                url: resuelto.urlDestino,
                blob: resuelto.blob,
                nombreArchivo: resuelto.nombreArchivo || null
            };
        }

        const driveIdDestino = extraerGoogleDriveId(resuelto.urlDestino);
        if (driveIdDestino) {
            return await descargarPdfDeGoogleDrive(driveIdDestino);
        }

        const resp = await fetchSeguroRecurso(resuelto.urlDestino, true);
        if (resp.blob && ((resp.contentType || '').toLowerCase().includes('application/pdf') || (await detectarPdfPorBytes(resp.blob)))) {
            return {
                tipo: 'pdf',
                url: resp.finalUrl || resuelto.urlDestino,
                blob: resp.blob,
                nombreArchivo: obtenerNombreDesdeDisposition(resp.contentDisposition) || extraerNombreArchivoPdf(resp.finalUrl) || null
            };
        }
        return null;
    }

    async function preservarPdfEnSupabase(idModulo, tituloPreferido, urlPdf, blobPreCargado = null, nombreArchivoSugerido = null) {
        let blob = blobPreCargado;
        let urlFinal = urlPdf;
        let nombreDesdeResp = nombreArchivoSugerido;

        if (!blob) {
            if (esUrlGoogleDrive(urlFinal) || esUrlEstenografica(urlFinal)) {
                const resEst = await resolverDestinoEstenografica(urlFinal);
                if (!resEst) {
                    throw new Error('No se pudo localizar el recurso derivado de versión estenográfica');
                }
                if (resEst.noDescargablePdf && resEst.previewUrl) {
                    return {
                        tituloFinal: (!tituloPreferido || tituloPreferido === SIN_TITULO) ? 'Documento_Drive' : tituloPreferido,
                        nombreArchivo: nombreDesdeResp || 'documento_drive.pdf',
                        urlPublica: resEst.previewUrl
                    };
                }
                urlFinal = resEst.url || urlFinal;
                nombreDesdeResp = nombreDesdeResp || resEst.nombreArchivo;
                blob = resEst.blob || null;
            }
            if (!blob) {
                const resp = await fetchSeguroRecurso(urlFinal, true);
                urlFinal = resp.finalUrl || urlFinal;
                nombreDesdeResp = nombreDesdeResp || obtenerNombreDesdeDisposition(resp.contentDisposition);
                blob = resp.blob;
                if (!blob) {
                    throw new Error('La URL no devolvió un archivo PDF descargable');
                }
            }
        }

        const slugBaseTitulo = (tituloPreferido && tituloPreferido !== SIN_TITULO)
            ? `${crearSlug(tituloPreferido)}.pdf`
            : null;
        let nombreArchivo = nombreDesdeResp || extraerNombreArchivoPdf(urlFinal) || extraerNombreArchivoPdf(urlPdf) || slugBaseTitulo || 'documento.pdf';
        if (!/\.pdf$/i.test(nombreArchivo)) {
            nombreArchivo = `${nombreArchivo}.pdf`;
        }
        const nombreSinExt = nombreArchivo.replace(/\.pdf$/i, '').trim();

        const tituloFinal = (!tituloPreferido || tituloPreferido === SIN_TITULO || /^(tiempo estimado|recursos)/i.test(tituloPreferido))
            ? (nombreSinExt || 'Documento_PDF')
            : tituloPreferido;

        const slugCarpeta = crearSlug(tituloFinal);
        const nombreArchivoLimpio = nombreArchivo.replace(/[^a-zA-Z0-9._-]/g, '_');
        const rutaEnBucket = `modulo_${idModulo}/${slugCarpeta}/${nombreArchivoLimpio}`.replace(/\/+/g, '/');

        await subirArchivoSupabase(rutaEnBucket, blob, 'application/pdf');

        return {
            tituloFinal,
            nombreArchivo,
            urlPublica: `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${rutaEnBucket}`
        };
    }

    async function preservarScormEnSupabase(idModulo, titulo, scormUrl, pdfsExtraDescubiertos = []) {
        const destino = await resolverDestinoRecurso(scormUrl, { descargarBlobPdf: true });
        if (!destino) {
            throw new Error('No se pudo localizar la ruta del paquete SCORM o PDF');
        }

        // Si el salto aterrizó en un PDF (ej. L3_Comic.pdf), descargarlo y subirlo a Supabase Storage
        if (destino.tipo === 'pdf') {
            return await preservarPdfEnSupabase(idModulo, titulo, destino.url, destino.blob || null);
        }

        const baseScorm = destino.url.endsWith('/') ? destino.url : (destino.url + '/');
        const archivos = await obtenerArchivosScorm(baseScorm, destino.launchUrl || '');
        const slugCarpeta = crearSlug(titulo);
        const slug = `modulo_${idModulo}/${slugCarpeta}`;
        const urlsPdfInternas = new Set();
        let archivosSubidos = 0;

        const BATCH_SIZE = 5;
        for (let i = 0; i < archivos.length; i += BATCH_SIZE) {
            const lote = archivos.slice(i, i + BATCH_SIZE);
            await Promise.all(lote.map(async (ruta) => {
                try {
                    const urlArchivo = new URL(ruta, baseScorm).href;
                    const res = await fetchConReintento(urlArchivo, { credentials: 'include' }, 3, 450);
                    if (res.ok) {
                        const mime = getMimeType(ruta);
                        let bodySubida = null;

                        // Si es un archivo de datos/código del SCORM (ej. data.js, story.html), detectar si tiene un salto a un PDF de UVEG (como L3_Comic.pdf)
                        if (/\.(js|html|htm|xml|json)$/i.test(ruta)) {
                            let texto = await res.text();
                            const limpio = normalizarHtmlScorm(texto);
                            const regexPdfUveg = /https?:\/\/[^"'\s<>\\]+\/pluginfile\.php\/\d+\/[^"'\s<>\\]+\.pdf(?:\?[^"'\s<>\\]*)?/gi;
                            let matchPdf;
                            while ((matchPdf = regexPdfUveg.exec(limpio)) !== null) {
                                const urlPdfHallada = matchPdf[0];
                                urlsPdfInternas.add(urlPdfHallada);

                                // Reemplazar el link dentro del SCORM para que también apunte al PDF en Supabase
                                const nomPdf = extraerNombreArchivoPdf(urlPdfHallada);
                                if (nomPdf) {
                                    const slugPdf = crearSlug(nomPdf.replace(/\.pdf$/i, ''));
                                    const nomLimpio = nomPdf.replace(/[^a-zA-Z0-9._-]/g, '_');
                                    const urlSupabasePdf = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/modulo_${idModulo}/${slugPdf}/${nomLimpio}`;
                                    texto = texto.split(urlPdfHallada).join(urlSupabasePdf);
                                    const escapada = urlPdfHallada.replace(/\//g, '\\/');
                                    texto = texto.split(escapada).join(urlSupabasePdf.replace(/\//g, '\\/'));
                                }
                            }
                            bodySubida = new Blob([texto], { type: mime });
                        } else {
                            bodySubida = await res.blob();
                        }

                        const rutaEnBucket = `${slug}/${ruta}`.replace(/\/+/g, '/');
                        await subirArchivoSupabase(rutaEnBucket, bodySubida, mime);
                        archivosSubidos++;
                    }
                } catch (err) {
                    console.warn(`[UVEG Guardado] Error subiendo ${ruta}:`, err);
                }
            }));
        }

        if (archivosSubidos === 0) {
            throw new Error('No se pudieron subir los archivos del paquete SCORM a Supabase');
        }

        for (const uPdf of urlsPdfInternas) {
            if (!pdfsExtraDescubiertos.includes(uPdf)) {
                pdfsExtraDescubiertos.push(uPdf);
            }
        }

        return {
            tituloFinal: titulo,
            urlPublica: `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${slug}/story.html`
        };
    }

    // --- COMUNICACIÓN CON LA API CLOUD (LARAVEL) ---

    async function buscarModulo(idModuloUveg) {
        const idStr = String(idModuloUveg).trim();
        const url = `${API_BASE_URL}/modulos?IdModuloUveg=${encodeURIComponent(idStr)}`;
        const resp = await fetchConReintento(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        }, 3, 500);

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al consultar módulo.`);

        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
            const encontrado = data.find(m =>
                String(m.IdModuloUveg || '').trim() === idStr ||
                String(m.Modulo || '').trim() === idStr
            );
            if (encontrado) return encontrado;
        }
        return null;
    }

    async function crearModulo(idModuloUveg, nombreVisual) {
        const idStr = String(idModuloUveg).trim();
        const nomStr = (nombreVisual || idStr).trim();
        const url = `${API_BASE_URL}/modulos`;
        const resp = await fetchConReintento(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                IdModuloUveg: idStr,
                Modulo: nomStr
            })
        }, 3, 500);

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al registrar módulo.`);

        const res = await resp.json();
        return res.data || res;
    }

    async function actualizarModulo(idModuloDb, idModuloUveg, nombreVisual) {
        if (!idModuloDb) return null;
        try {
            const resp = await fetchConReintento(`${API_BASE_URL}/modulos/${encodeURIComponent(idModuloDb)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    IdModuloUveg: String(idModuloUveg).trim(),
                    Modulo: (nombreVisual || idModuloUveg).trim()
                })
            }, 3, 500);
            if (resp.ok) {
                const res = await resp.json();
                return res.data || res;
            }
        } catch {}
        return null;
    }

    async function obtenerLeccionesDeModulo(idModulo) {
        const url = `${API_BASE_URL}/lecciones?IdModulo=${encodeURIComponent(idModulo)}`;
        const resp = await fetchConReintento(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        }, 3, 500);

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al consultar lecciones.`);

        const data = await resp.json();
        return Array.isArray(data) ? data : [];
    }

    async function crearLeccion(idModulo, codigo, nombre, urlLeccion) {
        const url = `${API_BASE_URL}/lecciones`;
        const codLimpio = String(codigo || SIN_TITULO).trim().substring(0, 100);
        const nomLimpio = String(nombre || codigo || SIN_TITULO).trim().substring(0, 200);
        const resp = await fetchConReintento(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                IdModulo: idModulo,
                Codigo: codLimpio,
                Nombre: nomLimpio,
                UrlLeccion: urlLeccion
            })
        }, 3, 500);

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al guardar lección "${codLimpio}".`);

        return await resp.json();
    }

    async function actualizarLeccion(idLeccion, codigo, nombre, urlLeccion) {
        if (!idLeccion) return null;
        try {
            const codLimpio = String(codigo || SIN_TITULO).trim().substring(0, 100);
            const nomLimpio = String(nombre || codigo || SIN_TITULO).trim().substring(0, 200);
            const resp = await fetchConReintento(`${API_BASE_URL}/lecciones/${encodeURIComponent(idLeccion)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    Codigo: codLimpio,
                    Nombre: nomLimpio,
                    UrlLeccion: urlLeccion
                })
            }, 3, 500);
            if (resp.ok) return await resp.json();
        } catch {}
        return null;
    }

    async function eliminarLeccion(idLeccion) {
        if (!idLeccion) return;
        try {
            await fetchConReintento(`${API_BASE_URL}/lecciones/${encodeURIComponent(idLeccion)}`, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json' }
            }, 2, 400);
        } catch {}
    }

    // --- INTERFAZ DISCRETA (TOAST EN ESQUINA SUPERIOR DERECHA) ---

    function asegurarHostNotificacion() {
        let host = document.getElementById(ID_HOST);
        if (!host) {
            host = document.createElement('div');
            host.id = ID_HOST;
            document.body.appendChild(host);
            host.attachShadow({ mode: 'open' });
        }
        return host.shadowRoot;
    }

    function mostrarToast({ tipo, mensaje, duracionMs = 7000 }) {
        const root = asegurarHostNotificacion();
        root.innerHTML = '';

        const wrapper = document.createElement('div');
        wrapper.className = `toast-container toast-${tipo}`;

        const estilo = document.createElement('style');
        estilo.textContent = `
            .toast-container {
                position: fixed;
                top: 24px;
                right: 24px;
                z-index: 99999999;
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px 18px;
                border-radius: 8px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                font-weight: 600;
                line-height: 1.4;
                color: #ffffff;
                box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.25), 0 4px 6px -4px rgba(0, 0, 0, 0.15);
                animation: toast-slide-down 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                transition: opacity 0.25s ease, transform 0.25s ease;
            }
            .toast-success {
                background-color: #059669;
                border: 1px solid #10b981;
            }
            .toast-error {
                background-color: #dc2626;
                border: 1px solid #ef4444;
            }
            .toast-info {
                background-color: #2563eb;
                border: 1px solid #3b82f6;
            }
            .toast-icon {
                font-size: 17px;
                flex-shrink: 0;
            }
            .toast-text {
                flex-grow: 1;
            }
            .toast-close {
                background: transparent;
                border: none;
                color: #ffffff;
                opacity: 0.85;
                font-size: 18px;
                cursor: pointer;
                padding: 0 6px;
                line-height: 1;
                border-radius: 4px;
                transition: opacity 0.15s ease, background-color 0.15s ease;
            }
            .toast-close:hover {
                opacity: 1;
                background-color: rgba(255, 255, 255, 0.2);
            }
            @keyframes toast-slide-down {
                from {
                    opacity: 0;
                    transform: translateY(-16px) scale(0.96);
                }
                to {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                }
            }
        `;
        root.appendChild(estilo);

        const iconEl = document.createElement('span');
        iconEl.className = 'toast-icon';
        iconEl.textContent = tipo === 'success' ? '✓' : (tipo === 'info' ? '☁' : '⚠');

        const textEl = document.createElement('span');
        textEl.className = 'toast-text';
        textEl.textContent = mensaje;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Cerrar';
        closeBtn.onclick = () => {
            wrapper.style.opacity = '0';
            wrapper.style.transform = 'translateY(-10px) scale(0.96)';
            setTimeout(() => {
                const host = document.getElementById(ID_HOST);
                if (host) host.remove();
            }, 250);
        };

        wrapper.appendChild(iconEl);
        wrapper.appendChild(textEl);
        wrapper.appendChild(closeBtn);
        root.appendChild(wrapper);

        if (duracionMs > 0) {
            setTimeout(() => {
                if (wrapper.parentNode) {
                    closeBtn.click();
                }
            }, duracionMs);
        }
    }

    // --- PROCESO PRINCIPAL DE GUARDADO Y PRESERVACIÓN CON REINTENTOS Y VERIFICACIÓN COMPLETA ---

    function buscarExistentePorCodigoOUrl(existentes, codigo, urlCandidata) {
        const itemUrlNorm = normalizarUrl(urlCandidata);
        const itemCodNorm = normalizarTexto(codigo);
        const itemSlug = crearSlug(codigo);
        const nomPdf = extraerNombreArchivoPdf(urlCandidata);

        return existentes.find(ex => {
            const exUrl = ex.UrlLeccion || '';
            const exUrlNorm = normalizarUrl(exUrl);
            const exCodNorm = normalizarTexto(ex.Codigo || ex.Nombre);

            if (itemUrlNorm && exUrlNorm && itemUrlNorm === exUrlNorm) return true;
            if (itemCodNorm && exCodNorm && itemCodNorm === exCodNorm && itemCodNorm !== normalizarTexto(SIN_TITULO)) return true;
            if (itemSlug && itemSlug !== crearSlug(SIN_TITULO) && exUrl.toLowerCase().includes(`/${itemSlug}/`)) return true;
            if (nomPdf && exUrl.toLowerCase().endsWith('/' + nomPdf.toLowerCase())) return true;
            return false;
        }) || null;
    }

    function yaExisteEnLista(existentes, codigo, urlCandidata) {
        return Boolean(buscarExistentePorCodigoOUrl(existentes, codigo, urlCandidata));
    }

    async function cargarYLimpiarExistentes(idModuloDb) {
        const existentesRaw = await obtenerLeccionesDeModulo(idModuloDb);
        const existentes = [];

        for (const ex of existentesRaw) {
            const urlEx = (ex.UrlLeccion || '').toLowerCase();
            const nomEx = (ex.Nombre || '').trim();
            const codEx = (ex.Codigo || '').trim();
            if (!urlEx.includes('supabase.co') && (urlEx.includes('/mod/resource/') || /^(tiempo estimado)/i.test(nomEx) || /^(tiempo estimado)/i.test(codEx))) {
                await eliminarLeccion(ex.id || ex.IdLeccion);
                continue;
            }
            existentes.push(ex);
        }
        return existentes;
    }

    async function sincronizarItemIndividual(item, idx, total, idModulo, idModuloDb, mapaGlobalPLeccion, existentes, pdfsExtraDescubiertos, reintentosMax = 3) {
        let ultimoError = null;

        for (let intento = 1; intento <= reintentosMax; intento++) {
            try {
                let urlFinal = item.url;
                let codigoFinal = item.codigo || item.titulo;
                let nombreFinal = item.nombre || codigoFinal;

                if (esRecursoScorm(item.url)) {
                    // Si es un mod/resource suelto fuera de .container-lesson, verificar primero a dónde salta
                    if (item.requiereValidarSaltoPdf) {
                        const destino = await resolverDestinoRecurso(item.url, { descargarBlobPdf: true });
                        if (!destino || destino.tipo !== 'pdf') {
                            item.noEsPdfLeccion = true;
                            return { estado: 'ignorado' };
                        }

                        const nomPdf = extraerNombreArchivoPdf(destino.url) || '';
                        if (!REGEX_CODIGO_LECCION.test(nomPdf)) {
                            item.noEsPdfLeccion = true;
                            return { estado: 'ignorado' };
                        }

                        const codigoPdf = nomPdf.replace(/\.pdf$/i, '').trim();
                        const numPdf = extraerNumeroLeccion(codigoPdf);
                        const nombreVisualPdf = (numPdf !== null && mapaGlobalPLeccion[String(numPdf)])
                            ? mapaGlobalPLeccion[String(numPdf)]
                            : (item.nombre && item.nombre !== item.codigo ? item.nombre : codigoPdf);

                        item.codigo = codigoPdf;
                        item.nombre = nombreVisualPdf;
                        item.requiereValidarSaltoPdf = false;
                        item.url = destino.url;

                        const regPdfExistente = buscarExistentePorCodigoOUrl(existentes, codigoPdf, destino.url);
                        if (regPdfExistente) {
                            if (regPdfExistente.Codigo !== codigoPdf || regPdfExistente.Nombre !== nombreVisualPdf) {
                                await actualizarLeccion(
                                    regPdfExistente.id || regPdfExistente.IdLeccion,
                                    codigoPdf,
                                    nombreVisualPdf,
                                    regPdfExistente.UrlLeccion
                                );
                                regPdfExistente.Codigo = codigoPdf;
                                regPdfExistente.Nombre = nombreVisualPdf;
                            }
                            return { estado: 'ya_existia' };
                        }

                        mostrarToast({
                            tipo: 'info',
                            mensaje: `Preservando PDF en Supabase (${idx}/${total}): ${codigoPdf}${intento > 1 ? ` [reintento ${intento}]` : ''}...`,
                            duracionMs: 0
                        });

                        const resPdf = await preservarPdfEnSupabase(idModulo, codigoPdf, destino.url, destino.blob || null);
                        codigoFinal = resPdf.tituloFinal || codigoPdf;
                        nombreFinal = nombreVisualPdf;
                        urlFinal = resPdf.urlPublica;
                    } else if (item.esEstenografica) {
                        mostrarToast({
                            tipo: 'info',
                            mensaje: `Preservando versión estenográfica (${idx}/${total}): ${codigoFinal}${intento > 1 ? ` [reintento ${intento}]` : ''}...`,
                            duracionMs: 0
                        });

                        const resEst = await preservarPdfEnSupabase(
                            idModulo,
                            codigoFinal,
                            item.url,
                            item._blobPreCargado || null,
                            item._nombreArchivoSugerido || `${crearSlug(codigoFinal)}.pdf`
                        );
                        codigoFinal = item.codigo || resEst.tituloFinal || codigoFinal;
                        nombreFinal = item.nombre || nombreFinal;
                        urlFinal = resEst.urlPublica;
                    } else if (esUrlPdfDirecto(item.url)) {
                        mostrarToast({
                            tipo: 'info',
                            mensaje: `Preservando PDF en Supabase (${idx}/${total}): ${codigoFinal}${intento > 1 ? ` [reintento ${intento}]` : ''}...`,
                            duracionMs: 0
                        });

                        const resPdfDirect = await preservarPdfEnSupabase(idModulo, codigoFinal, item.url, null);
                        codigoFinal = resPdfDirect.tituloFinal || codigoFinal;
                        urlFinal = resPdfDirect.urlPublica;
                    } else {
                        mostrarToast({
                            tipo: 'info',
                            mensaje: `Preservando en Supabase (${idx}/${total}): ${codigoFinal}${intento > 1 ? ` [reintento ${intento}]` : ''}...`,
                            duracionMs: 0
                        });

                        const resPreservado = await preservarScormEnSupabase(idModulo, codigoFinal, item.url, pdfsExtraDescubiertos);
                        codigoFinal = resPreservado.tituloFinal || codigoFinal;
                        const numRes = extraerNumeroLeccion(codigoFinal) ?? item.numero;
                        if (numRes !== null && numRes !== 999 && mapaGlobalPLeccion[String(numRes)]) {
                            nombreFinal = mapaGlobalPLeccion[String(numRes)];
                        }
                        urlFinal = resPreservado.urlPublica;
                    }
                } else {
                    mostrarToast({
                        tipo: 'info',
                        mensaje: `Sincronizando (${idx}/${total}): ${codigoFinal}${intento > 1 ? ` [reintento ${intento}]` : ''}...`,
                        duracionMs: 0
                    });
                }

                if (!yaExisteEnLista(existentes, codigoFinal, urlFinal)) {
                    await crearLeccion(idModuloDb, codigoFinal, nombreFinal, urlFinal);
                    existentes.push({ Codigo: codigoFinal, Nombre: nombreFinal, UrlLeccion: urlFinal });
                    return { estado: 'creado', codigo: codigoFinal };
                }

                return { estado: 'ya_existia', codigo: codigoFinal };
            } catch (err) {
                ultimoError = err;
                console.warn(`[UVEG Guardado] Intento ${intento}/${reintentosMax} fallido para "${item.codigo || item.titulo}":`, err);
                if (intento < reintentosMax) {
                    await esperar(1200 * intento);
                }
            }
        }

        throw ultimoError || new Error(`Fallo al guardar ${item.codigo || item.titulo}`);
    }

    async function ejecutarSincronizacion() {
        if (sincronizando || yaProcesado) return;
        sincronizando = true;

        try {
            const enPaginaPdfDirecta = esUrlPdfDirecto(window.location.href);
            const enPaginaCurso = /\/course\/view\.php/i.test(window.location.pathname);
            const idModulo = obtenerIdModulo();
            const nombreModuloH1 = obtenerNombreModuloH1(document, idModulo);

            // 1. Escaneo local de lecciones en la página
            const locales = encontrarIframesEnDocumento(document);
            const urlsVistas = new Set();
            itemsAcumulados = [];

            for (const item of locales) {
                const norm = normalizarUrl(item.url);
                if (!urlsVistas.has(norm)) {
                    urlsVistas.add(norm);
                    itemsAcumulados.push(item);
                }
            }

            // 2. Si estamos en la vista del curso en UVEG, escanear secciones 2, 3 y 4 y actividades Moodle secuencialmente
            if (!enPaginaPdfDirecta && enPaginaCurso && idModulo && hostname.endsWith('uveg.edu.mx')) {
                await escanearTodasLasSecciones(idModulo);
            } else if (!enPaginaPdfDirecta && !enPaginaCurso && hostname.endsWith('uveg.edu.mx')) {
                // Si el usuario abrió directamente una lección Moodle (/mod/page/, /mod/hvp/), resolver sub-iframes H5P locales
                const estenograficasLocales = new Set();
                for (const it of itemsAcumulados) {
                    if (it.esEstenografica) {
                        const cl = (it.numero && it.numero !== 999) ? `num_${it.numero}` : `tit_${normalizarTextoSimple(it.nombre || it.codigo)}`;
                        estenograficasLocales.add(cl);
                    }
                }
                const actsLocales = recolectarActividadesMoodleEnDocumento(document);
                if (actsLocales.length > 0) {
                    await resolverActividadesMoodle(actsLocales, urlsVistas, estenograficasLocales);
                }
            }

            // Resolver URLs acortadas de enlaces.uveg.edu.mx a su destino real (ej. Google Drive) antes de deduplicar/sincronizar
            await resolverItemsEnlacesUveg(itemsAcumulados);

            if (itemsAcumulados.length === 0) {
                return;
            }

            const mapaGlobalPLeccion = cargarMapaPLeccion(idModulo);

            // Deduplicar por URL y por clave de lección (separando principal, YouTube, PDFs y 1 versión estenográfica por lección)
            const porClave = new Map();
            const estenograficasVistas = new Set();
            const sinNumero = [];
            const urlsUnicasVistas = new Set();

            for (const it of itemsAcumulados) {
                const norm = normalizarUrl(it.url);
                if (urlsUnicasVistas.has(norm)) continue;
                urlsUnicasVistas.add(norm);

                const cod = it.codigo || it.titulo || SIN_TITULO;
                const num = it.numero ?? extraerNumeroLeccion(cod) ?? extraerNumeroLeccion(it.nombre);
                const esEsteno = Boolean(it.esEstenografica) || esUrlEstenografica(it.url, it.nombre);
                const esYoutube = Boolean(it.esYoutube) || esUrlYoutube(it.url);

                if (esEsteno) {
                    const clEst = (num !== null && num !== 999)
                        ? `num_${num}`
                        : `tit_${normalizarTextoSimple(it.nombre || cod)}`;
                    if (estenograficasVistas.has(clEst)) continue;
                    estenograficasVistas.add(clEst);
                }

                let nomVisual = it.nombre || cod;
                if (num !== null && num !== 999 && mapaGlobalPLeccion[String(num)]) {
                    const nomBase = mapaGlobalPLeccion[String(num)];
                    if (esEsteno) {
                        nomVisual = `${nomBase} - Versión estenográfica`;
                    } else if (!nomVisual || nomVisual === cod || /^L\d+(?:_Video)?$/i.test(nomVisual)) {
                        nomVisual = nomBase;
                    }
                } else if (esEsteno && nomVisual && !/versi[oó]n estenogr[aá]fica/i.test(nomVisual)) {
                    nomVisual = `${nomVisual} - Versión estenográfica`;
                }

                const itemEnriquecido = {
                    ...it,
                    codigo: cod,
                    nombre: nomVisual,
                    titulo: cod,
                    numero: num !== null ? num : 999,
                    esEstenografica: esEsteno,
                    esYoutube: esYoutube
                };

                if (num !== null && num !== 999) {
                    let clave;
                    if (esEsteno) {
                        clave = `${num}_pdf_estenografica`;
                    } else if (it.esPdf) {
                        clave = `${num}_pdf_${crearSlug(cod || it.url)}`;
                    } else if (esYoutube) {
                        const ytId = extraerYoutubeId(it.url) || cod;
                        clave = `${num}_yt_${ytId}`;
                    } else {
                        clave = `${num}_main`;
                    }
                    const existente = porClave.get(clave);
                    if (!existente || (esUrlGenially(it.url) && !esUrlGenially(existente.url))) {
                        porClave.set(clave, itemEnriquecido);
                    }
                } else {
                    sinNumero.push(itemEnriquecido);
                }
            }

            const itemsUnicos = [
                ...Array.from(porClave.values()).sort((a, b) => a.numero - b.numero),
                ...sinNumero
            ];

            // 3. Consultar o crear módulo en la API por IdModuloUveg
            let modulo = await buscarModulo(idModulo);
            let idModuloDb = null;

            if (modulo) {
                idModuloDb = modulo.id || modulo.IdModulo;
                const nomActual = String(modulo.Modulo || '').trim();
                const uvegActual = String(modulo.IdModuloUveg || '').trim();
                if (uvegActual !== String(idModulo).trim() || (nombreModuloH1 && nombreModuloH1 !== idModulo && nomActual !== nombreModuloH1)) {
                    await actualizarModulo(idModuloDb, idModulo, nombreModuloH1);
                }
            } else {
                const nuevoModulo = await crearModulo(idModulo, nombreModuloH1);
                idModuloDb = nuevoModulo.id || nuevoModulo.IdModulo;
            }

            if (!idModuloDb) {
                throw new Error('No se pudo determinar el ID del módulo en la base de datos.');
            }

            // 4. Ciclo multipasada (hasta 3 pasadas completas con verificación contra la BD) para garantizar que NO falte ninguna lección
            let exitosCount = 0;
            let erroresFinales = [];
            const pdfsExtraDescubiertos = [];
            const MAX_PASADAS = 3;

            for (let pasada = 1; pasada <= MAX_PASADAS; pasada++) {
                erroresFinales = [];
                const existentes = await cargarYLimpiarExistentes(idModuloDb);
                const pendientes = [];

                for (const item of itemsUnicos) {
                    if (item.noEsPdfLeccion) continue;

                    if (!item.requiereValidarSaltoPdf) {
                        const regExistente = buscarExistentePorCodigoOUrl(existentes, item.codigo, item.url);
                        if (regExistente) {
                            const codReg = String(regExistente.Codigo || '').trim();
                            const nomReg = String(regExistente.Nombre || '').trim();
                            if ((item.codigo && codReg !== item.codigo) || (item.nombre && item.nombre !== item.codigo && nomReg !== item.nombre)) {
                                await actualizarLeccion(
                                    regExistente.id || regExistente.IdLeccion,
                                    item.codigo,
                                    item.nombre,
                                    regExistente.UrlLeccion
                                );
                                regExistente.Codigo = item.codigo;
                                regExistente.Nombre = item.nombre;
                            }
                            continue;
                        }
                    }
                    pendientes.push(item);
                }

                if (pendientes.length === 0 && pdfsExtraDescubiertos.length === 0) {
                    break;
                }

                const total = pendientes.length;
                for (let i = 0; i < total; i++) {
                    const item = pendientes[i];
                    try {
                        const resItem = await sincronizarItemIndividual(
                            item,
                            i + 1,
                            total,
                            idModulo,
                            idModuloDb,
                            mapaGlobalPLeccion,
                            existentes,
                            pdfsExtraDescubiertos,
                            3
                        );
                        if (resItem.estado === 'creado') {
                            exitosCount++;
                        }
                    } catch (eItem) {
                        console.error(`[UVEG Guardado] Falló "${item.codigo}" en pasada ${pasada}:`, eItem);
                        erroresFinales.push(`${item.codigo}: ${eItem.message}`);
                    }
                    await esperar(250);
                }

                // Procesar PDFs adicionales descubiertos dentro de paquetes SCORM (ej. L3_Comic.pdf)
                for (const urlPdfExtra of pdfsExtraDescubiertos) {
                    const nomPdf = extraerNombreArchivoPdf(urlPdfExtra) || 'Documento.pdf';
                    const codigoPdf = nomPdf.replace(/\.pdf$/i, '').trim();
                    const numPdf = extraerNumeroLeccion(codigoPdf);
                    const nombreVisualPdf = (numPdf !== null && mapaGlobalPLeccion[String(numPdf)])
                        ? mapaGlobalPLeccion[String(numPdf)]
                        : codigoPdf;

                    const regPdfEx = buscarExistentePorCodigoOUrl(existentes, codigoPdf, urlPdfExtra);
                    if (regPdfEx) {
                        if (regPdfEx.Codigo !== codigoPdf || regPdfEx.Nombre !== nombreVisualPdf) {
                            await actualizarLeccion(
                                regPdfEx.id || regPdfEx.IdLeccion,
                                codigoPdf,
                                nombreVisualPdf,
                                regPdfEx.UrlLeccion
                            );
                        }
                        continue;
                    }

                    let pdfGuardado = false;
                    for (let intPdf = 1; intPdf <= 3 && !pdfGuardado; intPdf++) {
                        try {
                            mostrarToast({
                                tipo: 'info',
                                mensaje: `Preservando PDF en Supabase: ${codigoPdf}${intPdf > 1 ? ` [reintento ${intPdf}]` : ''}...`,
                                duracionMs: 0
                            });
                            const resPdf = await preservarPdfEnSupabase(idModulo, codigoPdf, urlPdfExtra, null);
                            const codFinalPdf = resPdf.tituloFinal || codigoPdf;
                            if (!yaExisteEnLista(existentes, codFinalPdf, resPdf.urlPublica)) {
                                await crearLeccion(idModuloDb, codFinalPdf, nombreVisualPdf, resPdf.urlPublica);
                                existentes.push({ Codigo: codFinalPdf, Nombre: nombreVisualPdf, UrlLeccion: resPdf.urlPublica });
                                exitosCount++;
                            }
                            pdfGuardado = true;
                        } catch (e) {
                            console.warn(`[UVEG Guardado] Intento ${intPdf}/3 al preservar PDF interno "${codigoPdf}":`, e);
                            if (intPdf < 3) await esperar(1000 * intPdf);
                            else erroresFinales.push(`${codigoPdf}: ${e.message}`);
                        }
                    }
                }

                // Verificación real contra la base de datos al terminar la pasada
                const verificacionBd = await obtenerLeccionesDeModulo(idModuloDb);
                const faltantesEnBd = itemsUnicos.filter(it =>
                    !it.noEsPdfLeccion &&
                    !it.requiereValidarSaltoPdf &&
                    !buscarExistentePorCodigoOUrl(verificacionBd, it.codigo, it.url)
                );

                if (faltantesEnBd.length === 0 && erroresFinales.length === 0) {
                    break;
                }

                if (pasada < MAX_PASADAS) {
                    mostrarToast({
                        tipo: 'info',
                        mensaje: `Completando sincronización (${faltantesEnBd.length} pendiente${faltantesEnBd.length === 1 ? '' : 's'}, verificación ${pasada + 1}/${MAX_PASADAS})...`,
                        duracionMs: 0
                    });
                    await esperar(1500);
                }
            }

            if (erroresFinales.length === 0) {
                yaProcesado = true;
            } else {
                // Si tras las 3 pasadas aún quedó alguno pendiente por red, programar reintento automático sin requerir recargar la página
                yaProcesado = false;
                setTimeout(ejecutarSincronizacion, 4500);
            }

            // 8. Notificación discreta de resultado
            if (exitosCount > 0 && erroresFinales.length === 0) {
                mostrarToast({
                    tipo: 'success',
                    mensaje: `Se han preservado y sincronizado ${exitosCount} lecciones en Supabase`,
                    duracionMs: 8000
                });
            } else if (erroresFinales.length > 0) {
                mostrarToast({
                    tipo: 'error',
                    mensaje: `Reintentando recurso pendiente (${erroresFinales[0]})`,
                    duracionMs: 8000
                });
            }
        } catch (error) {
            console.error('[UVEG Guardado] Error en sincronización:', error);
            mostrarToast({
                tipo: 'error',
                mensaje: `Error al guardar: ${error.message || 'Fallo de conexión'}`,
                duracionMs: 12000
            });
        } finally {
            sincronizando = false;
        }
    }

    // Inicializar tras carga del DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(ejecutarSincronizacion, 1500);
        });
    } else {
        setTimeout(ejecutarSincronizacion, 1500);
    }
})();
