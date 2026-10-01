# Recuperación de acceso y reducción de consumo — 30/09/2026

La actualización posterior de páginas de 20 y filtros se instala con GUIA_CONSULTAS_EFICIENTES.md. Esa guía reemplaza la instrucción de subir solamente tres archivos: ahora también hacen falta index.html, record-pages.mjs, reglas e índices.

El error HTTP 429 / resource-exhausted en BatchGetDocuments indica un límite de Firestore. La captura no identifica cuál: confirmar en Uso y Cuotas. Es distinto al fallo DNS anterior y no implica pérdida de datos o cuenta.

## Confirmar y recuperar

1. Abrir https://console.firebase.google.com/ y seleccionar control-practicas-f7b5a.
2. Ir a Firestore Database → Uso. Revisar lecturas y escrituras del día. Si no alcanza para explicar el error, consultar también las cuotas de la API Cloud Firestore en Google Cloud.
3. Mantener Spark sin facturación. La cuota gratuita incluye 50.000 lecturas y 20.000 escrituras diarias para la base gratuita. Se comparte entre todos los usuarios y Apps Script.
4. Si se agotó la cuota diaria, esperar su renovación: aproximadamente a medianoche del Pacífico (el 30/09 equivale a las 04:00 de San Luis del día siguiente). No se reinicia cerrando sesión, cambiando clave ni publicando código.
5. Cerrar pestañas repetidas del sitio. Si Apps Script también registra resource-exhausted, ejecutar detenerAvisos mientras dure el incidente. Esto pausa correos y asistencia del script. Después ejecutar instalarAvisos para recuperar el disparador; no crear disparadores duplicados ni ejecutar el procesador repetidamente.
6. Reemplazar los archivos del sitio por esta versión: js/app.js, js/attendance-store.mjs y el nuevo js/firestore-access.mjs. Mantener las mismas carpetas. El ZIP contiene además todas las correcciones previas y la configuración gratuita.
7. Recargar el sitio con Ctrl+Shift+R. Tras recuperar la cuota, abrir Asistencia una vez, esperar la revisión y comprobar los totales.

## Qué cambia

- El ingreso y la navegación general ya no sincronizan todo el historial. Se sincroniza con el botón de Asistencia y en operaciones específicas de guardado/fusión. Apps Script mantiene la revisión horaria reciente.
- Una asistencia canónica correcta ya leída no se vuelve a leer dentro de una transacción. Las correcciones manuales, ausencias y supresiones se conservan. Cambiar el horario sí actualiza registros automáticos; los duplicados históricos todavía se revisan con transacciones.
- Máximo 30 operaciones de sincronización por revisión. El historial pendiente se informa; al volver a Asistencia después de cinco minutos continúa sin duplicar jornadas. No se acredita lo pendiente hasta que tenga registro válido.
- Las consultas equivalentes y documentos se reutilizan durante 60 segundos dentro de la pestaña; solicitudes simultáneas se agrupan. No se guardan datos de alumnos en una caché persistente. Cambiar usuario limpia la memoria. Toda escritura invalida esta caché; cambios desde otro equipo pueden tardar hasta un minuto en reflejarse. Recargar fuerza una lectura.
- Abrir la ficha de un alumno consulta sus asistencias por alumnoId, no toda la colección.
- Un error de cuota pausa nuevas solicitudes del sistema durante un minuto. No recupera la cuota ni evita solicitudes que ya estuvieran en vuelo. Datos que ya estén en la caché pueden seguir mostrándose durante su vigencia.
- Si falla la lectura del perfil por cuota, se informa el fallo; no se convierte silenciosamente al docente en un usuario sin perfil.

## Alcance y límites

Se conservan consultas completas para estadísticas e informes generales; la caché reduce repeticiones, no el tamaño de la primera carga. El consumo restante depende de la cantidad de registros, usuarios y sesiones. Las reglas que leen perfiles también pueden añadir lecturas. Apps Script sigue leyendo prácticas y asistencia reciente aproximadamente cada hora. Si crece el uso, el siguiente cambio será paginación real en el servidor y consultas por períodos, preservando informes históricos.

La paginación visual de tablas no reduce por sí sola las lecturas si la consulta primero descarga toda la colección.

Fuentes: https://firebase.google.com/docs/firestore/quotas y https://firebase.google.com/docs/firestore/pricing.

Pruebas locales: historial estable sin transacciones, cambio de horario, conservación manual, límite por revisión, caché/expiración, invalidación, concurrencia y pausa de cuota, interfaz y motor de avisos. No se accedió a datos reales ni se verificó la cuota real del proyecto. Publicación en GitHub pendiente de autorización explícita; no se modificó el sitio público.
