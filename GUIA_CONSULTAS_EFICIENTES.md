# Consultas eficientes y filtros — Control de Prácticas

Versión preparada el 30/09/2026. Conserva servicios gratuitos: GitHub Pages, Firebase Spark, Drive y Apps Script. Código verificado localmente; no publicado ni activado en la cuenta Google.

## ¿Disminuye el consumo traer solamente 20 registros?

Sí, si el límite y los filtros forman parte de la consulta a Firestore. Ocultar filas después de descargar la colección no ahorra lecturas.

Ejemplo: una colección de 1.000 documentos, sin filtros, se leía completa para mostrar las primeras 20 filas. Ahora la primera consulta devuelve hasta 20: 98% menos documentos de esa colección en esa primera carga. No es una medición del ahorro total del sitio: además se consultan fichas relacionadas, permisos y, en algunos casos, entradas de índices.

No confundir número de consultas con documentos leídos. La primera página puede seguir usando una consulta, pero devuelve menos documentos. Recorrer las 50 páginas puede leer los mismos 1.000 documentos y usar más consultas. Buscar directamente un alumno, período o lugar es lo que evita recorrer ese historial.

## Cambios implementados

| Sección u operación | Consulta anterior | Consulta actual |
|---|---|---|
| Alumnos | Todos los alumnos y filtro local | Hasta 20; prefijo de apellido/nombre/legajo/teléfono/sector y curso exacto en servidor |
| Prácticas | Todas las prácticas, alumnos y asistencias para pintar una tabla | Hasta 20 prácticas filtradas; sólo las fichas de alumnos relacionados; horas históricas bajo demanda |
| Asistencia | Sincronización histórica al abrir, más lectura completa | Hasta 20 registros filtrados por alumno, fecha/rango, lugar, tipo y estado; sincronización con botón separado |
| Faltas | Toda la colección | Hasta 20, filtrados por alumno |
| Informes | Todas las prácticas/asistencias/alumnos/informes | Hasta 20 informes filtrados; sólo sus fichas y prácticas relacionadas; cumplimiento completo con botón |
| Usuarios | Todos los perfiles y todo el alumnado | Hasta 20 perfiles; nombre por prefijo y rol en servidor; fichas vinculadas bajo demanda |
| Avisos próximos | Todas las prácticas y todo el alumnado | Hasta 20 prácticas dentro de la ventana de aviso; alumnos relacionados; selección por página |
| Historial de correos | Hasta 30 | Últimos 20; solicitudes mantienen límite 10 |
| Inicio | Historial completo para calcular indicadores al ingresar | Hasta 5 próximas y 20 en curso; indicadores completos con botón |
| Estadísticas, resumen y Optimizar | Revisión completa al abrir sección | Se ejecutan con sus botones de cálculo/búsqueda |
| Ficha o PDF individual | Algunas rutas consultaban asistencia de todos | Historial propio del alumno; los cálculos conservan todas sus prácticas necesarias |
| Fichas relacionadas en una página | Un getDoc por alumno relacionado | Se reutilizan fichas recientes; las faltantes se consultan juntas, en tandas de hasta 20 identificadores |
| Editar una práctica/asistencia | Algunas rutas buscaban en todas las prácticas | Lectura del documento correspondiente |
| Guardar una práctica | Sincronización de todos los alumnos | Revisión de los alumnos afectados; máximo 30 operaciones |
| Exportar asistencias/faltas | Algunas exportaciones ignoraban filtros de fecha/lugar | Resultado completo de los filtros aplicados en servidor, cuando se solicita exportar |
| Apps Script preparado | Todas las prácticas en cada ejecución horaria | Prácticas recientes para asistencia y dentro de la ventana de avisos; fichas necesarias para avisos |

Las páginas usan `limit(20)` y `startAfter` con el documento completo como cursor. No usan offsets ni solicitan un conteo total para cada página. “Siguiente” puede efectuar una última consulta vacía cuando la última página tiene exactamente 20 documentos; “Anterior” deja de anunciar otra página después de esa comprobación.

Volver a una página reciente reutiliza los datos durante 60 segundos. Se conservan hasta diez páginas completas por listado, con sus cursores. Las consultas simultáneas equivalentes se agrupan. Los documentos recibidos en un listado pequeño también sirven para abrir su ficha sin otra lectura inmediata. Las consultas históricas grandes conservan su caché sin llenarla con cientos de fichas individuales.

La caché propia se mantiene en memoria, sin persistir un archivo de datos de alumnos. Cambiar de cuenta reinicia la caché de consultas, búsquedas y cursores. Escribir invalida las consultas y páginas. Cambios desde otro equipo pueden tardar hasta un minuto en reflejarse; Actualizar vuelve a consultar el servidor.

Se mantienen la pausa de un minuto ante `resource-exhausted`, la conservación de correcciones manuales y la omisión de transacciones para jornadas canónicas ya correctas.

## Cómo usar los filtros

- Alumnos: elegí el campo y escribí el comienzo del valor. “meli” con Nombre encuentra Melissa; “barb” con Apellido encuentra Barbeito. Se ignoran tildes y mayúsculas después de preparar el historial. No es una búsqueda por cualquier fragmento interior.
- Prácticas e informes: elegí Apellido, Nombre o Legajo en el buscador de alumno, escribí al menos dos caracteres y seleccioná una sugerencia. La consulta del listado utiliza el identificador del alumno elegido.
- Asistencia, faltas y usuarios vinculados: el buscador trae hasta 20 sugerencias y permite seleccionar el alumno en el desplegable. Si hay muchos nombres iguales, usá Nombre o Legajo para acotar.
- Lugar, sector y tutor de prácticas: valor exacto, incluyendo la escritura registrada. Lugar dispone de sugerencias del catálogo cuando se usa el filtro. La búsqueda de alumno/título sí se normaliza; estos filtros exactos no se convierten en búsquedas aproximadas.
- Prácticas: Desde/Hasta mantienen la superposición del período completo (`fechaFin >= desde` y `fecha <= hasta`). Con Desde, el orden prioriza fecha de fin; sin ese filtro, fecha de inicio. El límite no se aplica antes de filtrar.
- Asistencia: podés usar fecha exacta, rango, alumno, lugar, tipo y estado. Si combinás fecha exacta y rango, deben coincidir. Limpiar elimina todos esos criterios.
- Hay hasta 20 documentos fuente por página. Registros archivados, suprimidos o duplicados se excluyen de la presentación; puede haber menos de 20 filas visibles. Siguiente avanza con el último documento fuente, incluso si una página no contiene filas visibles. No se escanea toda la colección para rellenar automáticamente una página.
- Un campo de ordenamiento/búsqueda ausente no participa de esa consulta. Preparar el historial es necesario para búsquedas normalizadas, informes por lugar, asistencias antiguas por estado y períodos antiguos sin fecha de fin. Una práctica sin fecha válida requiere corrección de datos; no se inventa una fecha.

## Horas, estados y exportaciones

En Prácticas se muestran la planificación y el estado del período sin leer todas las asistencias. “Consultar horas” calcula las horas de esa práctica y los acumulados del alumno con su historial completo. Si faltan jornadas, se indica revisión: no se supone presencia ni se acredita tiempo futuro.

El estado del período describe fechas; no implica que el alumno haya cumplido todas las horas. Las ausencias, tardanzas, cancelaciones, supresiones y totales manuales siguen las reglas de `domain.mjs`.

Exportar alumnos exporta la página actual. Exportar prácticas calcula las horas de los alumnos de la página y exporta esas filas. Exportar asistencias/faltas exporta todo el resultado filtrado y puede consumir más lecturas que mirar una página. La ficha y los PDF conservan resultados completos del alumno seleccionado.

El cumplimiento de informes se calcula con su botón. Con alumno seleccionado, consulta sólo ese alumno; sin selección, calcula el colegio completo. El título/estado del listado de informes no limita el universo utilizado para determinar si faltan informes de prácticas realizadas.

Para sugerir sectores y tutores al editar una práctica se usan las últimas 20 prácticas y la práctica que se está editando. “Escribir otro” permite ingresar un valor que no aparezca entre esas sugerencias. El selector de asignación múltiple sigue usando el catálogo de alumnos cuando se abre el formulario: es una operación explícita para asignar alumnos, no la lectura inicial del listado.

Si se corrige el lugar de una práctica, sus informes vinculados se actualizan junto con ella para conservar el filtro por lugar. El lote admite hasta 450 informes vinculados; por encima de ese tamaño se informa que hace falta una actualización por tandas.

## Instalación de esta versión

1. Si la cuota diaria está agotada, esperar su renovación antes de preparar registros. Mantener Spark sin facturación. Cerrar pestañas repetidas y no ejecutar varias veces el procesador de Apps Script.
2. Guardar una copia de los archivos actuales. El ZIP incluye la versión completa y parches acumulados; no es necesario importar una base de datos nueva ni borrar registros.
3. Desde la carpeta del proyecto, con Firebase CLI autorizado en tu cuenta, desplegar reglas e índices:

   ```bash
   firebase deploy --only firestore:rules,firestore:indexes --project control-practicas-f7b5a
   ```

   El archivo `firestore.indexes.json` incluye 100 índices compuestos para las combinaciones de filtros y ocho excepciones para textos/mapas que no se consultan por campo. Si Firebase CLI propone borrar índices existentes ajenos a este archivo, conservarlos. En Firebase → Firestore → Índices, esperar que los nuevos estén habilitados antes de usar filtros combinados. No desplegar Functions ni activar Blaze.
4. Publicar los archivos del sitio: `index.html`, `js/app.js`, `js/attendance-store.mjs`, `js/firestore-access.mjs`, `js/record-pages.mjs` y los demás recursos del ZIP si todavía no se habían aplicado las correcciones anteriores. Mantener las rutas. La nueva página depende del nuevo módulo; no subir sólo app.js.
5. Recargar con Ctrl+Shift+R. Ingresar con rol admin. En Configuración → Preparar búsquedas del historial, elegir Alumnos y pulsar Preparar próximos 20 hasta que diga “Terminó esta colección”. Repetir para Prácticas, Informes, Asistencias antiguas y Usuarios. El avance por cursor se mantiene mientras esa pestaña siga abierta; al recargar se vuelve al inicio, pero los registros ya preparados no se vuelven a escribir si no cambiaron.
6. Cada paso lee hasta 20 documentos de la colección y escribe sólo los que necesitan preparación. En informes y asistencias vinculadas puede leer prácticas relacionadas; al terminar escribe un marcador. Es un consumo inicial, no una tarea que se repite en cada búsqueda. Si aparece cuota agotada, detenerse hasta su renovación.
7. En Apps Script, reemplazar Code.gs y Firestore.gs por los del ZIP. Domain.gs y el manifiesto mantienen la configuración gratuita. Conservar una sola instalación del disparador horario. Si se había detenido, ejecutar instalarAvisos una vez. No hace falta publicar una aplicación web.
8. El marcador `configuracion/lecturas.practicasPreparadas` habilita las consultas de períodos recientes del script. Hasta que termine la preparación de prácticas, utiliza la lectura compatible con registros antiguos. Así no se omiten prácticas históricas por un campo de fin ausente.
9. Comprobar una búsqueda por nombre, una segunda página, un rango de asistencia y Consultar horas de un alumno conocido. Revisar Uso de Firestore durante varios días para comparar lecturas y escrituras con el uso real.

Preparar una asistencia antigua sólo añade el estado que ya se interpretaba a partir de `presente`; conserva ausencias y horarios. Completa el tipo únicamente cuando existe una práctica vinculada. Los registros ambiguos sin práctica/tipo se conservan para revisión; no se adivina a qué práctica pertenecen.

## Optimizaciones adicionales detectadas

| Prioridad | Medida | Estado / motivo |
|---|---|---|
| Alta | Límite real, cursores y filtros antes de descargar | Implementado en los listados principales |
| Alta | Evitar sincronizar todo el historial por navegación | Implementado; botón y revisión reciente horaria |
| Alta | Evitar cargas globales al iniciar o editar una ficha | Implementado en las rutas indicadas arriba |
| Alta | Evitar lectura horaria de todas las prácticas | Implementado después de preparar el historial y actualizar el script |
| Media | Resúmenes por alumno para indicadores generales | Pendiente: permitirían leer un resumen por alumno en lugar de todas sus jornadas; requieren actualización coherente ante ausencias, cambios de horario, cancelaciones, duplicados y fechas terminadas |
| Media | Resúmenes por lugar/tipo/mes | Pendiente: útiles para estadísticas generales y tendencias; no sustituir registros originales ni ocultar correcciones históricas |
| Media | Consultas de estadísticas y resumen por alcance | Esas operaciones todavía leen historial completo cuando se ejecutan. La ficha individual y cumplimiento por alumno sí se limitan. Para rangos globales hay que preservar el contexto que desambigua asistencias antiguas |
| Media | Catálogo dedicado de sectores/tutores | Pendiente; hoy se usan sugerencias de últimas 20 prácticas para evitar leer el historial sólo para rellenar el formulario |
| Media | Importar informes de Drive sin leer todos los informes | Pendiente en el modal de registro masivo: usar identidad estable por archivo de Drive o consultas de enlaces seleccionados; revisar duplicados heredados antes de sustituir el control actual |
| Media | Filtrar archivados/suprimidos también en servidor | Pendiente: un marcador visible/activo exige que todas las rutas de escritura, incluido Apps Script, lo mantengan. Por ahora se preservan registros antiguos y cada página fuente queda limitada a 20 |
| Baja | Conteos con count() sin descargar documentos | Posible para cantidades; no calcula por sí solo horas corregidas de asistencia. Se evita agregar conteos automáticos por página |
| Baja | Cambiar frecuencia horaria a cada dos horas | Posible si se acepta más demora en asistencia/avisos. No se aplicó: se conserva la frecuencia horaria acordada |
| Baja | Caché persistente | No activada: el sitio maneja datos de alumnos y puede usarse en equipos compartidos; la caché en memoria evita una copia persistente adicional |
| Continua | Índices de textos largos no consultados | Ocho excepciones declaradas; reduce índices, almacenamiento y trabajo de escritura, no las lecturas de documentos por sí solo |
| Continua | Una cuenta remitente y un solo disparador | Revisar en Apps Script. Instalaciones en varios proyectos/cuentas pueden duplicar revisiones aunque el control de intentos impida repetir correos |

No se implementó una copia de horas acumuladas que pueda quedar desactualizada. Los informes globales y la detección de duplicados requieren un universo completo y permanecen bajo demanda. Un cambio a resúmenes materializados exige pruebas adicionales de reconciliación; el ahorro no debe producir cifras incorrectas.

## Verificación y límites

118 pruebas aprobadas: 41 de reglas de horas/asistencia, 7 de caché/cuota, 6 de paginación, 30 de Apps Script, 14 de interfaz, 15 de permisos reales en emulador y 5 del adaptador REST real en emulador.

Se verificaron páginas sucesivas con fechas iguales, ausencia de saltos/duplicados en datos estables, volver atrás sin releer páginas recientes, respuesta tardía de un filtro anterior, normalización de nombres, preparación de ausencias antiguas, corrección del lugar de informes y continuidad de las horas completas.

No se accedió a la base real ni se midió un porcentaje de ahorro del proyecto. El emulador verifica consultas y reglas, pero no demuestra que los índices del proyecto real ya estén creados. No se ejecutaron disparadores ni se enviaron correos reales. Las cuotas siguen siendo compartidas por todos los usuarios y el script.

Fuentes oficiales: https://firebase.google.com/docs/firestore/query-data/query-cursors, https://firebase.google.com/docs/firestore/pricing y https://firebase.google.com/docs/firestore/quotas.
