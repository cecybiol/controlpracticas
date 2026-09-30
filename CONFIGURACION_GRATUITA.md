# Configuración gratuita — Control de Prácticas

Esta guía reemplaza la configuración anterior con Cloud Functions y EmailJS. Usar este paquete nuevo. Mantener Firebase en Spark y sin cuenta de facturación asociada: no activar Blaze, Cloud Functions, Cloud Scheduler ni Secret Manager. No se necesitan claves privadas de EmailJS ni cuentas de servicio.

Estado: implementado y probado localmente, pendiente de instalar en las cuentas del docente y de publicar el frontend. No se enviaron correos reales durante estas pruebas.

## 1. Preparar los acuerdos

Abrir https://drive.google.com/drive/folders/16RT_GoWf_acRnlvK1o995H3_6Aul0kla y subir los acuerdos individuales completados en PDF. El script no rellena ni convierte las plantillas Word.

Ejemplo: `melissabarbeito-ulp-helpdesk.pdf`. Relaciona nombre y apellido, Lugar y Sector/Carrera. Se normalizan tildes y mayúsculas. En la práctica se puede cargar Nombre del acuerdo PDF para indicar un archivo exacto y evitar ambigüedades.

La cuenta Google que ejecutará Apps Script debe tener acceso de lectura y descarga a Acuerdos. Si es otra cuenta, compartir la carpeta con su correo como Lector. Los PDF duplicados, ausentes o inválidos bloquean el envío correspondiente. El límite configurado es 8 MiB por PDF.

## 2. Publicar las reglas de Firestore

En https://console.firebase.google.com/ seleccionar `control-practicas-f7b5a`.

1. Confirmar que el plan sea Spark. No activar facturación.
2. En Authentication identificar el UID del administrador.
3. En Firestore Database → usuarios verificar que el documento cuyo ID coincide con ese UID tenga `rol: admin`. Los docentes pueden tener `rol: tutor`.
4. En Firestore Database → Reglas pegar el contenido de `firestore.rules` de este paquete y Publicar.

También se pueden desplegar sólo las reglas con Firebase CLI: `npx firebase-tools@latest deploy --project control-practicas-f7b5a --only firestore:rules`. No ejecutar un despliegue de functions.

Las reglas permiten que docentes creen solicitudes de correo y consulten resultados. Los alumnos no pueden pedir envíos. Los docentes tampoco pueden falsificar resultados o liberar bloqueos de intentos desde el navegador.

## 3. Preparar el acceso del script a Firestore

El script usa el OAuth de la cuenta Google que lo autoriza y permisos IAM sobre el proyecto de Firebase. No usa la contraseña de Firebase ni su clave API pública como credencial de administración.

1. Entrar a https://console.cloud.google.com/ con la cuenta que ejecutará el script y seleccionar `control-practicas-f7b5a`.
2. En IAM y administración → IAM verificar que esa cuenta tenga acceso al proyecto. Si ya es propietaria, dispone de ese acceso. Si no, el propietario puede asignarle el rol Usuario de Cloud Datastore (`roles/datastore.user`) para leer y actualizar Firestore.
3. En APIs y servicios → Biblioteca verificar que Cloud Firestore API esté habilitada.
4. Anotar el número de proyecto desde la página de información del proyecto. El número configurado actualmente es `575083696161`; comprobarlo en la consola antes de usarlo.

No compartir el proyecto de Apps Script con alumnos: actúa con los permisos de la cuenta que instala el disparador.

## 4. Crear el proyecto de Apps Script

1. Abrir https://script.google.com/ e iniciar sesión con la cuenta remitente elegida.
2. Crear Nuevo proyecto y llamarlo `ControlPracticas — Avisos gratuitos`.
3. En el editor, reemplazar Code.gs con `apps-script/Code.gs` del paquete.
4. Crear dos archivos de secuencia de comandos: Firestore y Domain. Pegar, respectivamente, `apps-script/Firestore.gs` y `apps-script/Domain.gs`.
5. En Configuración del proyecto marcar Mostrar archivo de manifiesto appsscript.json en el editor.
6. Reemplazar el manifiesto con `apps-script/appsscript.json`.
7. En Configuración del proyecto → Proyecto de Google Cloud Platform → Cambiar proyecto, asociarlo al número del proyecto Firebase comprobado en el paso 3. Esto permite administrar los permisos OAuth y habilitar las API en el proyecto correcto; no habilita facturación.
8. Si solicita configurar OAuth, hacerlo en Google Auth Platform / Pantalla de consentimiento de ese proyecto: nombre de la aplicación y correo de soporte. Para una organización educativa que disponga de la opción, seleccionar audiencia Interna y autorizar desde una cuenta de ese dominio. Para una cuenta personal, configurar audiencia Externa y añadir la cuenta remitente a los usuarios de prueba para la instalación inicial.
9. Guardar los archivos.

El script pide permisos para leer Drive, enviar correo, acceder a Firestore, realizar peticiones HTTP y administrar su disparador. No pide leer los correos recibidos ni editar archivos de Drive. Autorizar únicamente el proyecto propio que acabás de crear y cuyos archivos revisaste. Si la institución bloquea estos permisos, debe intervenir su administrador.

Para una audiencia Externa que quede en modo Testing, la autorización OAuth puede caducar a los siete días. Antes de usarlo de manera estable, revisar Audience / Audiencia y el estado de publicación; usar el modo de producción adecuado para el uso privado de la cuenta, o la audiencia Interna cuando corresponda. Publicar el estado OAuth no implica publicar un web app: este script no tiene un endpoint público. La verificación o aprobación que Google o la institución exijan depende de la cuenta y permisos; no se garantiza desde el código local.

## 5. Autorizar y comprobar, sin enviar

En el selector de funciones del editor elegir `comprobarConexion` y Ejecutar. Completar la autorización de Google para los permisos del manifiesto.

El registro de ejecución debería mostrar `conexion: correcta`, el nombre de Acuerdos y los destinatarios disponibles. Esta función no envía correos.

Si Firestore devuelve HTTP 403, revisar el proyecto asociado, Cloud Firestore API, el permiso IAM de la cuenta Google y los scopes del manifiesto. Si Drive no permite leer, revisar que la cuenta Google tenga acceso a la carpeta y que sus archivos permitan descarga.

## 6. Instalar el disparador

Elegir `instalarAvisos` y Ejecutar una vez. La función comprueba la conexión e instala un disparador de tiempo que ejecuta `procesarControlPracticas` aproximadamente cada hora. Repetir la instalación no crea disparadores duplicados para esa cuenta.

Consultar Disparadores, icono del reloj, para verificarlo. No hay que usar Implementar → Aplicación web. No hay que copiar una URL ni configurar una clave de servidor en el sitio.

El correo sale desde la cuenta que instala el disparador. Mantener una sola instalación autorizada; cambiar de cuenta requiere retirar el disparador anterior. `detenerAvisos` retira el disparador de esa cuenta. Los bloqueos de Firestore evitan duplicar avisos de una misma práctica incluso si hay una ejecución concurrente.

## 7. Publicar el sitio actualizado

En https://github.com/cecybiol/controlpracticas subir los archivos del paquete conservando la estructura, sin crear otra carpeta controlpracticas dentro del repositorio.

Como mínimo actualizar `index.html`, `js/app.js`, `js/domain.mjs` y `js/firebase-config.js`, además de conservar `js/attendance-store.mjs` y publicar las reglas nuevas. Guardar también `apps-script/`, `scripts/`, `tests/` y los documentos de configuración para que el código sea revisable.

No subir `node_modules`, credenciales ni carpetas `.git`. Si aplicaste la versión anterior, retirar sus archivos de `functions/` y `scripts/prepare-functions.mjs`: esta versión no los utiliza. El firebase.json nuevo no tiene configuración de Functions.

Recargar el sitio de GitHub Pages con Ctrl+Shift+R. En Avisos debe aparecer Apps Script y botones de Solicitar envío.

## 8. Probar una solicitud de comprobación

En Avisos configurar carpeta y hora desde la que puede enviar. Elegir los días de anticipación, por ejemplo siete. Mantener Automático desactivado durante la prueba y Guardar configuración.

Crear o revisar una práctica próxima dentro de ese rango con alumno, correo, lugar, sector y PDF correctos. Presionar Comprobar acuerdos y programación sin enviar.

El sistema registra la solicitud como pendiente; eso no significa que haya enviado correos. Para procesarla inmediatamente, ejecutar `procesarControlPracticas` desde el editor de Apps Script. Luego volver a Avisos y pulsar Actualizar estado de solicitudes. El resultado debe mostrar listo y el PDF seleccionado, o explicar el bloqueo.

## 9. Prueba real y activación

Seleccionar una sola práctica y un destinatario autorizado para la prueba. Presionar Solicitar envío a los seleccionados con su acuerdo PDF. Ejecutar `procesarControlPracticas` manualmente o esperar al disparador.

Comprobar el mensaje recibido, el adjunto correcto y el historial. Enviado significa que MailApp aceptó el envío, no una garantía de entrega en la bandeja.

Luego activar Automático y Guardar configuración. El script sólo considera prácticas por jornadas que empiezan entre hoy y el límite de anticipación, no archivadas, canceladas ni ya avisadas. No envía recordatorios automáticos de prácticas que ya empezaron en una fecha anterior.

La hora es aproximada: si se configura 08:00, enviará en una ejecución desde esa hora, normalmente dentro de la siguiente hora. Las solicitudes manuales también esperan al próximo disparador, aunque esté desactivado el aviso automático; se pueden adelantar ejecutando el script manualmente.

## Cuotas y límites

- Apps Script consulta `MailApp.getRemainingDailyQuota()` antes de enviar. La copia CC también consume cuota de destinatarios.
- Google publica actualmente 100 destinatarios diarios para cuentas personales y 1.500 para Google Workspace, con diferencias según cuenta/dominio y cambios posibles. No es necesario comprar Workspace: funciona con una cuenta personal dentro de su cuota. La función consulta la cuota real de la cuenta.
- El límite interno es de 20 intentos de envío por ejecución y una ejecución horaria. Si falta cuota o se llega al límite, se conserva la solicitud pendiente y se reevalúa en otra ejecución. Una práctica que pasa de fecha deja de ser candidata automática; revisar los resultados de solicitudes pendientes y las fechas.
- Los límites de Firestore Spark también se comparten entre todas las personas y el script. Consultar Uso en Firebase. El sitio dejó de releer toda la base cada minuto; actualiza al abrir cada vista. El trabajador lee prácticas aproximadamente cada hora, por lo que su consumo crece con el historial. No se afirma que un volumen ilimitado quepa en las cuotas gratuitas.
- La sincronización de asistencia en segundo plano comienza por ayer y hoy en la primera instalación y conserva su fecha de avance. Se limita a 30 jornadas por ejecución; el historial completo sigue revisándose mediante la sincronización docente del sitio. No fabrica días de cronogramas ambiguos.
- Google permite seis minutos por ejecución de Apps Script. El trabajador usa un presupuesto aproximado de cuatro minutos para dejar tiempo de registrar el resultado; el tiempo de una llamada externa individual sigue dependiendo de Google.

Al alcanzar una cuota, las operaciones pueden detenerse. Manteniendo Spark sin facturación no se convierten en cargos automáticos.

## Intentos inciertos y diagnóstico

Ver Ejecuciones en Apps Script y Último control en Avisos. Un intento de correo `enviando` o `requiere_revision` bloquea reenvíos. Primero revisar la cuenta remitente y la evidencia de entrega. Sólo si se confirmó que no se envió, un administrador con acceso a Firestore puede cambiar el intento a error y crear otra solicitud. No borrar los intentos para forzar reenvíos.

Una solicitud `procesando` que nunca terminó también requiere revisión manual; no se reintenta automáticamente para evitar repetir correos particulares cuyo envío pudo haber sido aceptado. Las comprobaciones nunca envían.

## Fuentes oficiales

- https://developers.google.com/apps-script/guides/services/quotas
- https://developers.google.com/apps-script/reference/mail/mail-app
- https://developers.google.com/apps-script/reference/script/clock-trigger-builder
- https://developers.google.com/apps-script/guides/cloud-platform-projects
- https://developers.google.com/apps-script/concepts/scopes
- https://developers.google.com/identity/protocols/oauth2
- https://firebase.google.com/docs/firestore/use-rest-api
- https://firebase.google.com/docs/firestore/quotas
