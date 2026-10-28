# UVEG - Extensión de Guardado Automático de Lecciones (v1.0.0 - Supabase SCORM + Genially)

Extensión de Google Chrome / Edge (**Manifest V3**) para el **Campus Virtual UVEG**. Sincroniza, preserva en **Supabase Storage** y almacena de forma **automática, silenciosa y desde la vista general del curso ("por arriba")** todas las lecciones del módulo en el sistema **Planificador Personal**.

---

## 1. Resumen de Funcionamiento Actual

Al entrar a la página principal de un curso en UVEG (por ejemplo, `https://avalicmod19d.uveg.edu.mx/course/view.php?id=324`), la extensión ejecuta automáticamente el siguiente flujo sin necesidad de entrar manualmente a cada lección:

1. **Escaneo Multi-Sección ("Por Arriba"):**
   - Escanea el DOM actual y realiza peticiones autenticadas (`credentials: 'include'`) en segundo plano a las secciones `mainsection=2`, `mainsection=3` y `mainsection=4` del curso (`/course/view.php?id={courseId}&mainsection={sec}`).
   - Ignora la ejecución si el usuario navega directamente dentro de páginas internas del reproductor (`/mod/scorm/`), operando únicamente desde la vista del curso.

2. **Detección Híbrida de las 12 Lecciones (Genially + SCORM) y Exclusión de Recursos/Ejercicios:**
   - **Lecciones Genially (`<iframe>`):** Detecta iframes alojados en `view.genially.com` / `view.genial.ly` y extrae su código de lección desde el atributo `title` (ej. `CPFI_L4`, `CPFI_L6`, `CPFI_L8`, `CPFI_L9`, `CPFI_L12`) o contenedor padre.
   - **Lecciones SCORM (`.container-lesson` / `id="LEC_L1"`):**
     - En UVEG, las lecciones SCORM se declaran como `<div class="container-lesson" id="LEC_L1">` con una imagen `<img class="img-recurso img-leccion mb-2" data-link="https://avalicmod19d.uveg.edu.mx/mod/scorm/view.php?id=3269">` sin texto interno.
     - La extensión extrae el código directamente del `id` del contenedor (`LEC_L1`, `LEC_L2`, `LEC_L3`, `LEC_L5`, `LEC_L7`, `LEC_L10`, `LEC_L11`) cuando no hay texto de encabezado.
     - Prioriza el selector `.img-leccion[data-link]` dentro de cada `.container-lesson` que no tenga ya un Genially, evitando guardar los paquetes SCORM correspondientes a **Ejercicios** (`id=3270`, `id=3272`, etc.).
   - **Exclusión y Limpieza de Archivos Adjuntos (`/mod/resource/` y `.pdf`):**
     - `esUrlRecurso` acepta únicamente URLs de Genially y `/mod/scorm/`.
     - Si en la base de datos existía algún registro residual de tipo `/mod/resource/` (como *"Tiempo estimado de revisión..."*), lo elimina automáticamente vía `DELETE /api/contabilidad/lecciones/{id}`.

3. **Ordenamiento Natural (`L1` a `L12`):**
   - Extrae el número de lección mediante `REGEX_CODIGO_LECCION` (`/(?:LEC[_-]?L|[A-Z0-9]+_L|_L|L[_-]|LECCION[_-]?\s*|\bL)[_-]?0*(\d+)(?!\d)/i`) y ordena todas las lecciones numéricamente de la `1` a la `12` antes de sincronizarlas.

4. **Resolución Profunda de Paquetes SCORM y Subida a Supabase Storage:**
   - Para cada lección SCORM (`view.php?id=...`), `resolverBaseScorm(url)` resuelve la ruta raíz real del paquete (`/pluginfile.php/{contextId}/mod_scorm/content/{revision}/`):
     1. Consulta `view.php?id={cmId}` (que en UVEG suele redirigir a `player.php?scoid=...&cm=...`).
     2. Extrae `scoid`, `a` (`aId`), `cm` (`cmId`) y `currentorg` mediante `extraerParametrosScorm()` desde:
        - Parámetros de la URL redirigida (`resView.url`).
        - Inputs ocultos del formulario `#scormviewform`.
        - Enlaces de la barra de navegación (`player.php?scoid=...&cm=...`).
        - Llamada inline de Moodle `M.mod_scorm.init(Y, ..., "1819", "4505", "CdlPFI_U1_L1_V0.1.5_ORG", ...)`.
     3. Invoca `loadSCO.php?a={aId}&scoid={scoid}` / `loadSCO.php?id={cmId}&scoid={scoid}` para capturar la redirección o el meta-refresh hacia `/pluginfile.php/.../mod_scorm/content/.../story.html`.
   - Descarga y parsea `imsmanifest.xml` (`obtenerArchivosScorm`) para obtener la lista completa de recursos del paquete (`story.html`, `index.html`, `html5/data/js/...`, `story_content/...`, audios, imágenes, fuentes).
   - Sube todos los archivos en lotes de 8 (`BATCH_SIZE = 8`) al bucket público `lecciones-scorm` de **Supabase Storage** con `x-upsert: true` bajo una ruta única por módulo y lección:
     ```text
     modulo_{idModulo}/{slug_titulo}/story.html
     ```
     Ejemplo:
     `https://yrdovjgddnjkgwommbqp.supabase.co/storage/v1/object/public/lecciones-scorm/modulo_324/lec_l1/story.html`

5. **Guardado y Deduplicación en la API Cloud (Laravel):**
   - Verifica o crea el módulo en `POST /api/contabilidad/modulos`.
   - Compara las lecciones detectadas contra `GET /api/contabilidad/lecciones?IdModulo={idModuloDb}` por URL normalizada, nombre normalizado, ruta `/<slug>/story.html` en Supabase o número de lección (`L1..L12`).
   - Registra únicamente las lecciones faltantes con `POST /api/contabilidad/lecciones` guardando en `UrlLeccion`:
     - El enlace directo de `https://view.genially.com/...` para lecciones Genially.
     - El enlace público de Supabase (`.../lecciones-scorm/modulo_324/<slug>/story.html`) para lecciones SCORM.

---

## 2. Estructura de Archivos

| Archivo | Propósito |
| :--- | :--- |
| `manifest.json` | Configuración Manifest V3, permisos de host (`*.uveg.edu.mx`, `*.supabase.co`, API Laravel Cloud) e inyección de `content.js` en `document_idle`. |
| `content.js` | Script principal de detección, escaneo multi-sección, extracción SCORM, subida a Supabase Storage y sincronización con la API. |
| `content.js.bak` | Copia de respaldo previa de `content.js`. |
| `prueba.html` | Archivo HTML local para pruebas de detección. |
| `img/` | Iconos de la extensión (`16`, `48`, `128`). |

---

## 3. Configuración y Constantes Clave (`content.js`)

```javascript
const API_BASE_URL = 'https://planificador-personal-production-jm5erh.laravel.cloud/api/contabilidad';
const SUPABASE_URL = 'https://yrdovjgddnjkgwommbqp.supabase.co';
const SUPABASE_BUCKET = 'lecciones-scorm';
const HOSTS_GENIALLY = ['view.genial.ly', 'view.genially.com', 'genial.ly', 'genially.com'];
const REGEX_CODIGO_LECCION = /(?:LEC[_-]?L|[A-Z0-9]+_L|_L|L[_-]|LECCION[_-]?\s*|\bL)[_-]?0*(\d+)(?!\d)/i;
```

---

## 4. Mapa de Funciones Principales en `content.js`

- **`obtenerIdModulo()`**: Obtiene el parámetro `?id=` de la URL del curso (ej. `324`).
- **`esUrlGenially(urlStr)`**: Determina si un recurso pertenece a Genially.
- **`esUrlRecurso(urlStr)`**: Filtra exclusivamente recursos válidos de lección (Genially o `/mod/scorm/`), descartando `/mod/resource/` y `.pdf`.
- **`esRecursoScorm(urlStr)`**: Identifica si una URL es un paquete SCORM que debe subirse a Supabase.
- **`extraerIdContenedorLeccion(el)`**: Sube por el árbol DOM buscando contenedores con ID de lección (`id="LEC_L1"`, `data-lesson`, etc.).
- **`extraerTitulo(iframe)` / `extraerTituloElemento(el, contextDoc, contenedorExplicito)`**: Extrae el código o título de la lección (`CPFI_L4`, `LEC_L1`, etc.).
- **`encontrarLeccionesEnDocumento(doc)`**:
  1. Recolecta todos los `<iframe>` de Genially y marca sus contenedores/números de lección como ocupados.
  2. Recorre todos los `.container-lesson, [id^="LEC_L"]` restantes y selecciona su `.img-leccion[data-link]` (excluyendo ejercicios SCORM).
  3. Incluye respaldo para elementos `.img-leccion[data-link]` fuera de contenedores estándar.
- **`escanearTodasLasSecciones(courseId)`**: Descarga en paralelo `mainsection=2, 3, 4` del curso en UVEG y acumula todas las lecciones.
- **`extraerParametrosScorm(html, pageUrl, previo)`**: Extrae `cmId`, `aId`, `scoid`, `currentorg`, `mode` y `attempt` desde query params, inputs de formulario y `M.mod_scorm.init(...)`.
- **`resolverBaseScorm(url)`**: Resuelve desde `view.php?id=...` -> `player.php` -> `loadSCO.php` hasta obtener la URL base `/pluginfile.php/.../mod_scorm/content/.../`.
- **`obtenerArchivosScorm(baseScorm)`**: Descarga `imsmanifest.xml` y extrae todos los archivos `<file href="...">` y `<resource href="...">` del paquete.
- **`preservarScormEnSupabase(idModulo, titulo, scormUrl)`**: Descarga todos los archivos del paquete SCORM desde UVEG y los sube a Supabase Storage en `modulo_{idModulo}/{slug}/{ruta}`, devolviendo la URL pública de `story.html`.
- **`ejecutarSincronizacion()`**: Orquesta todo el flujo, limpia registros `/mod/resource/` antiguos, deduplica contra la API y muestra notificaciones Toast discretas en la esquina superior derecha.

---

## 5. Instalación / Recarga en el Navegador

1. Abre `chrome://extensions/` en Chrome, Edge o Brave.
2. Activa el **Modo de desarrollador**.
3. Haz clic en **Cargar descomprimida** y selecciona:
   `C:\xampp\htdocs\uveg_extension_leccion_guardado`
4. Si realizas cambios en `content.js`, haz clic en el botón **Recargar (`⟳`)** de la tarjeta de la extensión y actualiza la página del curso en UVEG.
