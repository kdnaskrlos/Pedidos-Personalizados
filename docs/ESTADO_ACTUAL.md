# Estado actual de Pedidos Personalizados

- Actualización del 28 de noviembre de 2026.
- Repositorio `kdnaskrlos/Pedidos-Personalizados`. Base `main` en `f14b9fbda4cc4cb9c81dd9119ca8934dc4f3a88c`, verificada contra el remoto.
- Versión de la base `v3.70.5`. Candidata `v3.70.6` en `codex/issue-13-v3.70.6`.
- Estado pendiente de aprobación visual. [Issue #13](https://github.com/kdnaskrlos/Pedidos-Personalizados/issues/13)

## Alcance

- Resumen PNG según el tipo real, datos administrativos reducidos y precio unitario conservado. El detalle interno conserva la trazabilidad.
- Las partidas del detalle y del PNG se ordenan por el catálogo de niños, adultos y plus. Los empates conservan el orden de origen y las tallas fuera del catálogo se muestran al final. El almacenamiento y el formulario de edición conservan el orden original.
- El botón de búsqueda restaura los filtros y el foco. El botón de edición del visor se alinea debajo de la foto visible. Caché PWA `pedidos-v183`.

## Evidencia y operaciones

- `npm test` y `npm run test:emuladores` verificaron pagos, compatibilidad histórica, tallas, paginación y reglas preexistentes con el proyecto local `demo-pedidos-codex`. Se comprobó la carga de Cloud Functions con ese mismo ID.
- La galería de aprobación incluye capturas de escritorio y móvil y los PNG de ambos tipos, con datos ficticios. [Galería](../demo/v3706/index.html)
- La rama candidata y el PR en borrador son el alcance de la entrega en GitHub. La publicación requiere aprobación expresa. Los cambios se limitan a este repositorio y excluyen la configuración de Firebase, reglas, índices y Cloud Functions.

## Siguiente paso

Revisar la galería y el estado de CI en el PR en borrador para decidir si se aprueba la entrega.
