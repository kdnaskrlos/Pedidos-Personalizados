# Comic Shop · Pedidos: guía de instalación

La app vive en **GitHub Pages** (gratis) y guarda los pedidos, usuarios y fotos en **Firebase** (gratis, de Google). Tus empleados entran con **usuario y PIN** desde el navegador, o instalándola como app en el celular o el PC. No necesitan cuenta de Claude, de GitHub ni de Google.

Tiempo estimado: 20 minutos, una sola vez.

---

## Paso 1 · Crear el proyecto de Firebase

1. Entra en <https://console.firebase.google.com> con tu cuenta de Google.
2. **Crear un proyecto** → nombre: `comicshop-pedidos` → puedes desactivar Google Analytics → **Crear**.
3. Ya dentro del proyecto, toca el ícono **`</>` (Web)** para registrar una app web.
   - Apodo: `pedidos`. **No** marques "Firebase Hosting".
   - Firebase te muestra un bloque `const firebaseConfig = { ... }`. **Déjalo abierto o cópialo**: lo usarás en el paso 5.

## Paso 2 · Activar el inicio de sesión

1. Menú izquierdo → **Compilación → Authentication → Comenzar**.
2. Pestaña **Método de acceso** → **Correo electrónico/contraseña** → **Habilitar** (solo el primer interruptor) → **Guardar**.

> La app crea correos internos automáticamente; tus empleados solo ven "usuario" y "PIN".

## Paso 3 · Crear la base de datos

1. Menú izquierdo → **Compilación → Firestore Database → Crear base de datos**.
2. Ubicación: elige la más cercana (por ejemplo `us-east1`) → **Siguiente**.
3. Elige **Comenzar en modo de producción** → **Crear**.

## Paso 4 · Publicar las reglas de seguridad

1. En Firestore Database, abre la pestaña **Reglas**.
2. Borra todo lo que hay y pega **el contenido completo del archivo `firestore.rules`** de este repositorio.
3. **Publicar**.

> Estas reglas son las que impiden que alguien sin usuario lea o cambie pedidos, y que un empleado vea pedidos que no le corresponden.

## Paso 5 · Conectar la app con Firebase (en GitHub)

Los archivos ya están en el repositorio `Pedidos-Personalizados`.

1. Abre `config.js` en GitHub → ícono del lápiz ✏️ → reemplaza los valores con los de tu `firebaseConfig` del paso 1 → **Commit changes**.
   Debe quedar así (con tus datos):
   ```js
   export const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "comicshop-pedidos.firebaseapp.com",
     projectId: "comicshop-pedidos",
     storageBucket: "comicshop-pedidos.appspot.com",
     messagingSenderId: "123...",
     appId: "1:123...:web:abc..."
   };
   ```
   > Estos datos no son secretos; es normal que estén en la página.
2. **Settings → Pages** → en *Branch* elige `main` y `/ (root)` → **Save**.
   En 1 o 2 minutos aparece tu enlace: `https://kdnaskrlos.github.io/Pedidos-Personalizados/`

## Paso 6 · Autorizar tu dominio en Firebase

Firebase → **Authentication → Configuración → Dominios autorizados → Agregar dominio** → escribe `kdnaskrlos.github.io` → **Agregar**.

## Paso 7 · Crear tu administrador (¡hazlo enseguida!)

1. Abre tu enlace `https://kdnaskrlos.github.io/Pedidos-Personalizados/`.
2. Aparece **"Crear administrador"**: escribe tu nombre, usuario (ej. `carlos`) y un PIN.
3. Listo: ya eres el administrador. Esa pantalla no vuelve a aparecer.

> Hazlo apenas publiques: el primero que abra el enlace por primera vez se convierte en administrador.

## Paso 8 · Dar de alta a tu equipo

1. En la app → **Equipo → Nuevo usuario**: nombre, usuario, PIN (se sugiere uno) y qué puede ver.
2. Toca **Copiar** y pégale los datos por WhatsApp. El mensaje ya incluye el enlace.
3. Si alguien olvida su PIN: **Equipo → Nuevo PIN**.

## Instalar como app

- **Android (Chrome):** abre el enlace → menú ⋮ → **Instalar app** o **Agregar a pantalla de inicio**.
- **iPhone (Safari):** botón Compartir → **Agregar a inicio**.
- **PC (Chrome/Edge):** ícono de instalar en la barra de direcciones, o el botón **Instalar app** arriba a la derecha.

---

## Bueno saber

- **Gratis:** el plan gratuito de Firebase (Spark) incluye 1 GB de base de datos y 50.000 lecturas diarias, suficiente para una tienda. Las fotos se guardan comprimidas (unos 100–300 KB cada una) dentro de la base de datos, así que no hace falta registrar una tarjeta.
- **Sin internet:** la app sigue funcionando y sincroniza los cambios al volver la conexión.
- **Notificaciones:** en **Avisos → Activar notificaciones**, cada dispositivo te avisa una vez al día, al abrir la app, si hay entregas cerca o clientes por avisar.
- **Actualizaciones:** cuando cambiemos la app, solo hay que reemplazar `index.html` (y los archivos que cambien) en GitHub. Nunca reemplaces tu `config.js`.
