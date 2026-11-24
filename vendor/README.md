# Bibliotecas locales

- `libheif-bundle.mjs` es `libheif-wasm/libheif-bundle.mjs` de [libheif-js 1.23.5](https://www.npmjs.com/package/libheif-js/v/1.23.5), con WASM integrado y licencia LGPL 3. El código fuente está disponible en [libheif v1.23.5](https://github.com/strukturag/libheif/tree/v1.23.5) y las herramientas de compilación en [libheif-js](https://github.com/catdad-experiments/libheif-js). El worker carga el módulo local al abrir un HEIC/HEIF. El acceso a los metadatos EXIF usa la interfaz WASM de esta versión y cuenta con una prueba con un archivo HEIC real generado con datos ficticios.

La demo independiente incluye el mismo conversor y puede abrirse desde disco.
