# UVEG - Extensión de Guardado Automático de Lecciones

Extensión ligera de Google Chrome / Edge (Manifest V3) para el **Campus Virtual UVEG**. Sincroniza y almacena de forma **automática, silenciosa y discreta** las lecciones del curso en el sistema Planificador Personal.

## Características

- **Sin interfaz invasiva:** No cuenta con paneles ni botones permanentes en la pantalla.
- **Detección inteligente:**
  - Extrae el ID del curso/módulo desde la URL (`?id=...`).
  - Si no existe (ej. pruebas locales), usa el identificador predeterminado `324`.
- **Deduplicación contra la API Cloud:**
  - Consulta `https://planificador-personal-production-jm5erh.laravel.cloud/api/contabilidad`.
  - Si el módulo no existe, lo crea automáticamente.
  - Compara las lecciones del DOM contra las existentes en la base de datos.
- **Comportamiento discreto:**
  - Si **todas las lecciones ya están cargadas**: no muestra nada (silencio absoluto).
  - Si **guarda lecciones nuevas**: muestra un toast discreto: `✓ Se han guardado N lecciones [✕]`.
  - Si **ocurre un error de conexión**: muestra un indicador en rojo: `⚠️ Error al guardar: [mensaje] [✕]`.

## Instalación en el Navegador

1. Abre tu navegador basado en Chromium (Google Chrome, Microsoft Edge, Brave, etc.).
2. Dirígete a `chrome://extensions/`.
3. Activa el **Modo de desarrollador** en la esquina superior derecha.
4. Haz clic en **Cargar descomprimida** y selecciona esta carpeta:
   `C:\xampp\htdocs\uveg_extension_leccion_guardado`
5. ¡Listo! Al ingresar a un curso de UVEG o abrir `prueba.html`, la sincronización se ejecutará automáticamente.
