# Respaldo Completo de la Extensión (`uveg_extension_leccion_guardado`)

Fecha de respaldo: `2026-10-28`  
Ubicación: `C:\xampp\htdocs\uveg_extension_leccion_guardado`

Este documento contiene la arquitectura detallada y el código íntegro de `manifest.json` y `content.js` de la versión funcional actual (detección de las 12 lecciones `L1..L12` desde la vista general del curso, preservación automática de paquetes SCORM en Supabase Storage y sincronización con la API de Laravel Cloud).

---

## 1. Resumen de la Versión Actual

- **Escaneo desde la página del curso ("por arriba"):** Recorre el documento actual y las secciones `mainsection=2, 3, 4` del curso en UVEG sin necesidad de abrir cada lección manualmente.
- **Detección de las 12 lecciones (`L1` a `L12`):**
  - **5 Lecciones Genially (`CPFI_L4`, `CPFI_L6`, `CPFI_L8`, `CPFI_L9`, `CPFI_L12`):** Extraídas desde los `<iframe>` de Genially.
  - **7 Lecciones SCORM (`LEC_L1`, `LEC_L2`, `LEC_L3`, `LEC_L5`, `LEC_L7`, `LEC_L10`, `LEC_L11`):** Extraídas desde `<div class="container-lesson" id="LEC_L...">` priorizando `.img-leccion[data-link]` e ignorando los botones de ejercicios SCORM.
- **Exclusión y limpieza de recursos adjuntos:** Ignora enlaces `/mod/resource/` y `.pdf` (como *"Tiempo estimado de revisión..."*) y elimina de la base de datos cualquier registro residual de ese tipo.
- **Extracción SCORM y subida a Supabase Storage:**
  - Extrae `scoid`, `a`, `cm` y `currentorg` desde la redirección a `player.php`, inputs de `#scormviewform` y `M.mod_scorm.init(...)`.
  - Consulta `loadSCO.php` para obtener la ruta base `/pluginfile.php/.../mod_scorm/content/.../`.
  - Lee `imsmanifest.xml`, descarga todos los archivos del paquete y los sube al bucket `lecciones-scorm` en `modulo_{idModulo}/{slug}/story.html`.

---

## 2. `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "UVEG - Guardado de Lecciones",
  "version": "1.0.0",
  "description": "Sincroniza y guarda automáticamente las lecciones de UVEG de forma discreta.",
  "icons": {
    "16": "img/icon-16.png",
    "48": "img/icon-48.png",
    "128": "img/icon-128.png"
  },
  "action": {
    "default_icon": {
      "16": "img/icon-16.png",
      "48": "img/icon-48.png",
      "128": "img/icon-128.png"
    }
  },
  "content_scripts": [
    {
      "matches": [
        "https://*.uveg.edu.mx/*",
        "http://localhost/*",
        "http://127.0.0.1/*",
        "file:///*"
      ],
      "js": [
        "content.js"
      ],
      "all_frames": false,
      "run_at": "document_idle"
    }
  ],
  "host_permissions": [
    "https://*.uveg.edu.mx/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
    "https://planificador-personal-production-jm5erh.laravel.cloud/*",
    "https://*.supabase.co/*"
  ]
}
```

---

## 3. `content.js` (Código Completo)

```javascript
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

    // 5. Evitar ejecución dentro de páginas internas del reproductor SCORM (solo operar desde la vista del curso "por arriba")
    if (/\/mod\/scorm\/|\/mod_scorm\//i.test(window.location.pathname)) {
        return;
    }

    const HOSTS_GENIALLY = ['view.genial.ly', 'view.genially.com', 'genial.ly', 'genially.com'];
    const ID_HOST = 'uveg-guardado-notif-host';
    const SIN_TITULO = '(sin título)';
    const REGEX_CODIGO_LECCION = /(?:LEC[_-]?L|[A-Z0-9]+_L|_L|L[_-]|LECCION[_-]?\s*|\bL)[_-]?0*(\d+)(?!\d)/i;

    let sincronizando = false;
    let yaProcesado = false;
    let itemsAcumulados = [];
    let escaneandoSecciones = false;

    // --- MIME TYPES & SLUG PARA SUPABASE ---

    function getMimeType(filename) {
        const ext = (filename || '').split('.').pop().toLowerCase();
        const map = {
            'html': 'text/html',
            'htm': 'text/html',
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
        const m = String(texto).match(REGEX_CODIGO_LECCION);
        return m ? parseInt(m[1], 10) : null;
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

    // --- IDENTIFICACIÓN DEL MÓDULO ---

    function obtenerIdModulo() {
        const params = new URLSearchParams(window.location.search);
        const urlId = params.get('id');
        if (urlId && urlId.trim()) {
            return urlId.trim();
        }
        return '324';
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
            }
        } catch {
            if (/mod\/scorm|mod_scorm/i.test(urlStr)) return true;
        }
        return false;
    }

    function esRecursoScorm(urlStr) {
        if (!urlStr) return false;
        const u = urlStr.toLowerCase();
        if (HOSTS_GENIALLY.some(base => u.includes(base))) return false;
        return u.includes('/mod/scorm/') || u.includes('/mod_scorm/') || u.includes('scoid=') || u.includes('story.html');
    }

    // --- EXTRACCIÓN DE TÍTULOS Y CÓDIGOS (%L%, LEC_L1, CPFI_L4) ---

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

    function extraerTituloElemento(el, contextDoc = document, contenedorExplicito = null) {
        if (!el) return SIN_TITULO;
        if (el.tagName === 'IFRAME') {
            return extraerTitulo(el, contextDoc);
        }

        try {
            const contenedor = contenedorExplicito || (el.closest ? el.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"], .activity, .activityinstance, .contentitem, .section, .box, [id^="module-"]') : null);

            if (contenedor) {
                const tituloUveg = contenedor.querySelector('.titulo, .title, .nombre-leccion');
                if (tituloUveg) {
                    const txt = (tituloUveg.innerText || tituloUveg.textContent || '').replace(/\s+/g, ' ').trim();
                    if (txt.length > 2 && !/^(recursos|tiempo estimado)/i.test(txt)) {
                        return txt;
                    }
                }

                // Si el contenedor tiene un ID de lección tipo id="LEC_L1", usarlo directamente
                const idCont = (contenedor.getAttribute && contenedor.getAttribute('id')) || contenedor.id || '';
                if (idCont && REGEX_CODIGO_LECCION.test(idCont) && !/^module-/i.test(idCont)) {
                    return idCont.trim();
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

            const idAncestro = extraerIdContenedorLeccion(el);
            if (idAncestro) {
                return idAncestro;
            }

            const titleAttr = (el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim();
            if (titleAttr && !/^(genially|view|iframe|embedded|icono|imagen|recurso)$/i.test(titleAttr)) {
                return titleAttr.replace(/\s+/g, ' ');
            }
        } catch {}

        return SIN_TITULO;
    }

    function encontrarLeccionesEnDocumento(doc = document) {
        const vistos = new Set();
        const encontrados = [];
        const contenedoresConGenially = new Set();
        const numerosConGenially = new Set();

        // 1. Rastreo de Iframes de Genially (ej. CPFI_L4, CPFI_L6, CPFI_L8, CPFI_L9, CPFI_L12)
        for (const iframe of doc.querySelectorAll('iframe')) {
            const rawSrc = iframe.getAttribute('src') || iframe.getAttribute('data-src') || iframe.src;
            if (!rawSrc || !esUrlGenially(rawSrc)) continue;

            let src = rawSrc;
            try { src = new URL(rawSrc, window.location.href).href; } catch {}

            const titulo = extraerTitulo(iframe, doc);
            if (/^(english|español|saltar|salir)/i.test(titulo.trim())) continue;

            const urlNorm = normalizarUrl(src);
            if (vistos.has(urlNorm)) continue;
            vistos.add(urlNorm);

            const contPadre = iframe.closest ? iframe.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"]') : null;
            if (contPadre) {
                contenedoresConGenially.add(contPadre);
                const numCont = extraerNumeroLeccion(contPadre.id);
                if (numCont !== null) numerosConGenially.add(numCont);
            }

            const numTitulo = extraerNumeroLeccion(titulo);
            if (numTitulo !== null) {
                numerosConGenially.add(numTitulo);
            }

            encontrados.push({
                titulo: titulo,
                url: src,
                numero: numTitulo !== null ? numTitulo : 999
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

            // Priorizar la imagen de lección (.img-leccion) sobre otros recursos del contenedor (como ejercicios)
            const elLeccion = (cont.querySelector && (
                cont.querySelector('.img-leccion[data-link]') ||
                cont.querySelector('.img-leccion [data-link]') ||
                cont.querySelector('[data-link*="/mod/scorm/"]') ||
                cont.querySelector('[data-link*="/mod_scorm/"]') ||
                cont.querySelector('a[href*="/mod/scorm/"]') ||
                cont.querySelector('[data-link]')
            )) || cont;

            const rawAttr = elLeccion.getAttribute ? (elLeccion.getAttribute('data-link') || elLeccion.getAttribute('href')) : null;
            if (!rawAttr || !esUrlRecurso(rawAttr)) continue;

            let rawUrl = rawAttr;
            try { rawUrl = new URL(rawAttr, window.location.href).href; } catch {}

            const titulo = extraerTituloElemento(elLeccion, doc, cont);
            if (!titulo || titulo === SIN_TITULO) continue;
            if (/^(english|español|saltar|salir)/i.test(titulo.trim())) continue;

            const urlNorm = normalizarUrl(rawUrl);
            if (vistos.has(urlNorm)) continue;
            vistos.add(urlNorm);

            const num = numLeccion !== null ? numLeccion : (extraerNumeroLeccion(titulo) ?? 999);
            encontrados.push({
                titulo: titulo,
                url: rawUrl,
                numero: num
            });
        }

        // 3. Respaldo para elementos .img-leccion o SCORM sueltos fuera de .container-lesson
        for (const el of doc.querySelectorAll('.img-leccion[data-link], [data-link*="/mod/scorm/"], [data-link*="/mod_scorm/"]')) {
            const padreCont = el.closest ? el.closest('.container-lesson, [id^="LEC_L"], [id^="lec_l"]') : null;
            if (padreCont && contenedoresProcesados.has(padreCont)) continue;

            const rawAttr = el.getAttribute('data-link') || el.getAttribute('href');
            if (!rawAttr || !esUrlRecurso(rawAttr)) continue;

            let rawUrl = rawAttr;
            try { rawUrl = new URL(rawAttr, window.location.href).href; } catch {}

            const titulo = extraerTituloElemento(el, doc, padreCont);
            if (!titulo || titulo === SIN_TITULO) continue;
            if (/^(english|español|saltar|salir)/i.test(titulo.trim())) continue;

            const num = extraerNumeroLeccion(titulo);
            if (num !== null && numerosConGenially.has(num)) continue;

            const urlNorm = normalizarUrl(rawUrl);
            if (vistos.has(urlNorm)) continue;
            vistos.add(urlNorm);

            encontrados.push({
                titulo: titulo,
                url: rawUrl,
                numero: num !== null ? num : 999
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

    // --- RESOLUCIÓN Y SUBIDA SCORM A SUPABASE STORAGE ---

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
            const desdeUrl = extraerRutaContent(resSco.url);
            if (desdeUrl) return desdeUrl;

            if (resSco.ok) {
                const htmlSco = await resSco.text();
                const desdeHtml = extraerRutaContent(htmlSco);
                if (desdeHtml) return desdeHtml;
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
            const ruta = await probarLoadSco(cand);
            if (ruta) return ruta;
        }
        return null;
    }

    async function resolverBaseScorm(url) {
        const directo = extraerRutaContent(url);
        if (directo) return directo;

        try {
            const uObj = new URL(url, window.location.href);
            const origin = uObj.origin;
            let estadoParams = extraerParametrosScorm('', uObj.href, {});

            // Paso 1: Consultar la URL inicial (por ejemplo, /mod/scorm/view.php?id=3269)
            const resView = await fetch(uObj.href, { credentials: 'include' });
            const desdeViewUrl = extraerRutaContent(resView.url);
            if (desdeViewUrl) return desdeViewUrl;

            if (!resView.ok) return null;
            const htmlView = await resView.text();
            const baseActual = resView.url || uObj.href;

            const desdeViewHtml = extraerRutaContent(htmlView);
            if (desdeViewHtml) return desdeViewHtml;

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
                    const desdePlayerUrl = extraerRutaContent(resPlayer.url);
                    if (desdePlayerUrl) return desdePlayerUrl;

                    if (resPlayer.ok) {
                        const htmlPlayer = await resPlayer.text();
                        const desdePlayerHtml = extraerRutaContent(htmlPlayer);
                        if (desdePlayerHtml) return desdePlayerHtml;

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
            console.warn('[UVEG Guardado] Error al resolver base SCORM:', e);
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

    async function preservarScormEnSupabase(idModulo, titulo, scormUrl) {
        const baseScorm = await resolverBaseScorm(scormUrl);
        if (!baseScorm) {
            throw new Error('No se pudo localizar la ruta base del paquete SCORM');
        }

        const archivos = await obtenerArchivosScorm(baseScorm);
        const slugCarpeta = crearSlug(titulo);
        const slug = `modulo_${idModulo}/${slugCarpeta}`;

        const BATCH_SIZE = 8;
        for (let i = 0; i < archivos.length; i += BATCH_SIZE) {
            const lote = archivos.slice(i, i + BATCH_SIZE);
            await Promise.all(lote.map(async (ruta) => {
                try {
                    const res = await fetch(baseScorm + ruta, { credentials: 'include' });
                    if (res.ok) {
                        const blob = await res.blob();
                        const mime = getMimeType(ruta);
                        const rutaEnBucket = `${slug}/${ruta}`.replace(/\/+/g, '/');
                        await subirArchivoSupabase(rutaEnBucket, blob, mime);
                    }
                } catch (err) {
                    console.warn(`[UVEG Guardado] Error subiendo ${ruta}:`, err);
                }
            }));
        }

        return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${slug}/story.html`;
    }

    // --- COMUNICACIÓN CON LA API CLOUD (LARAVEL) ---

    async function buscarModulo(idModulo) {
        const idStr = String(idModulo).trim();
        const url = `${API_BASE_URL}/modulos?Nombre=${encodeURIComponent(idStr)}`;
        const resp = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al consultar módulo.`);

        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
            const encontrado = data.find(m => String(m.Modulo).trim() === idStr);
            if (encontrado) return encontrado;
        }
        return null;
    }

    async function crearModulo(idModulo) {
        const idStr = String(idModulo).trim();
        const url = `${API_BASE_URL}/modulos`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ Modulo: idStr })
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al registrar módulo.`);

        const res = await resp.json();
        return res.data || res;
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

    async function crearLeccion(idModulo, nombre, urlLeccion) {
        const url = `${API_BASE_URL}/lecciones`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                IdModulo: idModulo,
                Nombre: nombre || SIN_TITULO,
                UrlLeccion: urlLeccion
            })
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status} al guardar lección "${nombre}".`);

        return await resp.json();
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

    async function ejecutarSincronizacion() {
        if (sincronizando || yaProcesado) return;
        sincronizando = true;

        try {
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

            // 2. Si estamos en UVEG, escanear las secciones 2, 3 y 4 del curso
            const idModulo = obtenerIdModulo();
            if (idModulo && hostname.endsWith('uveg.edu.mx')) {
                await escanearTodasLasSecciones(idModulo);
            }

            if (itemsAcumulados.length === 0) {
                return;
            }

            // Deduplicar por URL y por número de lección (priorizando Genially si hubiera duplicado)
            const porNumero = new Map();
            const sinNumero = [];
            const urlsUnicasVistas = new Set();

            for (const it of itemsAcumulados) {
                const norm = normalizarUrl(it.url);
                if (urlsUnicasVistas.has(norm)) continue;
                urlsUnicasVistas.add(norm);

                const num = it.numero ?? extraerNumeroLeccion(it.titulo);
                if (num !== null && num !== 999) {
                    const existente = porNumero.get(num);
                    if (!existente || (esUrlGenially(it.url) && !esUrlGenially(existente.url))) {
                        porNumero.set(num, { ...it, numero: num });
                    }
                } else {
                    sinNumero.push({ ...it, numero: 999 });
                }
            }

            const itemsUnicos = [
                ...Array.from(porNumero.values()).sort((a, b) => a.numero - b.numero),
                ...sinNumero
            ];

            // 3. Consultar módulo en la API
            let modulo = await buscarModulo(idModulo);
            let idModuloDb = null;

            if (modulo) {
                idModuloDb = modulo.id || modulo.IdModulo;
            } else {
                const nuevoModulo = await crearModulo(idModulo);
                idModuloDb = nuevoModulo.id || nuevoModulo.IdModulo;
            }

            if (!idModuloDb) {
                throw new Error('No se pudo determinar el ID del módulo en la base de datos.');
            }

            // 4. Obtener lecciones registradas actualmente en ese módulo y limpiar recursos que no son lecciones (ej. mod/resource)
            const existentesRaw = await obtenerLeccionesDeModulo(idModuloDb);
            const existentes = [];

            for (const ex of existentesRaw) {
                const urlEx = (ex.UrlLeccion || '').toLowerCase();
                if (urlEx.includes('/mod/resource/') || urlEx.includes('/mod_resource/')) {
                    await eliminarLeccion(ex.id || ex.IdLeccion);
                    continue;
                }
                existentes.push(ex);
            }

            // 5. Filtrar únicamente las lecciones que aún no están registradas en la base de datos
            const pendientes = [];

            for (const item of itemsUnicos) {
                const itemUrlNorm = normalizarUrl(item.url);
                const itemNomNorm = normalizarTexto(item.titulo);
                const itemSlug = crearSlug(item.titulo);
                const itemNum = item.numero !== 999 ? item.numero : extraerNumeroLeccion(item.titulo);

                const coincide = existentes.find(ex => {
                    const exUrl = ex.UrlLeccion || '';
                    const exUrlNorm = normalizarUrl(exUrl);
                    const exNomNorm = normalizarTexto(ex.Nombre);
                    const exNum = extraerNumeroLeccion(ex.Nombre);

                    if (itemUrlNorm && exUrlNorm && itemUrlNorm === exUrlNorm) return true;
                    if (itemNomNorm && exNomNorm && itemNomNorm === exNomNorm) return true;
                    if (itemSlug && exUrl.toLowerCase().includes(`/${itemSlug}/story.html`)) return true;
                    if (itemNum !== null && exNum !== null && itemNum === exNum) return true;
                    return false;
                });

                if (!coincide) {
                    pendientes.push(item);
                }
            }

            // 6. Si ya todo está guardado y preservado: SILENCIO TOTAL
            if (pendientes.length === 0) {
                yaProcesado = true;
                return;
            }

            // 7. Procesar lecciones nuevas (SCORM -> sube a Supabase y guarda link de Supabase; Genially -> guarda link directo)
            let exitosCount = 0;
            const erroresScorm = [];
            const total = pendientes.length;

            for (let i = 0; i < total; i++) {
                const item = pendientes[i];
                let urlFinal = item.url;

                if (esRecursoScorm(item.url)) {
                    mostrarToast({
                        tipo: 'info',
                        mensaje: `Preservando en Supabase (${i + 1}/${total}): ${item.titulo}...`,
                        duracionMs: 0
                    });

                    try {
                        urlFinal = await preservarScormEnSupabase(idModulo, item.titulo, item.url);
                    } catch (e) {
                        console.error(`[UVEG Guardado] Error al subir SCORM "${item.titulo}" a Supabase:`, e);
                        erroresScorm.push(`${item.titulo}: ${e.message}`);
                        continue;
                    }
                }

                await crearLeccion(idModuloDb, item.titulo, urlFinal);
                exitosCount++;
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
                    mensaje: `No se pudo preservar SCORM (${erroresScorm[0]})`,
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
```

