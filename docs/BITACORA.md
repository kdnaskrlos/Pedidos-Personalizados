# Bitácora de Pedidos Personalizados

## 2026-11-28 · Candidata v3.70.7

- Se reprodujo la pérdida de vinculación local al faltar el registro en Firestore y se añadió reconciliación automática con el mismo ID. Las pruebas de ciclo de vida y FCM son simuladas. [Investigación](notificaciones-push.md)
- Base oficial `d676719`. Entrega en borrador para revisión, pendiente de pruebas en dispositivos físicos y autorización de publicación.

## 2026-11-28 · Entrega v3.70.6

- Se aprobó el diseño y la publicación tras CI en verde. La última revisión oculta «Unidad» en las partidas de una pieza del detalle y del PNG, y conserva el subtotal.
- Se renovaron las capturas y los dos PNG ficticios. La entrega usa la caché `pedidos-v183` y GitHub Pages desde `main`. [PR #14](https://github.com/kdnaskrlos/Pedidos-Personalizados/pull/14)

## 2026-11-28 · Candidata v3.70.6

- Se retomó `main` en `f14b9fb` (v3.70.5) y se prepararon los ocho cambios visuales y la actualización de caché en `codex/issue-13-v3.70.6`. [Issue #13](https://github.com/kdnaskrlos/Pedidos-Personalizados/issues/13)
- Se agregaron regresiones de tallas, paginación, precios históricos, búsqueda y visor. La galería contiene capturas de Chromium y dos PNG con datos ficticios. [Galería](../demo/v3706/index.html)
- Pasaron 27 pruebas unitarias, 18 en el emulador de Firestore y 5 de navegador en Chromium. La entrega queda en borrador hasta la revisión visual y la aprobación del propietario. [PR #14](https://github.com/kdnaskrlos/Pedidos-Personalizados/pull/14)

## Base v3.70.5

- El PR #12 incorporó validación de pagos de pedidos grandes por lotes. El PR #11 incorporó notificaciones push por cuenta y dispositivo. [PR #12](https://github.com/kdnaskrlos/Pedidos-Personalizados/pull/12) · [PR #11](https://github.com/kdnaskrlos/Pedidos-Personalizados/pull/11)
