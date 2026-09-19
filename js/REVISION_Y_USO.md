# Control de prácticas: revisión y archivos corregidos

Revisión del 14/09/2026 sobre index(7).html, app(8).js, drive.js y firebase-config.js.

## Instalación

1. Hacé una copia de los archivos actuales.
2. Reemplazá `index.html`, `js/app.js` y `js/drive.js` por los incluidos en este paquete, respetando las carpetas.
3. Conservá tu `js/firebase-config.js`, `css/style.css` y el resto del proyecto. La configuración recibida tiene los campos requeridos y no fue modificada. Este ZIP es una actualización, no una copia completa del proyecto.
4. Abrí el sitio desde su servidor habitual y recargá con Ctrl+F5. Los módulos necesitan un servidor HTTP/HTTPS; no abrir index.html con doble clic.

## El sistema genera las planillas

No es necesario preparar archivos externos ni pedir una nueva exportación al asistente. Los botones generan Excel a partir de los datos del sistema.

| Vista y botón | Contenido generado |
| --- | --- |
| Alumnos → Exportar a Excel | Listado filtrado y datos de contacto. |
| Ficha / Editar → Exportar ficha a Excel | Cinco hojas: ficha y totales, prácticas, asistencias, faltas e informes con enlaces. Usa los datos guardados, no las modificaciones sin guardar del formulario. |
| Fechas de práctica → Exportar a Excel | Prácticas visibles y acumulados completos del alumno. |
| Resumen por práctica → Exportar resumen a Excel | Cuatro hojas: resumen por lugar, detalle por alumno, períodos y criterios/filtros. Actualiza los datos antes de exportar. Para un lugar concreto, filtrarlo antes. |
| Asistencia → Exportar asistencias a Excel | Todos los registros del alumno elegido o de todos los alumnos. Incluye más de los 100 que muestra la pantalla. |
| Faltas → Exportar faltas a Excel | Fechas, alumnos, justificaciones y motivos según el alumno seleccionado. |
| Estadísticas → Exportar a Excel | Horas realizadas, pendientes, por tipo, avance y faltantes del listado visible. |
| Importar → Descargar plantilla | Plantilla de carga generada por el sistema. |

Los nuevos libros ajustan el ancho de las columnas y permiten filtrar las tablas. Conservan tildes y valores numéricos. Si no carga el componente de Excel se informa el problema; requiere conectividad para cargar la dependencia externa.

## Correcciones aplicadas

- El Excel de prácticas tenía dos columnas de acumulados siempre vacías. Ahora utiliza los mismos acumulados que la pantalla, incluyendo las prácticas del alumno fuera del filtro.
- Se agregaron las exportaciones de ficha, resumen, asistencias y faltas.
- Los cálculos de acumulados convierten horas numéricas guardadas como texto, incluyendo coma decimal, para evitar concatenaciones y fallos de formato. Los valores no numéricos o negativos se consideran cero al mostrar/exportar: revisar esos datos originales si existen.
- La edición rápida rechaza horas negativas o no finitas y días por semana fuera de 1–7.
- Se reutilizan las ventanas modales y se limpian las principales cachés de alumnos y prácticas al cerrar sesión.
- El historial de correos solicita solo los últimos 30 registros, en vez de descargar todo y recortarlo después.
- Las alertas muestran texto sin interpretar HTML recibido en errores.
- Drive reconoce también documentos nativos de Google, informa errores de autorización y sesión vencida, mantiene paginación y caché, y evita ráfagas de consultas a subcarpetas mediante un recorrido secuencial. Esto puede tardar más en árboles grandes.

## Correos

La configuración recibida tiene publicKey, serviceId y templateId. Esto valida su estructura, no demuestra que el servicio o la plantilla estén activos.

El envío ahora:

- Incluye nombre completo en `to_name`, además de `name` y `apellido` para compatibilidad.
- Valida destinatario y copia; excluye prácticas realizadas o ya avisadas.
- Vuelve a leer cada práctica antes de enviar y bloquea otra tanda simultánea en la misma página.
- Separa las solicitudes al menos 1,1 segundos. [EmailJS documenta una solicitud por segundo](https://www.emailjs.com/docs/sdk/send/).
- Registra el código y el mensaje de error disponibles.
- Recupera el botón de envío aunque falle la lectura o escritura.
- Detiene la tanda si no puede guardar el estado del envío, avisando que se debe revisar EmailJS antes de reintentar. No silencia ese fallo.
- No omite silenciosamente un PDF que no pudo leer.
- Habilita un nuevo aviso si se modifican alumno, fechas, lugar, horarios o datos de contacto de una práctica. La revisión automática sigue ocurriendo al iniciar sesión.

En EmailJS revisar: destinatario `{{to_email}}`, copia `{{cc_email}}` y cuerpo con `{{to_name}}`, `{{lugar}}`, `{{fecha}}`, `{{horario}}`, `{{tutor}}`, `{{contacto}}` y `{{mensaje_adicional}}`. Para el saludo usar por ejemplo `Hola {{to_name}}`; no concatenar `name` y `to_name`, porque repetiría el nombre.

Si se usa PDF, configurar un adjunto Variable Attachment con parámetro `adjunto_acuerdo` y nombre `{{adjunto_nombre}}`. La disponibilidad y el tamaño permitido deben revisarse en la cuenta. [Documentación oficial de adjuntos](https://www.emailjs.com/docs/user-guide/file-attachments/).

“Enviado” significa aceptado por EmailJS, no confirma entrega en la bandeja del alumno. Los avisos no son un programador independiente: con el sitio cerrado no se envían. No se implementó ni activó un disparador externo.

## Verificación realizada y límites

Se ejecutó el código con DOM, Firebase y EmailJS simulados. Se generaron y reabrieron ocho archivos XLSX desde sus manejadores reales de exportación. Se comprobó: acumulado de 10,5 horas realizadas y 22,5 totales; ficha con cinco hojas; resumen con cuatro hojas; tildes; exportación de 120 asistencias sin truncado; exclusión de prácticas realizadas/avisadas; separación temporal de correos; error 429 registrado; botón recuperado ante fallo de escritura y rechazo de configuración vacía.

Drive pasó pruebas simuladas de conexión ausente, paginación, subcarpetas, documentos nativos, caché y token vencido. Se verificó sintaxis JavaScript, ausencia de IDs duplicados y correspondencia de referencias DOM.

No se completó una prueba visual/interactiva en navegador: el navegador de pruebas no pudo instalarse por restricciones de descarga. No se accedió a Firebase o Drive reales ni se enviaron correos. Tampoco se publicaron cambios. No se verificaron permisos de Firestore, dominios autorizados, plantilla real, cuotas ni recepción de mensajes. Para cerrar esa validación hace falta el sitio desplegado y una prueba controlada con un destinatario autorizado.

## Mejoras recomendadas, por prioridad

1. **Avisos con el sitio cerrado:** implementar un disparador externo, con registro persistente por práctica/versión de aviso y control de concurrencia. La protección actual evita duplicados en una página, pero dos navegadores aún podrían enviar simultáneamente. Una respuesta de red incierta también requiere conciliación con el historial del proveedor antes de reintentar.
2. **Horas efectivamente cumplidas:** definir días concretos de asistencia, feriados y excepciones. Hoy las horas pendientes se estiman prorrateando días del rango por días semanales. No equivalen a un calendario exacto. Las realizadas son el total cargado en la práctica; no se derivan de entrada/salida ni descuentan faltas.
3. **Vinculación precisa:** agregar `practicaId` a asistencias y faltas. Actualmente una falta del alumno dentro del rango puede figurar en más de un lugar si hay prácticas superpuestas. El Excel advierte esta limitación.
4. **Informes por período:** distinguir “algún informe presentado” de “todos los períodos con informe”. El resumen actual conserva el primer criterio y lo etiqueta en la exportación.
5. **Permisos y datos personales:** auditar las reglas reales de Firestore por rol. Ocultar botones de administrador no reemplaza las reglas. Revisar también las tablas existentes que interpolan textos y enlaces mediante innerHTML; esta revisión no es una auditoría de seguridad completa.
6. **Respaldo y borrado:** programar respaldos y reemplazar eliminaciones definitivas por archivo/papelera. Las operaciones masivas originales no son atómicas y pueden quedar parciales ante un error.
7. **Rendimiento y consistencia:** incorporar paginación y consultas por alumno/fecha en las vistas que todavía descargan colecciones completas; evitar lecturas por cada tecla y controlar respuestas fuera de orden. Fijar y revisar las dependencias de importación/exportación antes de actualizar versiones.

Prueba final sugerida al instalar: comparar un alumno conocido contra su ficha, exportar un lugar filtrado, abrir los libros en Excel/LibreOffice y efectuar un único correo a una cuenta de prueba autorizada comprobando copia y PDF.

## Actualización de la vista del alumno

La ficha muestra Sector / carrera para cada práctica junto a Tipo de práctica (interna, externa o interescolar). El sector se toma de la práctica; cuando no está cargado se muestra “Sin especificar”. Puede completarse con el botón Editar de esa práctica. El listado general de alumnos identifica su columna como Sector / carrera. Las hojas Prácticas de la ficha y Períodos del resumen incluyen también ese dato.
