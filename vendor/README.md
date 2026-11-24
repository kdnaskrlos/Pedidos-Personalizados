# Bibliotecas locales

- `libheif-bundle.mjs` es `libheif-wasm/libheif-bundle.mjs` de [libheif-js 1.23.5](https://www.npmjs.com/package/libheif-js/v/1.23.5), con WASM integrado y licencia LGPL 3. El código fuente está disponible en [libheif v1.23.5](https://github.com/strukturag/libheif/tree/v1.23.5) y las herramientas de compilación en [libheif-js](https://github.com/catdad-experiments/libheif-js). El worker carga el módulo local al abrir un HEIC/HEIF. El acceso a los metadatos EXIF usa la interfaz WASM de esta versión y cuenta con una prueba con un archivo HEIC real generado con datos ficticios.
- `fflate.mjs` es `esm/browser.js` de [fflate 0.8.2](https://www.npmjs.com/package/fflate/v/0.8.2), con licencia MIT. El archivo ZIP conserva los bytes de las referencias almacenadas.

La demo independiente incluye las mismas versiones de ambas bibliotecas y puede abrirse desde disco.
