# UVEG - Extensión de Guardado Automático de Lecciones (v1.2.0 - `IdModuloUveg` + `Codigo` + `<p class="leccion2-pLeccion">` + Supabase SCORM/PDF/Genially)

Extensión de Google Chrome / Edge (**Manifest V3**) para el **Campus Virtual UVEG**. Sincroniza, preserva en **Supabase Storage** (tanto paquetes interactivos **SCORM** como documentos **PDF** tipo `L3_Comic.pdf`) y almacena de forma **automática, silenciosa y desde la vista general del curso ("por arriba")** todas las lecciones del módulo en el sistema **Planificador Personal**.

---

## 1. Arquitectura de Datos Actual (`planificador_personal` + Extensión)

### A) Tabla `contabilidad_modulo`
| Campo | Propósito en el Sistema | Origen en la Extensión UVEG | Comportamiento en UI (`planificador_personal`) |
| :--- | :--- | :--- | :--- |
| **`IdModuloUveg`** | **Llave de búsqueda y operaciones** (`?IdModuloUveg=324`). Todas las búsquedas y deduplicaciones operan sobre este campo. | Parámetro `?id=324` de la URL del curso (persistido en `localStorage` bajo `uveg_ultimo_modulo_id`). | Se puede **agregar y editar en el Drawer**, pero **no se muestra en la tabla (`DataTable`)**. |
| **`Modulo`** *(Nombre visual)* | Nombre descriptivo de la materia para mostrar visualmente en todo el sistema. | Etiqueta `<h1>` general de la página del curso en UVEG (persistido en `localStorage` bajo `uveg_ultimo_modulo_nombre`). | Se **muestra en el `DataTable`** y se puede **agregar y editar en el Drawer**. |

### B) Tabla `contabilidad_modulo_leccion`
| Campo | Propósito en el Sistema | Origen en la Extensión UVEG | Comportamiento en UI (`planificador_personal`) |
| :--- | :--- | :--- | :--- |
| **`Codigo`** | **Llave de búsqueda, deduplicación y carpeta en Supabase** (`LEC_L1`, `CPFI_L4`, `L3_Comic`). Todas las búsquedas (`?Codigo=...`) y `updateOrCreate` operan sobre este campo. | `id` del contenedor (`LEC_L1..LEC_L11`), `title` del iframe Genially (`CPFI_L4..CPFI_L12`) o nombre del archivo PDF (`L3_Comic`). | Se puede **agregar y editar en el Drawer** y se muestra en la **primera columna (`Código`)** de la tabla. |
| **`Nombre`** *(Nombre visual)* | Título completo de la lección para mostrar visualmente al usuario. | Texto de `<p class="leccion2-pLeccion">Lección 1. Definición y disposiciones generales de las personas físicas</p>` (mapeado por unidad y número de lección `1..12` en `localStorage`). | Se puede **agregar y editar en el Drawer** y se muestra **al lado derecho de la columna `Código`** en la tabla. |
| **`UrlLeccion`** | Enlace público de **Supabase Storage** (`.../story.html` o `.../*.pdf`) o enlace directo de **Genially**. | Generado tras subir el paquete SCORM o PDF al bucket `lecciones-scorm` en Supabase. | Abre el visor modal interactivo (`IframeModal`). |

> **Regla especial para PDFs de salto (ej. `L3_Comic.pdf`)**:
> Cuando se detecta un PDF de salto adicional cuyo código es `L3_Comic` (lección `3`), su campo **`Codigo`** se guarda como `"L3_Comic"` y su campo **`Nombre`** toma exactamente el mismo `<p class="leccion2-pLeccion">` de la **Lección 3**. Como la llave de búsqueda y carpeta en Supabase es `Codigo`, ambos registros (`LEC_L3` y `L3_Comic`) conviven con el mismo `Nombre` visual sin colisionar ni sobrescribirse.

---

## 2. Resumen del Flujo de Sincronización ("Por Arriba")

Al entrar a la página principal de un curso en UVEG (`https://avalicmod19d.uveg.edu.mx/course/view.php?id=324`) o al abrir un enlace que salte a un PDF de lección (`.../pluginfile.php/8852/mod_resource/content/5/L3_Comic.pdf`), la extensión ejecuta automáticamente:

1. **Captura del Módulo (`IdModuloUveg` + `<h1>`) y Escaneo Multi-Sección (`mainsection=2, 3, 4`):**
   - Guarda `IdModuloUveg` (`324`) y el texto del `<h1>` general en `localStorage`.
   - Escanea en segundo plano (`credentials: 'include'`) las Unidades 1, 2 y 3 (`mainsection=2, 3, 4`).
   - Extrae todos los `<p class="leccion2-pLeccion">` de las 3 unidades y construye un diccionario por número de lección (`1` al `12`) en `localStorage` (`uveg_mapa_pleccion_324`).

2. **Detección Híbrida de Lecciones (Genially + SCORM + PDFs de Salto):**
   - **Lecciones Genially (`<iframe>`):** Extrae `Codigo` (`CPFI_L4`, `CPFI_L6`, `CPFI_L8`, `CPFI_L9`, `CPFI_L12`) y le asocia su `Nombre` desde `<p class="leccion2-pLeccion">` de la lección correspondiente.
   - **Lecciones SCORM (`.container-lesson` / `id="LEC_L1..L11"`):** Prioriza `.img-leccion`, extrae `Codigo` (`LEC_L1..L11`) y su `Nombre` desde `<p class="leccion2-pLeccion">`, ignorando ejercicios SCORM secundarios.
   - **Saltos a PDF (`L3_Comic.pdf`):** Soporta saltos desde `.container-lesson` / `mod_resource`, saltos internos dentro de archivos `data.js`/`story.html` de un SCORM, y pestañas donde se abre directamente el `.pdf`.

3. **Resolución Profunda (`resolverDestinoRecurso`) y Subida a Supabase Storage:**
   - **SCORM:** Extrae `scoid`, `aId`, `cmId` y `currentorg` (`M.mod_scorm.init` / `#scormviewform`), consulta `loadSCO.php`, lee `imsmanifest.xml` y sube todos los archivos en lotes de 8 a:
     `https://yrdovjgddnjkgwommbqp.supabase.co/storage/v1/object/public/lecciones-scorm/modulo_{IdModuloUveg}/{slug_codigo}/story.html`
   - **PDF:** Descarga el binario del PDF y lo sube con `Content-Type: application/pdf` a:
     `https://yrdovjgddnjkgwommbqp.supabase.co/storage/v1/object/public/lecciones-scorm/modulo_{IdModuloUveg}/{slug_codigo}/{archivo}.pdf`

4. **Sincronización y Auto-Actualización en Base de Datos:**
   - Busca el módulo por `?IdModuloUveg=324`. Si ya existía sin `IdModuloUveg` o sin el título del `<h1>`, lo actualiza automáticamente vía `PUT`.
   - Compara las lecciones existentes por `Codigo`. Si una lección ya existía en Supabase pero aún no tenía su `Codigo` o su `Nombre` de `<p class="leccion2-pLeccion">`, actualiza sus metadatos vía `PUT` sin volver a subir los archivos.

---

## 3. Mapa de Funciones Principales en `content.js`

- **`obtenerIdModulo()` / `obtenerNombreModuloH1(doc)`**: Extraen y persisten en `localStorage` el `IdModuloUveg` (`324`) y el nombre visual del `<h1>`.
- **`extraerMapaPLeccionDeDocumento(doc, idModulo)` / `obtenerNombrePLeccion(...)`**: Construyen y consultan el diccionario de `<p class="leccion2-pLeccion">` para las lecciones `1` a `12`.
- **`extraerCodigoElemento(...)`**: Obtiene el código interno (`LEC_L1`, `CPFI_L4`, `L3_Comic`).
- **`encontrarLeccionesEnDocumento(doc)`**: Detecta las lecciones devolviendo `{ codigo, nombre, url, numero, esPdf }`.
- **`resolverDestinoRecurso(url)`**: Desambigua si un recurso aterriza en un paquete SCORM o da un salto a un archivo PDF.
- **`preservarScormEnSupabase(...)` / `preservarPdfEnSupabase(...)`**: Suben paquetes SCORM y documentos PDF a Supabase Storage usando `crearSlug(codigo)`.
- **`buscarModulo` / `crearModulo` / `actualizarModulo` / `crearLeccion` / `actualizarLeccion`**: Sincronizan con `/api/contabilidad/modulos` y `/api/contabilidad/lecciones`.

---

## 4. Instalación / Recarga en el Navegador

1. Abre `chrome://extensions/` en Chrome, Edge o Brave.
2. Activa el **Modo de desarrollador**.
3. Haz clic en **Cargar descomprimida** y selecciona:
   `C:\xampp\htdocs\uveg_extension_leccion_guardado`
4. Si realizas cambios en `content.js`, haz clic en el botón **Recargar (`⟳`)** de la tarjeta de la extensión y actualiza la página del curso en UVEG.

---

## 5. Nota de Desarrollo Pendiente (Roadmap)

> [!NOTE]
> **Escenario pendiente a desarrollo: Detector de Videos / YouTube en Iframes**
> - Actualmente la extensión detecta y procesa `iframes` de Genially (`view.genially.com` / `genial.ly`), paquetes SCORM (`mod_scorm`) y documentos PDF (`mod_resource` / `.pdf`).
> - **Pendiente a desarrollo:** Implementar el escenario de detección y sincronización para `iframes` o contenedores que incrusten **videos o reproductores de YouTube** (`youtube.com/embed/...`, `youtu.be`, `vimeo.com`, o reproductores de video embebidos) dentro de las lecciones.
