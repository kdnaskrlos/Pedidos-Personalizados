# Seguridad, numeración offline y pagos

PR preparado para `fix/seguridad-numeracion-pagos` → `main`. Base de trabajo comprobada en GitHub: `b6d80554a83c231ad3b2a0ff5a02d64d7baab837`.

## Auditoría y cambios

- Las reglas anteriores permitían a todo usuario activo escribir contadores y acceder directamente a las fotos. Ahora las consultas de empleados se limitan a los tipos autorizados, con ramas separadas para visibilidad pública y lectores explícitos. `publico` y `lectores` expresan el acceso efectivo y las reglas comprueban que la lista de denegados sea coherente cuando cambia el acceso. Se preservan los permisos de bloqueo del creador y de borrado. Las fotos vinculadas heredan el acceso del pedido. La app mantiene las pantallas de entrada, alta y cambio de PIN. Los PIN nuevos tienen ocho dígitos y los actuales siguen funcionando.
- Antes se reservaba el código por separado y el modo offline calculaba otro a partir de pedidos locales. El formulario ahora guarda primero el pedido, la nota y las fotos comprimidas en IndexedDB. Al recuperar comunicación real con Firestore, una transacción crea el pedido, incrementa el contador y registra un recibo de envío idempotente, junto con las fotos. El recibo sobrevive al borrado del pedido. El primer administrador que reciba del servidor el historial completo eleva el piso de cada tipo hasta el mayor valor entre el contador existente y los códigos históricos. Los códigos existentes se conservan.
- Precios y abonos se validan en centavos para COP, USD y Bs, con un máximo de 10.000.000.000 unidades monetarias por pedido nuevo o editado. La cantidad debe ser un entero positivo seguro. El formulario, el detalle, el resumen y el mensaje de WhatsApp calculan el saldo con los mismos datos. Los nuevos sobrepagos se rechazan y los históricos se muestran con saldo negativo. La restauración conserva el formato histórico y valida la identidad, las colisiones y los pagos del nuevo formato.

## Pruebas reproducibles

```sh
npm ci --omit=optional --no-audit --no-fund
npm test
npm run test:emuladores
npm run test:navegador
```

Las dos últimas órdenes usan Authentication y Firestore con el proyecto local ficticio `demo-pedidos-codex`. La prueba de navegador requiere Chromium, localizable con `CHROMIUM_PATH`, y descarga la misma versión del SDK web que usa la app mediante `curl`. Sirve una configuración sintética y conecta ambos SDK a los emuladores. La compilación y las pruebas de reglas usaron el emulador oficial de Firestore 1.23.0 con Java 25 en este entorno. El destino de WhatsApp se comprobó leyendo la URL y el texto generados.

| Comando o comprobación | Resultado |
| --- | --- |
| `npm test` | 5 pruebas de cantidades, centavos, monedas y precios históricos aprobadas. |
| `npm run test:emuladores` | 9 pruebas de acceso, escritura, numeración, fotos, arranque y respaldo histórico aprobadas. |
| `npm run test:navegador` | 1 recorrido aprobado en Chromium de escritorio y con perfil móvil Pixel 7. Verifica login, tres altas offline, dos en el mismo navegador, recarga, varias pestañas, referencias, sincronización, edición, avisos, filtros, WhatsApp, descarga y restauración de un respaldo sintético. |
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
- Las reglas validan moneda, centavos, límites, el abono declarado y la aritmética de pedidos de una sola partida. Para listas de tamaño variable, el navegador valida todas las cantidades y precios. Verificar la suma de todas las partidas ante escrituras directas requiere un servicio confiable o un esquema con otra estructura.
- La cola reside en el navegador y pertenece al UID autenticado. Borrar el almacenamiento o perder el dispositivo puede eliminar pedidos pendientes. Un restablecimiento de PIN iniciado por el administrador cambia el UID y deja los pendientes del UID anterior sin acceso normal. Conviene confirmar los envíos antes de ese cambio. Una revocación tampoco puede retirar copias que un dispositivo ya guardó mientras estaba autorizado.
- Los códigos previamente duplicados se conservan. La restauración se hace en lotes administrativos y puede quedar parcial si se interrumpe. El piso elevado y los pedidos ya importados se conservan. Evitar restauraciones simultáneas. Los respaldos de la app no contienen los recibos de sincronización ni las colas locales.
- Las fotos históricas con vínculos ambiguos y las referencias de borradores creados por la versión anterior pueden requerir vinculación después de guardar el pedido. Al borrar un pedido, las reglas retiran el acceso del equipo a sus fotos vinculadas. Para borrados de empleados, las fotos permanecen para revisión y limpieza administrativa.
