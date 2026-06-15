# Cómo funciona el routing en Vercel con páginas estáticas HTML

## El problema

Cuando copiamos archivos HTML directamente a la raíz del proyecto, Vercel NO los sirve como rutas. Por ejemplo:

```
❌ INCORRECTO
camelion-landing/
├── agendar.html      → NO accesible en /agendar
├── gracias.html      → NO accesible en /gracias
```

Intentar acceder a `camelionmedia.com/agendar` da **404 Not Found**.

## La solución

Vercel usa un sistema de carpetas con `index.html`. Cada ruta debe ser una **carpeta con un archivo `index.html` adentro**:

```
✅ CORRECTO
camelion-landing/
├── agendar/
│   └── index.html    → Accesible en /agendar
├── gracias/
│   └── index.html    → Accesible en /gracias
├── closers/
│   └── index.html    → Accesible en /closers
├── v1/
│   └── index.html    → Accesible en /v1
└── v2/
    └── index.html    → Accesible en /v2
```

## Por qué funciona así

Vercel trata las carpetas como **rutas URL**. Busca un archivo `index.html` dentro de cada carpeta y lo sirve cuando alguien accede a esa ruta.

- `/` → sirve `index.html` en la raíz
- `/agendar/` → sirve `agendar/index.html`
- `/gracias/` → sirve `gracias/index.html`

## Pasos para añadir una nueva página

1. **Crear una carpeta** con el nombre de la ruta:
   ```bash
   mkdir nueva-pagina
   ```

2. **Mover o crear** el archivo `index.html` dentro:
   ```bash
   mv nueva-pagina.html nueva-pagina/index.html
   # O crear uno nuevo
   touch nueva-pagina/index.html
   ```

3. **Hacer commit y push**:
   ```bash
   git add nueva-pagina/
   git commit -m "Add nueva-pagina"
   git push
   ```

4. **Vercel redeploya automáticamente** y la página está en `camelionmedia.com/nueva-pagina`

## Ejemplo real (lo que hicimos hoy)

```bash
# Estaban como archivos sueltos (❌ no funcionaban)
agendar.html
gracias.html
closers.html

# Los movemos a carpetas con index.html (✅ funcionan)
mkdir -p agendar gracias closers
mv agendar.html agendar/index.html
mv gracias.html gracias/index.html
mv closers.html closers/index.html

git add -A
git commit -m "Restructure pages for Vercel routing"
git push
```

Después de esto, todas las rutas funcionan:
- `camelionmedia.com/agendar` ✅
- `camelionmedia.com/gracias` ✅
- `camelionmedia.com/closers` ✅

## Recordar para próximas páginas

Cuando copies una página de camelion-portal o crees una nueva:

```bash
# ❌ NUNCA hagas esto
cp /ruta/pagina.html ./pagina.html

# ✅ SIEMPRE haz esto
mkdir pagina && cp /ruta/pagina.html ./pagina/index.html
```

O si ya la copiaste como archivo suelto, reorganiza inmediatamente:

```bash
mkdir pagina
mv pagina.html pagina/index.html
git add -A && git commit -m "Fix: move pagina.html to pagina/index.html for routing"
```

## Excepciones

El archivo raíz **sí funciona sin carpeta**:
- `index.html` en la raíz → accesible en `/`
- Los archivos `.html` sueltos en raíz NO son rutas automáticas

## Vercel Edge Middleware (opcional avanzado)

Si necesitaras lógica más compleja (rewrites, redirects, etc.), podrías usar `vercel.json`, pero para nuestro caso simple, la estructura de carpetas es más que suficiente.

---

**TL;DR:** Carpetas con `index.html` adentro. Eso es todo.
