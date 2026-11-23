# Seguridad, numeración offline y pagos

PR #1 de `fix/seguridad-numeracion-pagos` hacia `main`. Base de trabajo comprobada en GitHub: `b6d80554a83c231ad3b2a0ff5a02d64d7baab837`.

## Auditoría y cambios

- Las reglas anteriores permitían a todo usuario activo escribir contadores y acceder directamente a las fotos. Ahora las consultas de empleados se limitan a los tipos autorizados, con ramas separadas para visibilidad pública y lectores explícitos. `publico` y `lectores` expresan el acceso efectivo y las reglas comprueban que la lista de denegados sea coherente cuando cambia el acceso. Se preservan los permisos de bloqueo del creador y de borrado. Las fotos vinculadas heredan el acceso del pedido. La app mantiene las pantallas de entrada, alta y cambio de PIN. Los PIN nuevos tienen ocho dígitos y los actuales siguen funcionando.
- Antes se reservaba el código por separado y el modo offline calculaba otro a partir de pedidos locales. El formulario ahora guarda primero el pedido, la nota y las fotos comprimidas en IndexedDB. Al recuperar comunicación real con Firestore, una transacción crea el pedido, incrementa el contador y registra un recibo de envío idempotente, junto con las fotos. El recibo sobrevive al borrado del pedido. El restablecimiento del PIN conserva la identidad de la cola y el espacio de recibos, aunque cambie el UID que inicia sesión. El primer administrador que reciba del servidor el historial completo eleva el piso de cada tipo hasta el mayor valor entre el contador existente y los códigos históricos. Los códigos existentes se conservan.
- Precios y abonos se validan en centavos para COP, USD y Bs, con un máximo de 10.000.000.000 unidades monetarias por pedido nuevo o editado. La cantidad debe ser un entero positivo seguro. El formulario, el detalle, el resumen y el mensaje de WhatsApp calculan el saldo con los mismos datos. Las reglas de Firestore verifican cada precio unitario y cantidad, la suma total y el abono para pedidos de hasta 8 partidas. Los sobrepagos nuevos se rechazan y los históricos se muestran con saldo negativo. La restauración conserva el formato histórico y valida la identidad, las colisiones y los pagos del nuevo formato.

## Validación del pago en Firestore

El formato 2 guarda `precioMenor` en cada partida y guarda `totalMenor` y `abonoMenor` en el pedido. Firestore exige una cantidad y un precio unitario enteros y positivos, verifica cada multiplicación con un límite previo para evitar desbordamientos, exige que la suma de las partidas sea el total y que el abono esté entre cero y ese total. El formulario y las vistas usan los mismos precios unitarios. El importe unitario de una cotización lo elige el equipo autorizado.

Firestore Rules carece de bucles y tiene un presupuesto de 1.000 expresiones por petición. Las reglas enumeran hasta 8 partidas y se verificaron con una escritura atómica que también adjunta fotos y miniaturas. Un pedido nuevo que exceda el límite se rechaza. Cuando varias prendas sean idénticas, el equipo puede consolidarlas aumentando la cantidad. Para pedidos que requieran más partidas distintas, una alternativa sin contratar servicios es ejecutar un proceso de confianza con Firebase Admin SDK en un equipo ya disponible. Tendría que autenticar al operador, validar las partidas y confirmar el pedido y el contador en una transacción, con credenciales fuera de la PWA. Esa ampliación no forma parte del PR.

Los pedidos históricos conservan su código, cantidades, precios y fotos. Sus datos se muestran en el formato anterior y las operaciones sin cambios de pagos siguen disponibles. Editar sus partidas o pagos mediante el formulario exige que puedan pasar la validación vigente. La restauración administrativa conserva el formato histórico de archivos compatibles.

## Recuperación tras restablecer el PIN

La app usa como identidad estable el UID original de la cuenta. El restablecimiento cambia la cuenta de Authentication y transfiere esa identidad en la misma transacción que actualiza el login y elimina el perfil anterior. Las reglas impiden editar ese campo, transferir la identidad de otra cuenta o consultar los recibos con el UID revocado. Con el PIN nuevo y el mismo navegador, se vuelve a abrir la cola de IndexedDB y se reutilizan los recibos previos. No se copian pedidos entre cuentas ni se crean recibos nuevos para un pedido ya confirmado.

Los envíos pendientes guardados en el formato 1 se convierten al sincronizar si el cálculo coincide con el total y el abono originales. Si requieren revisión, quedan visibles en la cola con sus archivos. El cambio conserva los pendientes sin sustituir el almacenamiento del navegador. Una identidad eliminada antes de esta versión sin registro de su UID original no se puede reasociar automáticamente.

## Pruebas reproducibles

```sh
npm ci --omit=optional --no-audit --no-fund
npm test
npm run test:emuladores
npm run test:navegador
```

Las dos últimas órdenes usan Authentication y Firestore con el proyecto local ficticio `demo-pedidos-codex`. GitHub Actions ejecuta las tres suites en cada actualización de un PR hacia `main`. La prueba de navegador requiere Chromium, localizable con `CHROMIUM_PATH`, y descarga la misma versión del SDK web que usa la app mediante `curl`. Sirve una configuración sintética y conecta ambos SDK a los emuladores. La compilación y las pruebas de reglas usaron el emulador oficial de Firestore 1.23.0 con Java 25 en este entorno. El destino de WhatsApp se comprobó leyendo la URL y el texto generados.

| Comando o comprobación | Resultado |
| --- | --- |
| `npm test` | 7 pruebas de cantidades, centavos, monedas, precios históricos y conversión de pendientes aprobadas. |
| `npm run test:emuladores` | 11 pruebas de acceso, numeración, fotos, arranque, respaldo, validación directa de múltiples partidas y transferencia de recibos aprobadas. |
| `npm run test:navegador` | 1 recorrido aprobado en Chromium de escritorio y con perfil móvil Pixel 7. Verifica login, tres altas offline, dos en el mismo navegador, recarga, varias pestañas, referencias, sincronización, edición, avisos, filtros, WhatsApp, descarga y restauración de un respaldo sintético, recuperación de un pedido de dos partidas con foto después de restablecer el PIN y acceso autorizado a un pedido histórico con foto vinculada. |
| `node --check` y `git diff --check` | Sintaxis de los módulos, del script de la PWA y del service worker comprobada. Diferencias sin errores de espacios. |

La revisión móvil usó emulación de navegador. Google Drive y la publicación del índice en un proyecto no emulado quedan fuera de las pruebas ejecutadas.

## Despliegue futuro

1. Hacer un respaldo autorizado y coordinar una ventana con el equipo. Sincronizar los pedidos de clientes antiguos antes de actualizar la PWA. Preparar `firestore.indexes.json` en un proyecto de pruebas y comprobar que el índice compuesto para tipo y lectores llegue a estado listo.
2. Actualizar las reglas y la PWA de forma coordinada. Abrir la versión nueva como administrador conectado, esperar a que lea el historial completo y verificar que ambas series quedaron alineadas. Confirmar las consultas, una muestra de fotos y los permisos de una cuenta de equipo.
3. Ejecutar **Ajustes → Respaldo de datos → Vincular fotos históricas**. Revisar aparte las referencias compartidas o sin pedido. Las fotos históricas sin vínculo quedan accesibles al administrador.
4. Antes de reactivar las altas, comprobar la versión de la PWA y el estado de las colas locales en los dispositivos que ya usaban la app.

## Reversión

Pausar altas y conservar los perfiles del navegador, las colas de IndexedDB y el respaldo. Mantener los contadores, recibos y códigos ya confirmados. Cualquier reversión de la PWA y de sus reglas debe probarse primero como conjunto en un entorno aislado. Las reglas v3.66 permitirían escrituras de contador desde clientes activos y la generación del código por separado reintroduciría la colisión. Si el alta segura debe quedar detenida, mantener las reglas nuevas o un acceso temporal de lectura mientras se corrige y se retoman los envíos pendientes.

## Riesgos pendientes

- El login legado requiere una búsqueda puntual pública por nombre. Las reglas impiden listar `logins`, pero no ocultan la existencia de nombres conocidos. El autorregistro inicial sigue dependiendo de que el administrador legítimo configure el proyecto primero. Un PIN sigue siendo una credencial de baja entropía y Firestore no puede imponer la política de Firebase Authentication. Un arranque administrado y controles de autenticación en un servicio confiable reducirían estos riesgos.
- La cola reside en el navegador y pertenece a una identidad de cuenta estable. Borrar el almacenamiento o perder el dispositivo puede eliminar pedidos pendientes. Una revocación no puede retirar copias que un dispositivo ya guardó mientras estaba autorizado.
- Los códigos previamente duplicados se conservan. La restauración se hace en lotes administrativos y puede quedar parcial si se interrumpe. El piso elevado y los pedidos ya importados se conservan. Evitar restauraciones simultáneas. Los respaldos de la app no contienen los recibos de sincronización ni las colas locales.
- Las fotos históricas con vínculos ambiguos y las referencias de borradores creados por la versión anterior pueden requerir vinculación después de guardar el pedido. Al borrar un pedido, las reglas retiran el acceso del equipo a sus fotos vinculadas. Para borrados de empleados, las fotos permanecen para revisión y limpieza administrativa.
