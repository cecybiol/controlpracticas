# Correcciones de asistencia, horas y acuerdos — versión gratuita

Esta versión reemplaza la configuración anterior con Functions/Blaze y EmailJS. Seguir [CONFIGURACION_GRATUITA.md](CONFIGURACION_GRATUITA.md).

## Cambios de asistencia y horas

- Horas por jornadas: fechas exactas del cronograma y asistencia vinculada a una práctica; separación de internas, externas e interescolares.
- La jornada de hoy no suma antes del horario de salida; fecha institucional de San Luis.
- La asistencia automática es una presencia presunta por cronograma, editable por el docente. No verifica presencia física.
- Ausencias, jornadas retiradas y reprogramadas acreditan cero; tardanzas requieren horarios reales y se limitan al horario previsto. Reprogramar crea una jornada futura vinculada.
- El estado del período avanza por calendario; realizada significa período terminado, no objetivo de horas cumplido. Las horas se muestran aparte.
- Canceladas y archivadas no suman horas cumplidas ni pendientes.
- Identidad estable por práctica y fecha, migración de duplicados y prevalencia de correcciones. Registros contradictorios quedan pendientes de revisión.
- Editar fechas invalida asistencia fuera del cronograma. Retirar una asistencia no la regenera.
- Importación idempotente: repetir una planilla no duplica prácticas. Presente no convierte todo un período en realizado. Se validan horas, estados y días exactos.
- Cronogramas antiguos de dos o tres días exigen precisar los días. Totales históricos manuales se conservan sin inventar desglose ni prorrateo en rangos parciales.
- Objetivos por tipo: el excedente interno no oculta horas externas faltantes.
- Bajas archivadas; fusiones y agrupaciones atómicas conservando informes y usuarios.
- Reglas por rol: alumnos sólo consultan sus datos, no alteran horas ni solicitan correos.

## Automatización gratuita

Google Apps Script sustituye las funciones de Firebase. Un disparador privado de una cuenta docente ejecuta aproximadamente cada hora:

1. Sincronización reciente de jornadas terminadas, con máximo 30 operaciones por ejecución.
2. Procesamiento de solicitudes de docentes desde Avisos: comprobar, enviar seleccionados y correo particular.
3. Recordatorios automáticos a partir de la hora configurada y dentro del rango de anticipación.
4. Registro de resultados, cuota disponible y último control en Firestore.

MailApp envía desde la cuenta que instala el disparador. Cada recordatorio obtiene el PDF específico del alumno/lugar/sector. Faltantes, duplicados, contenido no PDF o más de 8 MiB bloquean ese envío. Comprobar no envía correos.

Se revisa la cuota real antes de enviar, contando CC. Máximo 20 intentos por ejecución. Si falta cuota, las solicitudes quedan pendientes. No hay cargos automáticos: conservar Firebase Spark sin facturación. Las cuotas gratuitas pueden detener operaciones y deben monitorearse; el volumen admitido depende de la cuenta y del historial.

Los intentos inciertos bloquean reenvíos; revisar la cuenta remitente antes de liberar manualmente un intento desde administración. Enviado significa aceptado por MailApp, no entrega garantizada.

## Verificación y límites

91 pruebas aprobadas: 38 de dominio, 28 de Apps Script simulado, 8 de interfaz, 13 de permisos y 4 de REST. Código revisado y probado localmente: calendario/horas, Apps Script con servicios simulados, interfaz con DOM simulado, permisos en emulador real y operaciones REST compatibles con ese emulador. Las transacciones REST se verifican con respuestas simuladas; la versión del emulador disponible no serializa su token de transacción en HTTP. No se afirma una prueba de OAuth IAM real ni una prueba visual de navegador.

No se enviaron correos reales ni se instaló el disparador en la cuenta del docente. La versión gratuita se prepara en una rama de GitHub para revisión. La página pública y la cuenta Google requieren la instalación indicada en la guía; no se afirma un despliegue en producción.

El paquete incluye los archivos actualizados, guía de instalación y parche completo respecto del código original auditado.

## Actualización del 30/09/2026: consultas eficientes

La versión actual añade páginas de 20, filtros en servidor, preparación del historial e índices. La instalación y la auditoría de consumo están en GUIA_CONSULTAS_EFICIENTES.md. La verificación actual suma 118 pruebas, incluyendo interfaz y emulador.
