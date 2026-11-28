# Estado actual de Pedidos Personalizados

- Actualización del 28 de noviembre de 2026.
- Repositorio `kdnaskrlos/Pedidos-Personalizados`. Base `main` en `f14b9fbda4cc4cb9c81dd9119ca8934dc4f3a88c`, verificada contra el remoto.
- Base oficial comprobada `v3.70.6` en `d676719`. Candidata `v3.70.7` en `codex/v3.70.7-notificaciones`, pendiente de revisión.
- Versión de la entrega anterior `v3.70.6`, desde la base `v3.70.5`.
- Diseño y publicación aprobados por el propietario, con publicación condicionada a CI en verde. [PR #14](https://github.com/kdnaskrlos/Pedidos-Personalizados/pull/14) · [Issue #13](https://github.com/kdnaskrlos/Pedidos-Personalizados/issues/13)

## Incidencia de notificaciones

La candidata distingue la intención persistida en IndexedDB de la verificación del registro. La auditoría corrigió la falsa activación tras un arranque sin red y la baja ignorada durante una renovación. Usa caché de aplicación `pedidos-v185`. Pendiente de comprobación física en Android e iOS. [Investigación y pruebas](notificaciones-push.md) · [PR #15](https://github.com/kdnaskrlos/Pedidos-Personalizados/pull/15)

## Alcance de v3.70.6

- Resumen PNG según el tipo real, datos administrativos reducidos y precio unitario visible solo en partidas de más de una unidad. El detalle interno conserva la trazabilidad.
- Las partidas del detalle y del PNG se ordenan por el catálogo de niños, adultos y plus. Los empates conservan el orden de origen y las tallas fuera del catálogo se muestran al final. El almacenamiento y el formulario de edición conservan el orden original.
- El botón de búsqueda restaura los filtros y el foco. El botón de edición del visor se alinea debajo de la foto visible. Caché PWA `pedidos-v183`.

## Evidencia y operaciones

- Verificación local con Node 24, Java 21, Chromium y el proyecto de emuladores `demo-pedidos-codex`. Pasaron 27 pruebas unitarias, 18 de Firestore y 5 de navegador. Se comprobó la carga de Cloud Functions con ese mismo ID. El resultado del workflow remoto se consulta en el PR.
- La galería de aprobación incluye capturas de escritorio y móvil y los PNG de ambos tipos, con datos ficticios. [Galería](../demo/v3706/index.html)
- GitHub Pages publica desde la raíz de `main`. La actualización de la PWA pasa de `pedidos-v182` a `pedidos-v183`. [Sitio](https://kdnaskrlos.github.io/Pedidos-Personalizados/)
- Los cambios se limitan a este repositorio y excluyen Firebase, sus reglas, índices, funciones y datos.

## Verificación de la publicación

La evidencia de CI y la revisión fusionada figuran en el PR. El sitio y su service worker permiten comprobar la versión servida.
