# Tarea para Codex: seguridad, numeración offline y pagos

## Contexto y límites

Repositorio: kdnaskrlos/Pedidos-Personalizados
Rama de trabajo: fix/seguridad-numeracion-pagos
Línea base: v3.66. La aplicación es una PWA sin framework: el CSS, HTML y JavaScript están principalmente en index.html (aprox. 3580 líneas). Conecta con Firebase Authentication y Firestore mediante config.js, firestore.rules y sw.js. Los usuarios acceden por nombre de usuario y PIN; hay roles de administrador y empleado con permisos. Los pedidos son Personalizado (P-0001...) y Sublimación completa (S-0001...), admiten fotos y varios precios por prenda, moneda COP/USD/Bs, abono y saldo.

IMPORTANTE:
- Trabaja solo en esta rama. Nunca escribas en main, hagas merge, publiques GitHub Pages ni despliegues reglas en Firebase real.
- Nunca consultes, alteres, borres ni migres datos reales del proyecto Firebase.
- No cambies config.js, ni credenciales, ni lógica de negocio no relacionada, ni el diseño visual salvo lo imprescindible para señalar estados.
- No reescribas la aplicación en otro framework ni actualices las versiones de Firebase sin necesidad.
- Primero realiza una auditoría de las rutas afectadas y escribe una explicación breve de la solución antes de modificar.
- Divide cambios en commits verificables. Una solución que preserve el funcionamiento es preferible a una refactorización extensa.
- Si una mejora requiere infraestructura nueva o sacrifica el registro offline, no simules que ya está resuelta: informa el compromiso, entrega lo seguro y propón alternativa.

## 1. Firestore, permisos y usuarios

Puntos de entrada: firestore.rules, index.html: login, crearCuenta, nuevoUsuario, resetPin, startData, saveForm, cambiar, borrarPedido, migrarCodigos, arreglarLectores y fotos.

Objetivos:
- Comprobar para cada colección el mínimo privilegio de lectura, creación, actualización y eliminación; preservar flujos legítimos de admin y empleados activos.
- Ningún usuario sin sesión o inactivo debe leer o cambiar pedidos, fotos, ajustes o usuarios fuera de los casos de arranque/login expresamente justificados.
- Un empleado no debe elevar su rol/permisos ni modificar campos inmutables de pedidos, identidad del creador, autoría, tipo o código definitivo.
- Revisar con especial atención el acceso de usuarios activos a /contadores: actualmente pueden escribir cualquier valor. Una protección debe impedir retrocesos/saltos arbitrarios del contador sin romper el alta concurrente de pedidos y las migraciones autorizadas de administrador.
- Revisar visibilidad por tipo, lectores, publico, denegados, bloqueo, borrado y lectura por query; las reglas de Firestore se validan como consultas, no como filtros posteriores.
- Examinar /logins, cuyo acceso público permite resolver nombre de usuario a correo interno; no bloquear el login actual sin diseñar y probar sustituto compatible.
- Examinar el alta del primer administrador (bootstrap). Documentar riesgos que no puedan resolverse solo con reglas del lado cliente.
- Evaluar fortaleza de PIN para cuentas nuevas y migración de cuentas existentes. No bloquear de improviso los PIN actuales.
- Escribir pruebas de denegación y de acceso permitido con Firebase Emulator Suite y usuarios sintéticos; nunca el proyecto real.

## 2. Numeración de pedidos y conectividad

Puntos de entrada: index.html, funciones siguienteCodigo, codigoLocal, migrarCodigos, saveForm, boot, startData; colección /contadores, /pedidos y reglas.

Defecto actual: codigoLocal calcula max+1 con los pedidos visibles en un dispositivo; dos equipos offline podrían elegir el mismo P-xxxx o S-xxxx. Además, siguienteCodigo usa Promise.race con una transacción que podría seguir ejecutándose tras agotarse el tiempo, y separa la reserva del número de la creación del pedido.

Criterios de solución:
- Nunca presentar como definitivo un código consecutivo calculado solo con la copia local.
- Al estar online, reservar el consecutivo e insertar el pedido en una sola transacción de Firestore, respetando reglas. Un fallo no debe consumir un consecutivo sin crear su pedido ni dejar un pedido con un código no reservado.
- El contador debe estar alineado con el historial existente, sin renumerar ni modificar pedidos antiguos. No confiar en que cada empleado vea todos los pedidos.
- Al estar offline, conservar el pedido como pendiente LOCAL de envío, identificable mediante UUID/ID único y nunca confundido con pedido confirmado. La opción preferida es una cola persistente, visible, recuperable y reintentable, que no pierda más de un pedido y no duplique documentos al reintentar o tras refrescar la app.
- Asignar el código P-/S- definitivo únicamente al sincronizar con el servidor mediante operación atómica e idempotente.
- Manejar cierre de pestaña, múltiples pestañas, errores de permisos, reintentos y reconexión. No asumir que navigator.onLine garantiza contacto efectivo con Firestore.
- No perder fotos ni notas adjuntas al pedido offline; evaluar tamaño del almacenamiento local y errores de cuota.
- Si la cola local segura es desproporcionada, detener esa parte e informar claramente antes de quitar capacidad de registro offline.
- Pruebas: dos clientes emulados concurrentes nunca generan el mismo código; dos pedidos offline no comparten código definitivo; reconexión/reintento no duplica; fallo de la transacción no deja hueco ni pedido fantasma; pedidos existentes conservan su código.

## 3. Cálculos de precios, cantidades, abonos y saldos

Puntos de entrada: num, fmtMonto, precioDe, prKey, prendasDe, totales, renderPrecios, renderTotals, erroresPaso, saveForm, openDetail, waLink, resumenTexto y restaurarArchivo.

Objetivos:
- Cantidad de unidades: entero positivo seguro. Precio unitario: importe finito y no negativo, y exigir >0 cuando corresponda para guardar. Abono: finito y >=0. Rechazar valores no numéricos, negativos, NaN, Infinity, decimales de cantidad y conversiones ambiguas. No aceptar silenciosamente parseFloat('123abc').
- Definir y probar precisión de montos acorde con monedas COP, USD y Bs, evitando errores de punto flotante; no convertir monedas de forma implícita.
- Validar que el abono no exceda el total, o modelar expresamente créditos/devoluciones si se decide permitirlo. Nunca esconder un sobrepago mediante Math.max(0, total - abono) sin aviso.
- Mantener precios distintos según prenda, horma, talla Plus y Niño/Niña; calcular siempre total = suma(cantidad x precio unitario) y saldo = total - abonos, sin reescribir pedidos históricos.
- Un mismo cálculo coherente debe respaldar formularios, detalle, resumen y mensaje de WhatsApp.
- Aplicar validación ANTES de escribir y confirmar los casos de acceso directo por API con reglas factibles sin romper datos legados. No hacer migraciones monetarias automáticas.
- Pruebas para múltiples productos, 2XL y mayores, Niño/Niña, cambios de cantidad, precios diferentes, abonos 0/parciales/totales/excesivos/negativos, cantidades inválidas, formatos 50.000 y 50.000,50, y monedas.

## Pruebas y entrega

- Añadir pruebas automatizadas mantenibles sin convertir la app a un framework. Para seguridad usar emuladores Authentication/Firestore con un projectId ficticio y datos sintéticos. No usar configuración de producción.
- Ejecutar las pruebas que sean posibles en el entorno y registrar comandos/resultados. Si no está disponible Java/Emulator o navegador de pruebas, indicar explícitamente qué no se ejecutó.
- Probar en móvil y escritorio cuando el entorno lo permita: formulario, crear/editar, imágenes, notificaciones, filtros, WhatsApp, login y permisos.
- Comprobar sintaxis y ausencia de regresiones. Revisar el service worker y el mecanismo de actualización: incrementar versión/caché solo si es necesario para que el despliegue futuro no sirva JavaScript antiguo, pero no activar despliegue.
- Entregar un PR desde fix/seguridad-numeracion-pagos hacia main SIN fusionar, con cambios descritos por área, evidencia de pruebas, riesgos residuales, instrucciones de despliegue futuro para firestore.rules, plan de reversión y bloqueos.
- NO declarar que la seguridad o el offline son infalibles. Señalar claramente los límites de una arquitectura sin servidor confiable.
- Nunca exponer datos personales ni claves de cuentas en salidas de diagnóstico.
