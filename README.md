# Control de Prácticas Profesionalizantes

Sistema educativo para la Escuela Técnica N° 10 de San Luis: alumnos, prácticas, horas por tipo, asistencia, informes y avisos.

## Configuración actual: servicios gratuitos

Seguir [CONFIGURACION_GRATUITA.md](CONFIGURACION_GRATUITA.md). Esta versión usa GitHub Pages, Firebase Spark, Google Drive y Google Apps Script/MailApp. No requiere Blaze, Cloud Functions, Cloud Scheduler ni EmailJS.

Las correcciones de asistencia, importación y horas se describen en [CORRECCIONES_Y_DESPLIEGUE.md](CORRECCIONES_Y_DESPLIEGUE.md).

Para páginas de 20, filtros, índices y preparación del historial: [GUIA_CONSULTAS_EFICIENTES.md](GUIA_CONSULTAS_EFICIENTES.md). Para el error 429: [OPTIMIZACION_FIRESTORE.md](OPTIMIZACION_FIRESTORE.md).

El sitio consulta Firestore con Firebase Authentication y reglas por rol. Los avisos se solicitan desde Avisos y se procesan aproximadamente cada hora en un script privado autorizado por un docente. Cada recordatorio adjunta el acuerdo PDF del alumno y práctica correspondiente. No se publica un endpoint de correo.

## Estructura

- `index.html`, `css/`, `img/`, `js/`: sitio de GitHub Pages.
- `firestore.rules`, `firestore.indexes.json`, `firebase.json`: permisos, índices y emulador. Desplegar reglas e índices; esperar que estén habilitados.
- `js/record-pages.mjs`: páginas de 20, cursores y búsquedas normalizadas.
- `apps-script/`: copiar Code.gs, Firestore.gs, Domain.gs y el manifiesto a un proyecto privado de Apps Script.
- `scripts/prepare-apps-script.mjs`: genera Domain.gs desde las reglas de negocio del sitio.
- `tests/`: pruebas de horas, Apps Script, interfaz y reglas.

## Desarrollo

Con Node 22 actualizado: `npm ci`, `npm run prepare:apps-script`, `npm test` y `npm run test:rules` (necesita Java 17 para el emulador configurado). Para servir el sitio local: `python3 -m http.server 8000`.

Las pruebas no envían correos reales. Apps Script debe autorizarse y probarse en la cuenta que lo ejecutará. El proyecto de Firebase debe conservar Spark y su facturación deshabilitada. Las cuotas gratuitas pueden detener operaciones; no se intenta ampliar cuotas mediante un plan pago.

Estado: código preparado y verificado localmente, pendiente de publicación y configuración en la cuenta del usuario.
