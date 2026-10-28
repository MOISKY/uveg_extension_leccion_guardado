# UVEG - Extensión de Guardado Automático de Lecciones (v1.1.0 - Supabase SCORM + PDF + Genially)

Extensión de Google Chrome / Edge (**Manifest V3**) para el **Campus Virtual UVEG**. Sincroniza, preserva en **Supabase Storage** (tanto paquetes interactivos **SCORM** como documentos **PDF** tipo `L3_Comic.pdf`) y almacena de forma **automática, silenciosa y desde la vista general del curso ("por arriba")** todas las lecciones del módulo en el sistema **Planificador Personal**.

---

## 1. Resumen de Funcionamiento Actual

Al entrar a la página principal de un curso en UVEG (por ejemplo, `https://avalicmod19d.uveg.edu.mx/course/view.php?id=324`) o al abrir un enlace que salte a un PDF de lección (`.../pluginfile.php/8852/mod_resource/content/5/L3_Comic.pdf`), la extensión ejecuta automáticamente el siguiente flujo:

1. **Escaneo Multi-Sección ("Por Arriba") y Detección de Salto Directo a PDF:**
   - En la vista del curso (`/course/view.php?id={courseId}`), guarda el `id` del módulo activo en `localStorage` (`uveg_ultimo_modulo_id`) y escanea el DOM actual junto con las secciones `mainsection=2`, `mainsection=3` y `mainsection=4` en segundo plano (`credentials: 'include'`).
   - Si el navegador da un salto directo a una pestaña PDF de UVEG (`.../pluginfile.php/.../L3_Comic.pdf`), detecta automáticamente el archivo PDF en curso, recupera el `id` del módulo activo y lo preserva en Supabase.

2. **Detección Híbrida de Lecciones (Genially + SCORM + PDFs de Lección):**
   - **Lecciones Genially (`<iframe>`):** Detecta iframes alojados en `view.genially.com` / `view.genial.ly` y extrae su código de lección desde el atributo `title` (ej. `CPFI_L4`, `CPFI_L6`, `CPFI_L8`, `CPFI_L9`, `CPFI_L12`) o contenedor padre.
   - **Lecciones SCORM (`.container-lesson` / `id="LEC_L1"`):**
     - Extrae el código directamente del `id` del contenedor (`LEC_L1`, `LEC_L2`, `LEC_L3`, `LEC_L5`, `LEC_L7`, `LEC_L10`, `LEC_L11`) cuando no hay texto de encabezado.
     - Prioriza el selector `.img-leccion` (ya sea con `data-link`, envuelto en `<a href="...">` o `onclick`) dentro de cada `.container-lesson` que no tenga ya un Genially, evitando guardar los paquetes SCORM correspondientes a **Ejercicios** (`id=3270`, `id=3272`, etc.).
   - **Lecciones o Recursos PDF (`mod_resource` / `.pdf` como `L3_Comic.pdf`):**
     - Soporta los **3 escenarios** donde aparece un PDF de lección:
       1. **Desde `.container-lesson` o `/mod/resource/view.php?id=...` en el curso:** Sigue el salto (redirección HTTP o HTML intermedio) hasta `.../pluginfile.php/.../*.pdf`.
       2. **Dentro de archivos internos de un paquete SCORM (`data.js`, `story.html`, etc.):** Mientras sube un SCORM, escanea su código en busca de saltos a `/pluginfile.php/.../*.pdf`, sube automáticamente esos PDFs a Supabase Storage, reescribe el link dentro del SCORM para que apunte a Supabase y registra el PDF en la base de datos.
       3. **Salto directo en pestaña del navegador (`.../L3_Comic.pdf`):** Si el usuario abre el PDF en una pestaña, lo descarga, lo sube a Supabase Storage y lo registra en la base de datos.
     - Limpia automáticamente cualquier registro viejo no migrado a Supabase cuyo nombre sea `"Tiempo estimado..."` o apunte a `/mod/resource/` crudo de UVEG.

3. **Ordenamiento Natural (`L1` a `L12`) sin Colisión entre SCORM y PDF:**
   - Ordena las lecciones numéricamente de la `1` a la `12` usando `REGEX_CODIGO_LECCION`.
   - Permite que convivan la lección SCORM (`LEC_L3` $\rightarrow$ `story.html`) y su cómic PDF (`L3_Comic` $\rightarrow$ `L3_Comic.pdf`) sin sobrescribirse entre sí.

4. **Resolución Profunda de Destinos (`resolverDestinoRecurso`) y Subida a Supabase Storage:**
   - **Si el destino es un paquete SCORM:**
     1. Extrae `scoid`, `a` (`aId`), `cm` (`cmId`) y `currentorg` desde la URL redirigida, `#scormviewform` y `M.mod_scorm.init(...)`.
     2. Consulta `loadSCO.php` para obtener la ruta base `/pluginfile.php/{contextId}/mod_scorm/content/{revision}/`.
     3. Lee `imsmanifest.xml`, descarga todos los recursos y los sube en lotes de 8 al bucket `lecciones-scorm` en:
        `https://yrdovjgddnjkgwommbqp.supabase.co/storage/v1/object/public/lecciones-scorm/modulo_{idModulo}/{slug}/story.html`
   - **Si el destino da un salto a un PDF (`destino.tipo === 'pdf'`):**
     1. Descarga el binario del PDF con las credenciales de sesión de UVEG.
     2. Lo sube a Supabase Storage con `Content-Type: application/pdf` y `x-upsert: true` en:
        `https://yrdovjgddnjkgwommbqp.supabase.co/storage/v1/object/public/lecciones-scorm/modulo_{idModulo}/{slug}/{archivo}.pdf`

5. **Soporte de PDFs y SCORM en `planificador_personal` (`IframeModal`):**
   - En `resources/js/components/contabilidad/lecciones/iframe-modal.tsx`:
     - **`esSupabaseHtml` (`.html`):** Descarga el `story.html` e inyecta `<base>` y el interceptor de prototipos (`DATA_PATH_BASE`, `script.src`, `img.src`, `fetch`, `XMLHttpRequest`) mediante `srcDoc`.
     - **`esSupabasePdf` (`.pdf`):** Descarga el PDF desde Supabase (`arrayBuffer`), crea un `new Blob([buffer], { type: 'application/pdf' })` con `URL.createObjectURL(blob)` y lo carga en el `<iframe>` para renderizar el visor nativo de PDF sin bloqueos de `Content-Security-Policy: sandbox`.

---

## 2. Estructura de Archivos

| Archivo | Propósito |
| :--- | :--- |
| `manifest.json` | Configuración Manifest V3, permisos de host (`*.uveg.edu.mx`, `*.supabase.co`, API Laravel Cloud) e inyección de `content.js` en `document_idle`. |
| `content.js` | Script principal de detección, escaneo multi-sección, extracción SCORM y PDF, subida a Supabase Storage y sincronización con la API. |
| `RESPALDO_EXTENSION.md` | Respaldo íntegro con el código fuente completo de `manifest.json`, `content.js` e `iframe-modal.tsx`. |
| `prueba.html` | Archivo HTML local para pruebas de detección. |
| `img/` | Iconos de la extensión (`16`, `48`, `128`). |

---

## 3. Mapa de Funciones Principales en `content.js`

- **`obtenerIdModulo()`**: Obtiene y persiste en `localStorage` el `?id=` del curso (ej. `324`) para reutilizarlo incluso cuando el navegador salta a un PDF en `/pluginfile.php/...`.
- **`esUrlPdfDirecto(urlStr)` / `extraerNombreArchivoPdf(urlStr)`**: Detecta URLs `.pdf` y extrae el nombre limpio del archivo (ej. `L3_Comic.pdf`).
- **`extraerElementoYUrlDeContenedor(cont)`**: Busca el recurso de lección dentro de `.container-lesson` priorizando `.img-leccion` (atributos `data-link`, `<a href>` padre o `onclick`).
- **`encontrarLeccionesEnDocumento(doc)`**: Detecta PDFs abiertos directamente en pestaña, iframes de Genially, contenedores `.container-lesson` (`#LEC_L1..#LEC_L12`) y enlaces a recursos PDF de lección.
- **`resolverDestinoRecurso(url)`**: Sigue los saltos desde `view.php` $\rightarrow$ `player.php` $\rightarrow$ `loadSCO.php` y distingue automáticamente si el destino final es un paquete SCORM (`{ tipo: 'scorm', url }`) o un documento PDF (`{ tipo: 'pdf', url, blob }`).
- **`preservarPdfEnSupabase(idModulo, tituloPreferido, urlPdf, blobPreCargado)`**: Sube el archivo `.pdf` a Supabase Storage con `Content-Type: application/pdf` y devuelve su URL pública.
- **`preservarScormEnSupabase(idModulo, titulo, scormUrl, pdfsExtraDescubiertos)`**: Sube todos los archivos del paquete SCORM (o delega a `preservarPdfEnSupabase` si el salto aterrizó en un PDF) y detecta saltos a PDFs dentro del código del SCORM.
- **`ejecutarSincronizacion()`**: Orquesta todo el flujo, deduplica con `yaExisteEnLista()` y muestra notificaciones Toast discretas en la esquina superior derecha.

---

## 4. Instalación / Recarga en el Navegador

1. Abre `chrome://extensions/` en Chrome, Edge o Brave.
2. Activa el **Modo de desarrollador**.
3. Haz clic en **Cargar descomprimida** y selecciona:
   `C:\xampp\htdocs\uveg_extension_leccion_guardado`
4. Si realizas cambios en `content.js`, haz clic en el botón **Recargar (`⟳`)** de la tarjeta de la extensión y actualiza la página del curso en UVEG.
