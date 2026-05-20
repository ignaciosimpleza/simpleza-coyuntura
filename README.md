# Coyuntura Económica · Simpleza SA

Reporte interactivo de coyuntura argentina con datos en vivo (apis.datos.gob.ar) y persistencia de snapshots mensuales en Turso.

## Estructura del repo

```
simpleza-coyuntura/
├── index.html        ← la app (todo el frontend)
├── logo.png          ← Imagotipo blanco de Simpleza
├── package.json      ← dependencia del cliente de Turso
└── api/
    └── reports.js    ← función serverless: GET/POST/DELETE reportes guardados
```

## Setup paso a paso (no requiere experiencia técnica)

### 1) Crear el repo en GitHub

1. Andá a https://github.com/new
2. Repository name: `simpleza-coyuntura` (o el nombre que prefieras)
3. Public o Private — lo que quieras
4. **No** marques nada de "Initialize" (sin README, sin .gitignore)
5. Click en **Create repository**

### 2) Subir los archivos

En la pantalla del repo recién creado, click en **uploading an existing file** (es un link azul en el medio de la página).

Arrastrá los 4 archivos:
- `index.html` (tu coyuntura.html renombrado)
- `logo.png` (el imagotipo blanco)
- `package.json`
- Y la carpeta `api` con `reports.js` adentro

Después del upload:
- Commit message: "Initial commit"
- Click **Commit changes**

> **Tip:** GitHub soporta arrastrar carpetas enteras. Si no, podés crear `api/reports.js` manualmente: click "Create new file", escribís `api/reports.js` (el `/` crea la carpeta), pegás el contenido, commit.

### 3) Crear la base de datos en Turso

1. Andá a https://app.turso.tech (login con tu cuenta)
2. **Create Database** → ponele un nombre (`coyuntura`) y elegí región (Buenos Aires o São Paulo)
3. Una vez creada, click en la base → tab **Outerbase Studio** (o usar el SQL editor que ofrezca la UI)
4. Pegá y ejecutá este SQL una sola vez:
   ```sql
   CREATE TABLE IF NOT EXISTS reports (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     month TEXT NOT NULL,
     version INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     title TEXT NOT NULL,
     data TEXT NOT NULL,
     UNIQUE(month, version)
   );
   ```
   (Esto también lo crea la API automáticamente la primera vez que se llama, así que si no lo hacés ahora no importa.)
5. Tab **Connect** → copiar el **Database URL** (algo como `libsql://coyuntura-xxxx.turso.io`)
6. Tab **Connect** → **Create Token** → copiar el token largo

### 4) Importar el repo a Vercel

1. https://vercel.com/new
2. **Import Git Repository** → elegir tu `simpleza-coyuntura`
3. Framework Preset: **Other**
4. Build & Output Settings: **dejar todo en default**
5. **Environment Variables** (importantísimo): agregar dos:
   - Nombre: `TURSO_DATABASE_URL` → Valor: el URL que copiaste de Turso
   - Nombre: `TURSO_AUTH_TOKEN` → Valor: el token largo
6. **Deploy**

En 30–60 segundos te da una URL `simpleza-coyuntura.vercel.app`. Entrá y listo.

## Cómo usar la app

- **Topbar:** muestra el mes vigente (ej. "Mayo 2026"). El botón **↻** re-consulta las APIs y refresca los gráficos.
- **Botón "+ Guardar reporte":** captura el estado actual y lo guarda como un snapshot. Si ya hay un reporte para este mes, crea una v2, v3, etc.
- **Sidebar — "Reportes guardados":** lista todos los snapshots. Click para ver uno; **×** para eliminar.
- **Banner amarillo:** aparece cuando estás viendo un reporte guardado en lugar de los datos en vivo. Click en "Volver al mes vigente" para salir.

## Mantenimiento

- **Cambiar dominio:** Vercel → tu proyecto → Settings → Domains.
- **Ver/editar reportes en la base:** Turso → Outerbase Studio → `SELECT * FROM reports;`
- **Borrar todo y empezar de cero:** Turso → `DELETE FROM reports;`

## Datos en vivo (sin Turso)

La app funciona sin Turso configurado — solamente no podés guardar snapshots. Las APIs públicas (IPC, EMAE, salarios) siguen cargando siempre porque van directo desde el navegador a `apis.datos.gob.ar`.
