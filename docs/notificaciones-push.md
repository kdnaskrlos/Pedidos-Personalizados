# Notificaciones push de Pedidos

Los avisos de ediciones, altas y cambios de estado los solicita una Cloud Function de segunda generación después de la escritura en Firestore. El navegador puede recibirlos con Pedidos cerrada. El tiempo de entrega depende de Firebase, la red y el sistema operativo. Las entregas próximas y vencidas se muestran como pendientes y no hay un trabajo programado.

## Revisar antes de publicar

1. Descarga `demo/preview-ajustes-notificaciones.html` y ábrelo con doble clic. Usa **Vista** para alternar escritorio y móvil, **Cuenta** para ver Ajustes de administrador o Mi cuenta del equipo y **Permiso simulado** para recorrer los estados. Todas las interacciones de ese HTML usan datos simulados.
2. Confirma que el proyecto existente `pedidos-personalizados-6610e` tiene plan **Blaze**, una cuenta de facturación con presupuesto y alertas y acceso a la base Firestore `(default)`. Confirma la ubicación de Firestore y la disponibilidad de Cloud Functions/Eventarc. Este PR fija `us-central1` tanto para la función invocable como para su cliente. Si el proyecto requiere otra región compatible, cambia ambos valores antes de desplegar.
3. En **Firebase Console → Configuración del proyecto → Cloud Messaging → Configuración web → Certificados web**, genera o recupera el par VAPID de este proyecto. Copia solo la clave **pública** en `claveVapid` de `push-config.mjs`. El archivo vacío bloquea la activación del dispositivo mientras permite revisar las preferencias. Si rotas la clave, pide a quien ya tenía avisos que los desactive y reactive en su dispositivo.
4. Verifica las APIs y la identidad con la que se desplegará. El operador necesita permisos de despliegue de Firebase Functions y Firestore Rules y permiso `iam.serviceAccounts.actAs` sobre la identidad de ejecución. La identidad de ejecución de Functions 2.ª gen necesita `roles/datastore.user` y `roles/firebasecloudmessaging.admin` en el proyecto. Comprueba que el agente de Eventarc tenga su rol de agente administrado, y que la cuenta del disparador pueda recibir eventos y llamar al servicio de Cloud Run (`roles/eventarc.eventReceiver` y `roles/run.invoker` según corresponda). Usa identidades gestionadas, sin archivos JSON de cuentas de servicio.

## Comandos después de la aprobación explícita

Desde un checkout limpio de la versión aprobada y con Firebase CLI conectado a la cuenta autorizada, confirma el identificador del proyecto en cada comando. Habilitar APIs, desplegar y agregar IAM son operaciones de producción.

```sh
gcloud services enable cloudfunctions.googleapis.com run.googleapis.com eventarc.googleapis.com \
  pubsub.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com fcm.googleapis.com fcmregistrations.googleapis.com \
  --project pedidos-personalizados-6610e
```

Si faltan permisos y se usa la cuenta predeterminada de Functions de segunda generación, un administrador de IAM puede asignar los roles de ejecución. Si el proyecto usa otra cuenta de ejecución o de Eventarc, sustituye la identidad por la que corresponda. Verifica primero los permisos ya concedidos.

```sh
numero_pedidos=$(gcloud projects describe pedidos-personalizados-6610e --format='value(projectNumber)')
cuenta_pedidos="${numero_pedidos}-compute@developer.gserviceaccount.com"
for rol_pedidos in roles/datastore.user roles/firebasecloudmessaging.admin roles/eventarc.eventReceiver; do
  gcloud projects add-iam-policy-binding pedidos-personalizados-6610e \
    --member="serviceAccount:${cuenta_pedidos}" --role="${rol_pedidos}"
done
```

Con las APIs habilitadas, la clave pública en la versión aprobada y los permisos verificados, ejecuta las pruebas de emulador y despliega únicamente los componentes de esta tarea.

```sh
npm ci
npm ci --prefix functions
npm test
npm run test:emuladores
npm run test:navegador
npx --no-install firebase deploy --only firestore:rules,functions:avisosDePedidos,functions:probarNotificacion \
  --project pedidos-personalizados-6610e
```

Tras desplegar las reglas y funciones, publica en GitHub Pages por el flujo existente de la rama aprobada con la clave pública configurada. Comprueba el registro de `sw.js` del mismo origen. Recarga después de instalar el worker para activar el dispositivo. En Windows y Android, comprueba en Chrome o Edge compatible. En iPhone, agrega la PWA a Inicio, ábrela desde su icono y activa los avisos desde allí con iOS compatible y permisos del sistema.

La colección de deduplicación lleva `expiraEn` a siete días. Para que se limpie de forma automática, habilita esta política TTL con aprobación para su coste:

```sh
gcloud firestore fields ttls update expiraEn --collection-group=notificacionesEventos \
  --enable-ttl --project pedidos-personalizados-6610e
```

## Comprobación real tras el despliegue

1. Inicia sesión como administrador en dos dispositivos. Activa cada uno y usa **Enviar prueba a este dispositivo**. Después cierra las ventanas de Pedidos conservando la sesión.
2. Con un empleado autorizado, cambia la nota o talla de un pedido compartido. Comprueba que el administrador recibe un aviso en cada dispositivo y que el nombre corresponde al actor real. El aviso muestra el código y una descripción genérica. Abre cada aviso y comprueba que Pedidos carga el pedido tras verificar el acceso en el servidor.
3. Desactiva los avisos en un dispositivo y repite la edición. Comprueba que queda el aviso en el otro. Apaga «Ediciones» para la cuenta y repite. Comprueba también el cierre de sesión, la denegación de permisos del navegador y la navegación después de revocar el acceso.
4. Verifica en registros que el trigger de contexto autenticado se ejecuta en este proyecto. La edición lleva un sello con UID y fecha de servidor validados por Rules. Un UID válido proporcionado por Eventarc debe concordar con el sello, o con `creadorUid` en el alta. Si el entorno no entrega un UID utilizable, el backend usa el sello autenticado de esta misma escritura. Las versiones viejas de Pedidos que editan sin sello deben recargar para participar en los avisos.

## Alcance, costes y límites

- El token es por dispositivo y sus documentos quedan bajo `usuarios/{uid}/dispositivos/{id}`. El cliente renueva al volver a usar Pedidos y recuperar conexión. El backend sigue hasta los 20 dispositivos más recientes y descarta registros con más de 45 días o rechazados definitivamente por FCM. Cerrar sesión o desactivar primero silencia la suscripción local e intenta eliminar tanto el registro remoto como la suscripción. Si se cierra sin conexión, el borrado remoto puede quedar pendiente hasta una renovación, invalidación por FCM o vencimiento. Un dispositivo silenciado no muestra el contenido de esos avisos.
- FCM transporta datos y `sw.js` presenta un único aviso del sistema con Pedidos abierta o cerrada. El SW verifica que el UID e identificador correspondan al dispositivo vinculado. El clic verifica de nuevo identidad, perfil y acceso mediante Firestore. Los avisos ya mostrados pueden seguir presentes en el sistema hasta descartarlos.
- El backend descarta cambios sin interés, demos, restauraciones, actores inactivos y al propio autor. Aplica el mismo acceso que las reglas de Firestore. Un miembro activo con permiso para el tipo de pedido puede recibir avisos si figura entre los lectores o si el pedido es público y su perfil permite ver pedidos públicos. Vuelve a comprobar acceso y preferencias antes de enviar. El límite es 30 eventos por actor y minuto y una prueba por cuenta y minuto. El consumidor reserva el identificador antes de enviar para evitar duplicados. Un fallo después de reservar se registra y puede perder ese aviso, sin afectar el guardado del pedido.
- FCM no cobra por el volumen de notificaciones. Blaze habilita las demás piezas. Con cinco usuarios, dos dispositivos por usuario y 100 cambios relevantes diarios, el orden de magnitud es unas 3.500 lecturas y 200 escrituras de Firestore diarias, más invocaciones, operaciones de dispositivos y borrados TTL. Las cuotas gratuitas del proyecto y los precios de la región determinan el cargo real. Revisa el presupuesto antes de publicar y vigila Eventarc, Cloud Functions, almacenamiento de compilaciones, Firestore y los registros.
- Pruebas de CI y locales usan el proyecto ficticio `demo-pedidos-codex`, emuladores y respuestas simuladas de FCM. La entrega real con la app cerrada, los permisos del sistema y la disponibilidad en los dispositivos físicos se validan después de un despliegue autorizado.

## Fuentes técnicas

[FCM Web y VAPID](https://firebase.google.com/docs/cloud-messaging/web/get-started), [Recepción de mensajes web](https://firebase.google.com/docs/cloud-messaging/web/receive-messages), [Triggers de Firestore con contexto](https://firebase.google.com/docs/functions/firestore-events), [Precios de Firebase](https://firebase.google.com/pricing) y [TTL en Firestore](https://firebase.google.com/docs/firestore/ttl).
