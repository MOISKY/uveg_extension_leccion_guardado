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

    function normalizarUrl(urlStr) {
        if (!urlStr) return '';
        try {
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
        if (urlId && urlId.trim()) {
            return urlId.trim();
        }
        try {
            const guardado = localStorage.getItem(STORAGE_KEY_MODULO);
            if (guardado && guardado.trim()) return guardado.trim();
        } catch {}
        return '324';
    }

    function obtenerNombreModuloH1(doc = document, idModuloFallback = '') {
        try {
            const h1 = doc.querySelector('h1');
            if (h1) {
                const txt = (h1.innerText || h1.textContent || '').replace(/\s+/g, ' ').trim();
                if (txt.length > 1 && !/^(campus virtual|uveg)$/i.test(txt)) {
                    try { localStorage.setItem(STORAGE_KEY_MODULO_NOMBRE, txt); } catch {}
                    return txt;
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
        const u = urlStr.toLowerCase();
        if (HOSTS_GENIALLY.some(base => u.includes(base))) return false;
        return u.includes('/mod/scorm/') ||
               u.includes('/mod_scorm/') ||
               u.includes('/mod/resource/') ||
               u.includes('/mod_resource/') ||
               u.includes('scoid=') ||
               u.includes('story.html') ||
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
            guardarMapaPLeccion(idModulo, mapa);
        } catch {}

        return mapa;
    }

    function obtenerNombrePLeccion(el, doc, contenedorExplicito, numLeccion, codigoFallback, mapaPLeccion = {}) {
        try {
            const contenedor = contenedorExplicito || (el && el.closest ? el.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"]') : null);
            if (contenedor && contenedor.querySelectorAll) {
                const pList = contenedor.querySelectorAll('p.leccion2-pLeccion, .leccion2-pLeccion, [class*="pLeccion"]');
                if (pList.length === 1) {
                    const txt = (pList[0].innerText || pList[0].textContent || '').replace(/\s+/g, ' ').trim();
                    if (txt.length > 2) return txt;
                } else if (pList.length > 1 && numLeccion !== null && numLeccion !== 999) {
                    for (const p of pList) {
                        const txt = (p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim();
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
                        const txt = (pCercano.innerText || pCercano.textContent || '').replace(/\s+/g, ' ').trim();
                        if (txt.length > 2) return txt;
                    }
                }
            }
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

        if (titleAttr && !/^(genially|view|iframe|embedded)$/i.test(titleAttr)) return titleAttr;
        if (ariaAttr && !/^(genially|view|iframe|embedded)$/i.test(ariaAttr)) return ariaAttr;

        const idContenedor = extraerIdContenedorLeccion(iframe);
        if (idContenedor) return idContenedor;

        try {
            const actividad = iframe.closest ? iframe.closest('.container-lesson, .activity, .activityinstance, .contentitem, .section, .box, [id^="module-"]') : null;
            if (actividad) {
                const header = actividad.querySelector('.instancename, .activityname, h2, h3, h4, .mod-indent-outer');
                if (header) {
                    const textoLimpio = (header.innerText || header.textContent || '').split('\n')[0].replace(/\s+/g, ' ').trim();
                    if (textoLimpio.length > 2) return textoLimpio;
                }
            }
        } catch {}

        if (titleAttr) return titleAttr;
        if (nameAttr) return nameAttr;
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
                    const copia = header.cloneNode(true);
                    copia.querySelectorAll('.accesshide, .sr-only').forEach(s => s.remove());
                    const txt = (copia.innerText || copia.textContent || '').split('\n')[0].replace(/\s+/g, ' ').trim();
                    if (txt.length > 2 && !/^(recursos|tiempo estimado)/i.test(txt)) {
                        return txt;
                    }
                }
            }

            const titleAttr = (el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim();
            if (titleAttr && !/^(genially|view|iframe|embedded|icono|imagen|recurso)$/i.test(titleAttr)) {
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

    function encontrarLeccionesEnDocumento(doc = document) {
        const vistos = new Set();
        const encontrados = [];
        const contenedoresConGenially = new Set();
        const numerosConGenially = new Set();
        const idModuloActual = obtenerIdModulo();

        if (doc === document) {
            obtenerNombreModuloH1(doc, idModuloActual);
        }
        const mapaPLeccion = extraerMapaPLeccionDeDocumento(doc, idModuloActual);

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

        // 1. Rastreo de Iframes de Genially (ej. CPFI_L4, CPFI_L6, CPFI_L8, CPFI_L9, CPFI_L12)
        for (const iframe of doc.querySelectorAll('iframe')) {
            const rawSrc = iframe.getAttribute('src') || iframe.getAttribute('data-src') || iframe.src;
            if (!rawSrc || !esUrlGenially(rawSrc)) continue;

            let src = rawSrc;
            try { src = new URL(rawSrc, window.location.href).href; } catch {}

            const codigo = extraerTitulo(iframe, doc);
            if (/^(english|español|saltar|salir)/i.test(codigo.trim())) continue;

            const urlNorm = normalizarUrl(src);
            if (vistos.has(urlNorm)) continue;
            vistos.add(urlNorm);

            let numCont = null;
            const contPadre = iframe.closest ? iframe.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"]') : null;
            if (contPadre) {
                contenedoresConGenially.add(contPadre);
                numCont = extraerNumeroLeccion(contPadre.id);
                if (numCont !== null) numerosConGenially.add(numCont);
            }

            const numCodigo = extraerNumeroLeccion(codigo) ?? numCont;
            if (numCodigo !== null) {
                numerosConGenially.add(numCodigo);
            }

            const nombreVisual = obtenerNombrePLeccion(iframe, doc, contPadre, numCodigo, codigo, mapaPLeccion);

            encontrados.push({
                codigo: codigo,
                nombre: nombreVisual,
                titulo: codigo,
                url: src,
                numero: numCodigo !== null ? numCodigo : 999
            });
        }

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
            try { rawUrl = new URL(infoEl.rawAttr, window.location.href).href; } catch {}

            const codigo = extraerCodigoElemento(infoEl.el, doc, cont, rawUrl);
            if (!codigo || codigo === SIN_TITULO) continue;
            if (/^(english|español|saltar|salir)/i.test(codigo.trim())) continue;

            const urlNorm = normalizarUrl(rawUrl);
            if (vistos.has(urlNorm)) continue;
            vistos.add(urlNorm);

            const num = numLeccion !== null ? numLeccion : (extraerNumeroLeccion(codigo) ?? 999);
            const nombreVisual = obtenerNombrePLeccion(infoEl.el, doc, cont, num, codigo, mapaPLeccion);

            encontrados.push({
                codigo: codigo,
                nombre: nombreVisual,
                titulo: codigo,
                url: rawUrl,
                numero: num,
                esPdf: esUrlPdfDirecto(rawUrl)
            });
        }

        // 3. Respaldo para elementos .img-leccion, enlaces PDF de lección (ej. L3_Comic.pdf) o recursos mod/resource que den salto a PDF de lección
        const selectorRespaldo = [
            '.img-leccion[data-link]',
            '[data-link*="/mod/scorm/"]',
            '[data-link*="/mod_scorm/"]',
            '[data-link*="/mod/resource/"]',
            '[data-link*="/mod_resource/"]',
            '[data-link*=".pdf"]',
            'a[href*="/mod/resource/"]',
            'a[href*="/mod_resource/"]',
            'a[href*=".pdf"]'
        ].join(', ');

        for (const el of doc.querySelectorAll(selectorRespaldo)) {
            const padreCont = el.closest ? el.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"]') : null;
            if (padreCont && contenedoresProcesados.has(padreCont)) continue;

            const rawAttr = el.getAttribute('data-link') || el.getAttribute('href');
            if (!rawAttr || !esUrlRecurso(rawAttr)) continue;

            let rawUrl = rawAttr;
            try { rawUrl = new URL(rawAttr, window.location.href).href; } catch {}

            const urlNorm = normalizarUrl(rawUrl);
            if (vistos.has(urlNorm)) continue;

            let codigo = extraerCodigoElemento(el, doc, padreCont, rawUrl);
            if (/^(english|español|saltar|salir)/i.test(codigo.trim())) continue;

            const esPdfDirecto = esUrlPdfDirecto(rawUrl);
            const esModRes = /\/mod\/resource\/|\/mod_resource\//i.test(rawUrl);

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

    // Escaneo de secciones 2, 3, 4 en el campus virtual UVEG
    async function escanearTodasLasSecciones(courseId) {
        if (escaneandoSecciones || !courseId || hostname === 'localhost' || hostname === '127.0.0.1' || window.location.protocol === 'file:') {
            return;
        }

        escaneandoSecciones = true;
        const seccionesAExplorar = [2, 3, 4];

        try {
            const promesas = seccionesAExplorar.map(async (sec) => {
                const urlSeccion = `${window.location.origin}/course/view.php?id=${courseId}&mainsection=${sec}`;
                try {
                    const resp = await fetch(urlSeccion, { credentials: 'include' });
                    if (!resp.ok) return [];
                    const html = await resp.text();
                    const parser = new DOMParser();
                    const docSec = parser.parseFromString(html, 'text/html');
                    return encontrarIframesEnDocumento(docSec);
                } catch {
                    return [];
                }
            });

            const resultados = await Promise.all(promesas);
            const urlsVistas = new Set(itemsAcumulados.map(it => normalizarUrl(it.url)));

            for (const lista of resultados) {
                for (const it of lista) {
                    const norm = normalizarUrl(it.url);
                    if (!urlsVistas.has(norm)) {
                        urlsVistas.add(norm);
                        itemsAcumulados.push(it);
                    }
                }
            }
        } catch (e) {
            console.warn('[UVEG Guardado] Error al escanear secciones remotas:', e);
        } finally {
            escaneandoSecciones = false;
        }
    }

    // --- RESOLUCIÓN Y SUBIDA SCORM / PDF A SUPABASE STORAGE ---

    function extraerRutaContent(texto) {
        if (!texto) return null;
        let limpio = String(texto).replace(/\\\//g, '/').replace(/&amp;/gi, '&');
        try {
            if (/%2F/i.test(limpio)) {
                limpio += ' ' + decodeURIComponent(limpio);
            }
        } catch {}

        const match = limpio.match(/(https?:\/\/[^"'\s<>]+\/pluginfile\.php\/\d+\/mod_scorm\/content\/\d+\/)/i);
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
        let limpio = String(texto).replace(/\\\//g, '/').replace(/&amp;/gi, '&');
        try {
            if (/%2F/i.test(limpio)) {
                limpio += ' ' + decodeURIComponent(limpio);
            }
        } catch {}

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

        const limpio = String(html).replace(/\\\//g, '/').replace(/&amp;/gi, '&');
        const matchSco = limpio.match(/((?:https?:\/\/[^"'\s<>]+|[a-zA-Z0-9_./:-]*)\bloadSCO\.php\?[^"'\s<>]+)/i);
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
        const limpio = String(html).replace(/\\\//g, '/').replace(/&amp;/gi, '&');

        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            for (const input of doc.querySelectorAll('input[name], select[name]')) {
                const name = (input.getAttribute('name') || '').toLowerCase();
                const type = (input.getAttribute('type') || '').toLowerCase();
                if ((type === 'radio' || type === 'checkbox') && !input.checked && !input.hasAttribute('checked')) continue;
                const val = (input.value || input.getAttribute('value') || '').trim();
                if (!val) continue;
                if (name === 'cm' || name === 'id') out.cmId = out.cmId || val;
                if (name === 'a') out.aId = out.aId || val;
                if (name === 'scoid') out.scoid = out.scoid || val;
                if (name === 'currentorg') out.currentorg = out.currentorg || val;
                if (name === 'mode') out.mode = out.mode || val;
                if (name === 'attempt') out.attempt = out.attempt || val;
            }
        } catch {}

        const mScoid = limpio.match(/[?&]scoid=(\d+)/i) || limpio.match(/["']scoid["']\s*[:=,]\s*["']?(\d+)/i);
        if (mScoid && !out.scoid) out.scoid = mScoid[1];

        const mCm = limpio.match(/[?&]cm=(\d+)/i);
        if (mCm && !out.cmId) out.cmId = mCm[1];

        const mA = limpio.match(/[?&]a=(\d+)/i);
        if (mA && !out.aId) out.aId = mA[1];

        const mOrg = limpio.match(/[?&]currentorg=([^&"'\s<>]+)/i);
        if (mOrg && !out.currentorg) {
            try { out.currentorg = decodeURIComponent(mOrg[1]); } catch { out.currentorg = mOrg[1]; }
        }

        // Extraer de M.mod_scorm.init(Y, ..., a, scoid, currentorg, mode, attempt, cm, ...)
        const mInit = limpio.match(/M\.mod_scorm\.init\s*\(([\s\S]*?)\)/i);
        if (mInit) {
            const argsStr = mInit[1];
            const mPar = argsStr.match(/["']?(\d+)["']?\s*,\s*["']?(\d+)["']?\s*,\s*["']([^"']*)["']/);
            if (mPar) {
                if (!out.aId) out.aId = mPar[1];
                if (!out.scoid) out.scoid = mPar[2];
                if (!out.currentorg && mPar[3]) out.currentorg = mPar[3];
            }
        }

        return out;
    }

    async function probarLoadSco(urlSco) {
        if (!urlSco) return null;
        try {
            const resSco = await fetch(urlSco, { credentials: 'include' });
            if (esUrlPdfDirecto(resSco.url)) {
                return { tipo: 'pdf', url: resSco.url };
            }
            const desdeUrl = extraerRutaContent(resSco.url);
            if (desdeUrl) return { tipo: 'scorm', url: desdeUrl };

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
    async function resolverDestinoRecurso(url) {
        if (esUrlPdfDirecto(url)) {
            return { tipo: 'pdf', url: new URL(url, window.location.href).href };
        }

        const directo = extraerRutaContent(url);
        if (directo) return { tipo: 'scorm', url: directo };

        try {
            const uObj = new URL(url, window.location.href);
            const origin = uObj.origin;
            let estadoParams = extraerParametrosScorm('', uObj.href, {});

            // Paso 1: Consultar la URL inicial (por ejemplo, /mod/scorm/view.php?id=... o /mod/resource/view.php?id=...)
            const resView = await fetch(uObj.href, { credentials: 'include' });
            const baseActual = resView.url || uObj.href;
            const cTypeView = (resView.headers.get('content-type') || '').toLowerCase();

            // Si al dar el salto redirige directamente a un PDF (ej. .../pluginfile.php/8852/mod_resource/content/5/L3_Comic.pdf)
            if (esUrlPdfDirecto(baseActual) || cTypeView.includes('application/pdf')) {
                const blobPdf = await resView.blob();
                return { tipo: 'pdf', url: baseActual, blob: blobPdf };
            }

            const desdeViewUrl = extraerRutaContent(baseActual);
            if (desdeViewUrl) return { tipo: 'scorm', url: desdeViewUrl };

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
                intentosPlayer.push(() => fetch(urlPlayer, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: formParams.toString()
                }));
            }

            const sep = urlPlayer.includes('?') ? '&' : '?';
            const urlPlayerGet = Array.from(formParams.keys()).length > 0 ? `${urlPlayer}${sep}${formParams.toString()}` : urlPlayer;
            intentosPlayer.push(() => fetch(urlPlayerGet, { credentials: 'include' }));

            for (const ejecutarFetchPlayer of intentosPlayer) {
                try {
                    const resPlayer = await ejecutarFetchPlayer();
                    if (esUrlPdfDirecto(resPlayer.url)) {
                        return { tipo: 'pdf', url: resPlayer.url };
                    }
                    const desdePlayerUrl = extraerRutaContent(resPlayer.url);
                    if (desdePlayerUrl) return { tipo: 'scorm', url: desdePlayerUrl };

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

    async function obtenerArchivosScorm(baseScorm) {
        const manifestRes = await fetch(baseScorm + 'imsmanifest.xml', { credentials: 'include' });
        if (!manifestRes.ok) throw new Error('Error al leer imsmanifest.xml (' + manifestRes.status + ')');
        const manifestXml = await manifestRes.text();

        const listaArchivos = new Set();
        listaArchivos.add('imsmanifest.xml');
        listaArchivos.add('story.html');
        listaArchivos.add('index.html');

        let m;
        const fileRegex = /<file\b[^>]*\bhref=["']([^"']+)["']/gi;
        while ((m = fileRegex.exec(manifestXml)) !== null) {
            if (m[1]) listaArchivos.add(m[1].trim());
        }

        const resRegex = /<resource\b[^>]*\bhref=["']([^"']+)["']/gi;
        while ((m = resRegex.exec(manifestXml)) !== null) {
            if (m[1]) listaArchivos.add(m[1].trim());
        }

        return Array.from(listaArchivos);
    }

    async function subirArchivoSupabase(rutaBucket, blobOrBuffer, contentType) {
        const url = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${rutaBucket}`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': contentType,
                'x-upsert': 'true'
            },
            body: blobOrBuffer
        });
        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Supabase [${resp.status}]: ${err}`);
        }
        return true;
    }

    async function preservarPdfEnSupabase(idModulo, tituloPreferido, urlPdf, blobPreCargado = null) {
        let blob = blobPreCargado;
        let urlFinal = urlPdf;

        if (!blob) {
            const res = await fetch(urlPdf, { credentials: 'include' });
            if (!res.ok) {
                throw new Error(`Error al descargar PDF (${res.status})`);
            }
            urlFinal = res.url || urlPdf;
            blob = await res.blob();
        }

        const nombreArchivo = extraerNombreArchivoPdf(urlFinal) || extraerNombreArchivoPdf(urlPdf) || 'documento.pdf';
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
        const destino = await resolverDestinoRecurso(scormUrl);
        if (!destino) {
            throw new Error('No se pudo localizar la ruta del paquete SCORM o PDF');
        }

        // Si el salto aterrizó en un PDF (ej. L3_Comic.pdf), descargarlo y subirlo a Supabase Storage
        if (destino.tipo === 'pdf') {
            return await preservarPdfEnSupabase(idModulo, titulo, destino.url, destino.blob || null);
        }

        const baseScorm = destino.url;
        const archivos = await obtenerArchivosScorm(baseScorm);
        const slugCarpeta = crearSlug(titulo);
        const slug = `modulo_${idModulo}/${slugCarpeta}`;
        const urlsPdfInternas = new Set();

        const BATCH_SIZE = 8;
        for (let i = 0; i < archivos.length; i += BATCH_SIZE) {
            const lote = archivos.slice(i, i + BATCH_SIZE);
            await Promise.all(lote.map(async (ruta) => {
                try {
                    const res = await fetch(baseScorm + ruta, { credentials: 'include' });
                    if (res.ok) {
                        const mime = getMimeType(ruta);
                        let bodySubida = null;

                        // Si es un archivo de datos/código del SCORM (ej. data.js, story.html), detectar si tiene un salto a un PDF de UVEG (como L3_Comic.pdf)
                        if (/\.(js|html|htm|xml|json)$/i.test(ruta)) {
                            let texto = await res.text();
                            const limpio = texto.replace(/\\\//g, '/');
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
                    }
                } catch (err) {
                    console.warn(`[UVEG Guardado] Error subiendo ${ruta}:`, err);
                }
            }));
        }

        for (const uPdf of urlsPdfInternas) {
            pdfsExtraDescubiertos.push(uPdf);
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
        const resp = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

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
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                IdModuloUveg: idStr,
                Modulo: nomStr
            })
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al registrar módulo.`);

        const res = await resp.json();
        return res.data || res;
    }

    async function actualizarModulo(idModuloDb, idModuloUveg, nombreVisual) {
        if (!idModuloDb) return null;
        try {
            const resp = await fetch(`${API_BASE_URL}/modulos/${encodeURIComponent(idModuloDb)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    IdModuloUveg: String(idModuloUveg).trim(),
                    Modulo: (nombreVisual || idModuloUveg).trim()
                })
            });
            if (resp.ok) {
                const res = await resp.json();
                return res.data || res;
            }
        } catch {}
        return null;
    }

    async function obtenerLeccionesDeModulo(idModulo) {
        const url = `${API_BASE_URL}/lecciones?IdModulo=${encodeURIComponent(idModulo)}`;
        const resp = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al consultar lecciones.`);

        const data = await resp.json();
        return Array.isArray(data) ? data : [];
    }

    async function crearLeccion(idModulo, codigo, nombre, urlLeccion) {
        const url = `${API_BASE_URL}/lecciones`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                IdModulo: idModulo,
                Codigo: codigo || SIN_TITULO,
                Nombre: nombre || codigo || SIN_TITULO,
                UrlLeccion: urlLeccion
            })
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al guardar lección "${codigo}".`);

        return await resp.json();
    }

    async function actualizarLeccion(idLeccion, codigo, nombre, urlLeccion) {
        if (!idLeccion) return null;
        try {
            const resp = await fetch(`${API_BASE_URL}/lecciones/${encodeURIComponent(idLeccion)}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    Codigo: codigo || SIN_TITULO,
                    Nombre: nombre || codigo || SIN_TITULO,
                    UrlLeccion: urlLeccion
                })
            });
            if (resp.ok) return await resp.json();
        } catch {}
        return null;
    }

    async function eliminarLeccion(idLeccion) {
        if (!idLeccion) return;
        try {
            await fetch(`${API_BASE_URL}/lecciones/${encodeURIComponent(idLeccion)}`, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json' }
            });
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

    // --- PROCESO PRINCIPAL DE GUARDADO Y PRESERVACIÓN ---

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

    async function ejecutarSincronizacion() {
        if (sincronizando || yaProcesado) return;
        sincronizando = true;

        try {
            const enPaginaPdfDirecta = esUrlPdfDirecto(window.location.href);
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

            // 2. Si estamos en la vista del curso en UVEG (y no en un PDF abierto directamente), escanear secciones 2, 3 y 4
            if (!enPaginaPdfDirecta && idModulo && hostname.endsWith('uveg.edu.mx')) {
                await escanearTodasLasSecciones(idModulo);
            }

            if (itemsAcumulados.length === 0) {
                return;
            }

            const mapaGlobalPLeccion = cargarMapaPLeccion(idModulo);

            // Deduplicar por URL y por clave de lección (sin que un PDF como L3_Comic colisione con el SCORM LEC_L3)
            const porClave = new Map();
            const sinNumero = [];
            const urlsUnicasVistas = new Set();

            for (const it of itemsAcumulados) {
                const norm = normalizarUrl(it.url);
                if (urlsUnicasVistas.has(norm)) continue;
                urlsUnicasVistas.add(norm);

                const cod = it.codigo || it.titulo || SIN_TITULO;
                const num = it.numero ?? extraerNumeroLeccion(cod);
                const nomVisual = (num !== null && num !== 999 && mapaGlobalPLeccion[String(num)])
                    ? mapaGlobalPLeccion[String(num)]
                    : (it.nombre || cod);

                const itemEnriquecido = {
                    ...it,
                    codigo: cod,
                    nombre: nomVisual,
                    titulo: cod,
                    numero: num !== null ? num : 999
                };

                if (num !== null && num !== 999) {
                    const clave = it.esPdf ? `${num}_pdf_${crearSlug(cod || it.url)}` : `${num}_main`;
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

            // 3. Consultar módulo en la API por IdModuloUveg
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

            // 4. Obtener lecciones registradas actualmente en ese módulo y limpiar registros residuales no migrados de mod/resource
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

            // 5. Filtrar las lecciones que aún no están registradas y actualizar metadatos (Codigo / Nombre de .leccion2-pLeccion) si ya existen
            const pendientes = [];

            for (const item of itemsUnicos) {
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

            // 6. Si ya todo está guardado y preservado: SILENCIO TOTAL
            if (pendientes.length === 0) {
                yaProcesado = true;
                return;
            }

            // 7. Procesar lecciones nuevas (SCORM y PDFs -> sube a Supabase y guarda link de Supabase; Genially -> guarda link directo)
            let exitosCount = 0;
            const erroresScorm = [];
            const pdfsExtraDescubiertos = [];
            const total = pendientes.length;

            for (let i = 0; i < total; i++) {
                const item = pendientes[i];
                let urlFinal = item.url;
                let codigoFinal = item.codigo || item.titulo;
                let nombreFinal = item.nombre || codigoFinal;

                if (esRecursoScorm(item.url)) {
                    // Si es un mod/resource suelto fuera de .container-lesson, verificar primero a dónde salta
                    if (item.requiereValidarSaltoPdf) {
                        try {
                            const destino = await resolverDestinoRecurso(item.url);
                            if (!destino || destino.tipo !== 'pdf') continue;

                            const nomPdf = extraerNombreArchivoPdf(destino.url) || '';
                            if (!REGEX_CODIGO_LECCION.test(nomPdf)) continue;

                            const codigoPdf = nomPdf.replace(/\.pdf$/i, '').trim();
                            const numPdf = extraerNumeroLeccion(codigoPdf);
                            const nombreVisualPdf = (numPdf !== null && mapaGlobalPLeccion[String(numPdf)])
                                ? mapaGlobalPLeccion[String(numPdf)]
                                : (item.nombre && item.nombre !== item.codigo ? item.nombre : codigoPdf);

                            const regPdfExistente = buscarExistentePorCodigoOUrl(existentes, codigoPdf, destino.url);
                            if (regPdfExistente) {
                                if (regPdfExistente.Codigo !== codigoPdf || regPdfExistente.Nombre !== nombreVisualPdf) {
                                    await actualizarLeccion(
                                        regPdfExistente.id || regPdfExistente.IdLeccion,
                                        codigoPdf,
                                        nombreVisualPdf,
                                        regPdfExistente.UrlLeccion
                                    );
                                }
                                continue;
                            }

                            mostrarToast({
                                tipo: 'info',
                                mensaje: `Preservando PDF en Supabase: ${codigoPdf}...`,
                                duracionMs: 0
                            });

                            const resPdf = await preservarPdfEnSupabase(idModulo, codigoPdf, destino.url, destino.blob || null);
                            codigoFinal = resPdf.tituloFinal || codigoPdf;
                            nombreFinal = nombreVisualPdf;
                            urlFinal = resPdf.urlPublica;
                        } catch {
                            continue;
                        }
                    } else {
                        mostrarToast({
                            tipo: 'info',
                            mensaje: `Preservando en Supabase (${i + 1}/${total}): ${codigoFinal}...`,
                            duracionMs: 0
                        });

                        try {
                            const resPreservado = await preservarScormEnSupabase(idModulo, codigoFinal, item.url, pdfsExtraDescubiertos);
                            codigoFinal = resPreservado.tituloFinal || codigoFinal;
                            const numRes = extraerNumeroLeccion(codigoFinal) ?? item.numero;
                            if (numRes !== null && numRes !== 999 && mapaGlobalPLeccion[String(numRes)]) {
                                nombreFinal = mapaGlobalPLeccion[String(numRes)];
                            }
                            urlFinal = resPreservado.urlPublica;
                        } catch (e) {
                            console.error(`[UVEG Guardado] Error al subir "${codigoFinal}" a Supabase:`, e);
                            erroresScorm.push(`${codigoFinal}: ${e.message}`);
                            continue;
                        }
                    }
                }

                if (!yaExisteEnLista(existentes, codigoFinal, urlFinal)) {
                    await crearLeccion(idModuloDb, codigoFinal, nombreFinal, urlFinal);
                    existentes.push({ Codigo: codigoFinal, Nombre: nombreFinal, UrlLeccion: urlFinal });
                    exitosCount++;
                }
            }

            // 7b. Si dentro de los archivos de un SCORM se detectaron saltos a PDFs de UVEG (como L3_Comic.pdf), preservarlos también
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

                try {
                    mostrarToast({
                        tipo: 'info',
                        mensaje: `Preservando PDF en Supabase: ${codigoPdf}...`,
                        duracionMs: 0
                    });
                    const resPdf = await preservarPdfEnSupabase(idModulo, codigoPdf, urlPdfExtra, null);
                    const codFinalPdf = resPdf.tituloFinal || codigoPdf;
                    if (!yaExisteEnLista(existentes, codFinalPdf, resPdf.urlPublica)) {
                        await crearLeccion(idModuloDb, codFinalPdf, nombreVisualPdf, resPdf.urlPublica);
                        existentes.push({ Codigo: codFinalPdf, Nombre: nombreVisualPdf, UrlLeccion: resPdf.urlPublica });
                        exitosCount++;
                    }
                } catch (e) {
                    console.warn(`[UVEG Guardado] Error al preservar PDF interno "${codigoPdf}":`, e);
                }
            }

            yaProcesado = true;

            // 8. Notificación discreta de resultado
            if (exitosCount > 0) {
                mostrarToast({
                    tipo: 'success',
                    mensaje: `Se han preservado y sincronizado ${exitosCount} lecciones en Supabase`,
                    duracionMs: 8000
                });
            } else if (erroresScorm.length > 0) {
                mostrarToast({
                    tipo: 'error',
                    mensaje: `No se pudo preservar recurso (${erroresScorm[0]})`,
                    duracionMs: 12000
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
