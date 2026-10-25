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

    // 4. Configuración de API Cloud y dominios permitidos
    const API_BASE_URL = 'https://planificador-personal-production-jm5erh.laravel.cloud/api/contabilidad';
    const hostname = window.location.hostname.toLowerCase();
    const esDominioValido = hostname.endsWith('uveg.edu.mx') ||
                            hostname === 'localhost' ||
                            hostname === '127.0.0.1' ||
                            window.location.protocol === 'file:';

    if (!esDominioValido) {
        return;
    }

    const HOSTS_GENIALLY = ['view.genial.ly', 'view.genially.com', 'genial.ly', 'genially.com'];
    const ID_HOST = 'uveg-guardado-notif-host';
    const SIN_TITULO = '(sin título)';

    let sincronizando = false;
    let yaProcesado = false;
    let itemsAcumulados = [];
    let escaneandoSecciones = false;

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

    // --- IDENTIFICACIÓN DEL MÓDULO (SOLO ID SIMPLE) ---

    function obtenerIdModulo() {
        const params = new URLSearchParams(window.location.search);
        const urlId = params.get('id');
        if (urlId && urlId.trim()) {
            return urlId.trim();
        }

        // Si no se encuentra ?id= en la URL (ej. prueba.html local), se usa "324"
        return '324';
    }

    function esUrlRecurso(urlStr) {
        if (!urlStr) return false;
        try {
            const url = new URL(urlStr, window.location.href);
            const h = url.hostname.toLowerCase();
            const esGenially = HOSTS_GENIALLY.some(base => h === base || h.endsWith('.' + base));
            if (esGenially) return true;
            if (h.endsWith('uveg.edu.mx') && /[?&]mainsection=[234]($|&)/i.test(url.search)) {
                return true;
            }
        } catch {
            if (/view\.genial\.ly|view\.genially\.com/i.test(urlStr)) return true;
            if (/uveg\.edu\.mx.*[?&]mainsection=[234]/i.test(urlStr)) return true;
        }
        return false;
    }

    function extraerTitulo(iframe, contextDoc = document) {
        const titleAttr = (iframe.getAttribute('title') || '').trim();
        const ariaAttr = (iframe.getAttribute('aria-label') || '').trim();
        const nameAttr = (iframe.getAttribute('name') || '').trim();

        if (titleAttr && !/^(genially|view|iframe|embedded)$/i.test(titleAttr)) {
            return titleAttr;
        }
        if (ariaAttr && !/^(genially|view|iframe|embedded)$/i.test(ariaAttr)) {
            return ariaAttr;
        }

        try {
            const actividad = iframe.closest ? iframe.closest('.activity, .activityinstance, .contentitem, .section, .box, [id^="module-"]') : null;
            if (actividad) {
                const header = actividad.querySelector('.instancename, .activityname, h2, h3, h4, .mod-indent-outer');
                if (header) {
                    const textoLimpio = header.innerText ? header.innerText.split('\n')[0].replace(/\s+/g, ' ').trim() : header.textContent.split('\n')[0].replace(/\s+/g, ' ').trim();
                    if (textoLimpio.length > 2) {
                        return textoLimpio;
                    }
                }
            }

            let prev = iframe.previousElementSibling;
            while (prev) {
                if (/^H[1-6]$/i.test(prev.tagName) || (prev.classList && (prev.classList.contains('title') || prev.classList.contains('instancename')))) {
                    const texto = (prev.innerText || prev.textContent || '').trim();
                    if (texto) return texto;
                }
                prev = prev.previousElementSibling;
            }
        } catch {}

        if (titleAttr) return titleAttr;
        if (nameAttr) return nameAttr;
        return SIN_TITULO;
    }

    function encontrarIframesEnDocumento(doc = document) {
        const vistos = new Set();
        const encontrados = [];

        for (const iframe of doc.querySelectorAll('iframe')) {
            const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || iframe.src;
            if (!src || !esUrlRecurso(src)) continue;

            const urlNorm = normalizarUrl(src);
            if (vistos.has(urlNorm)) continue;
            vistos.add(urlNorm);

            const titulo = extraerTitulo(iframe, doc);
            encontrados.push({
                titulo: titulo,
                url: src
            });
        }

        return encontrados;
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
                    const resp = await fetch(urlSeccion, { credentials: 'same-origin' });
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

    // --- COMUNICACIÓN CON LA API CLOUD (SOLO ID SIMPLE) ---

    async function buscarModulo(idModulo) {
        const idStr = String(idModulo).trim();
        const url = `${API_BASE_URL}/modulos?Nombre=${encodeURIComponent(idStr)}`;
        const resp = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} al consultar módulo.`);
        }

        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
            const encontrado = data.find(m => String(m.Modulo).trim() === idStr);
            if (encontrado) {
                return encontrado;
            }
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

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} al registrar módulo.`);
        }

        const res = await resp.json();
        return res.data || res;
    }

    async function obtenerLeccionesDeModulo(idModulo) {
        const url = `${API_BASE_URL}/lecciones?IdModulo=${encodeURIComponent(idModulo)}`;
        const resp = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} al consultar lecciones existentes.`);
        }

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

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} al guardar lección "${nombre}".`);
        }

        return await resp.json();
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
            /* Verde Success Laravel (Emerald-600) */
            .toast-success {
                background-color: #059669;
                border: 1px solid #10b981;
            }
            /* Rojo Delete / Danger Laravel (Red-600) */
            .toast-error {
                background-color: #dc2626;
                border: 1px solid #ef4444;
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
        iconEl.textContent = tipo === 'success' ? '✓' : '⚠️';

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

    // --- PROCESO PRINCIPAL DE GUARDADO ---

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

            // 2. Si estamos en UVEG, escanear secciones adicionales
            const idModulo = obtenerIdModulo();
            if (idModulo && hostname.endsWith('uveg.edu.mx')) {
                await escanearTodasLasSecciones(idModulo);
            }

            // Si no hay ninguna lección en el DOM, no hacer nada
            if (itemsAcumulados.length === 0) {
                return;
            }

            // Deduplicar la lista acumulada de la página antes de consultar
            const itemsUnicos = [];
            const urlsUnicasVistas = new Set();
            for (const it of itemsAcumulados) {
                const norm = normalizarUrl(it.url);
                if (!urlsUnicasVistas.has(norm)) {
                    urlsUnicasVistas.add(norm);
                    itemsUnicos.push(it);
                }
            }

            // 3. Consultar si el módulo ya existe en la API con su ID simple (ej. "324")
            let modulo = await buscarModulo(idModulo);
            let idModuloDb = null;

            if (modulo) {
                idModuloDb = modulo.id || modulo.IdModulo;
            } else {
                // Si no existe, crear el módulo con solo el ID simple
                const nuevoModulo = await crearModulo(idModulo);
                idModuloDb = nuevoModulo.id || nuevoModulo.IdModulo;
            }

            if (!idModuloDb) {
                throw new Error('No se pudo determinar el ID del módulo en la base de datos.');
            }

            // 4. Obtener lecciones registradas actualmente en ese módulo
            const existentes = await obtenerLeccionesDeModulo(idModuloDb);

            // 5. Comparar de forma robusta si la lección ya existe por URL canónica O por Título
            const faltantes = itemsUnicos.filter(item => {
                const itemUrlNorm = normalizarUrl(item.url);
                const itemNomNorm = normalizarTexto(item.titulo);
                const tieneTituloValido = itemNomNorm && itemNomNorm !== 'sin titulo';

                const yaRegistrada = existentes.some(ex => {
                    const exUrlNorm = normalizarUrl(ex.UrlLeccion);
                    const exNomNorm = normalizarTexto(ex.Nombre);

                    // 1) Coincidencia por URL canónica de Genially/recurso
                    if (itemUrlNorm && exUrlNorm && itemUrlNorm === exUrlNorm) {
                        return true;
                    }

                    // 2) Coincidencia por Título limpio (si ambos tienen título válido)
                    if (tieneTituloValido && exNomNorm && itemNomNorm === exNomNorm) {
                        return true;
                    }

                    return false;
                });

                return !yaRegistrada;
            });

            // 6. Si ya tiene todas cargadas: SILENCIO TOTAL (no muestra nada)
            if (faltantes.length === 0) {
                yaProcesado = true;
                return;
            }

            // 7. Guardar lecciones faltantes
            let guardadasCount = 0;
            for (const item of faltantes) {
                await crearLeccion(idModuloDb, item.titulo, item.url);
                guardadasCount++;
            }

            yaProcesado = true;

            // 8. Notificación discreta de éxito en la esquina superior derecha
            if (guardadasCount > 0) {
                mostrarToast({
                    tipo: 'success',
                    mensaje: `Se han guardado ${guardadasCount} lecciones`,
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
            setTimeout(ejecutarSincronizacion, 600);
        });
    } else {
        setTimeout(ejecutarSincronizacion, 600);
    }
})();
