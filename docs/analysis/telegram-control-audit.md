# Telegram Control Audit

Fecha de análisis: 2026-07-08

Este documento evalúa el estado actual del proyecto `telegram-control` a partir del código del repositorio, con foco en:

- funcionalidades reales
- valor práctico de cada funcionalidad
- arquitectura y separación de responsabilidades
- buenas prácticas y deuda técnica
- riesgos operativos y de mantenibilidad

## Resumen ejecutivo

`telegram-control` es un orquestador de proyectos locales controlado desde Telegram. Su propuesta de valor es fuerte: centraliza tareas de IA, automatización, vigilancia de cambios y coordinación de proyectos sin obligar al usuario a abandonar el chat.

Puntuación global estimada:

- Utilidad del producto: 8.7/10
- Solidez arquitectónica: 7.0/10
- Mantenibilidad: 6.5/10
- Robustez operativa: 7.2/10
- Calidad del diseño de la experiencia: 8.0/10

Veredicto corto:

- Hay una base funcional clara y útil.
- La arquitectura está razonablemente modularizada, pero sigue siendo un monolito de proceso único con bastante estado en memoria.
- El mayor riesgo no es funcional sino de mantenimiento: mucha lógica vive en handlers grandes y en bootstrap manual.

## Qué hace el proyecto

El sistema gestiona uno o varios proyectos locales desde un bot de Telegram. Cada proyecto se representa con un tópico en un supergrupo y puede:

- recibir tareas de IA
- usar varios motores/agentes
- vigilar cambios de archivos
- vigilar commits git
- programar tareas por cron
- guardar notas e ideas
- revisar diffs y PRs
- desplegar o consultar servicios externos
- persistir estado en SQLite mediante Drizzle

El flujo principal se reparte entre:

- arranque y bootstrap en [`src/index.ts`](../../src/index.ts)
- orquestación por proyecto en [`src/projects/ProjectManager.ts`](../../src/projects/ProjectManager.ts)
- handlers de Telegram en [`src/bot/handlers/`](../../src/bot/handlers)
- ejecución de sesiones de Claude en [`src/claude/ClaudeSession.ts`](../../src/claude/ClaudeSession.ts)
- capa de agentes en [`src/agents/`](../../src/agents)
- persistencia en [`src/db/`](../../src/db)
- API HTTP/SSE de observabilidad en [`src/api/server.ts`](../../src/api/server.ts)

## Funcionalidades y valoración

Escala usada:

- 1-3: baja
- 4-6: media
- 7-8: alta
- 9-10: muy alta

| Funcionalidad | Utilidad | Valor cualitativo | Observación |
| --- | ---: | --- | --- |
| Gestión de proyectos por tópico de Telegram | 10 | Muy alta | Es la pieza central del producto; convierte Telegram en un panel de control operativo. |
| Cola de tareas por proyecto | 10 | Muy alta | Da serialización, historial y control de estado. Es una de las mejores decisiones del código. |
| Sesiones persistentes de Claude | 9 | Muy alta | Permite continuidad y control de coste. Bien orientado a uso real. |
| Selección de modelo por proyecto con `/model` | 8 | Alta | Útil para ajustar coste/calidad. Ahora usa alias estables del CLI, lo que reduce drift. |
| Modo multiactor: Claude / Codex / OpenCode | 9 | Muy alta | Aporta flexibilidad real; no está limitado a un único proveedor. |
| Vistas de estado y coste (`/status`, `/session`, `/tasklist`, `/tasklog`) | 8 | Alta | Muy útiles para operar y depurar sin salir de Telegram. |
| Watcher de archivos | 8 | Alta | Convierte cambios locales en señales operativas. Bien alineado con el caso de uso. |
| Watcher de git | 7 | Alta | Útil para trazabilidad de commits; añade contexto de evolución del repo. |
| Programación por cron | 8 | Alta | Amplía el sistema hacia automatización real, no solo chat asíncrono. |
| Gestión de ideas globales (`/idea`) | 6 | Media | Buena extensión de producto, aunque todavía periférica respecto al flujo principal. |
| Gestión de notas por proyecto | 6 | Media | Útil como memoria ligera, pero no es una función diferenciadora. |
| Revisión de diffs y PRs | 8 | Alta | Aporta valor técnico concreto para code review asistido. |
| Gestión de issues locales / GitHub / Vercel | 7 | Alta | Amplía la utilidad del bot para trabajo de producto y despliegue. |
| Acceso de invitados y solicitudes de acceso | 7 | Alta | Importante para controlar uso en entornos compartidos. |
| API HTTP/SSE para telemetría | 8 | Alta | Muy buena base para observabilidad y futuras integraciones externas. |
| Flujo de secreto por DM | 7 | Alta | Resuelve un problema real de seguridad operativa en chats compartidos. |

## Análisis funcional

### 1. Gestión de proyectos

Cada proyecto queda vinculado a un tópico de Telegram y a una ruta local. Esto permite una experiencia mental simple:

- un proyecto = una carpeta local + un tópico + una sesión activa

Puntos fuertes:

- asociación clara entre contexto de chat y contexto de filesystem
- persistencia en SQLite
- soporte para crear, importar y clonar proyectos
- reutilización del mismo canal para control, notificaciones y trazabilidad

Limitaciones:

- el sistema está acoplado a una instancia única de bot
- el estado operativo depende del proceso vivo
- no hay una capa de reconciliación externa fuerte si se pierde el runtime

### 2. Cola de tareas y ejecución de IA

`ClaudeSession` implementa una cola secuencial con recuperación y actualización de estado. Eso evita que los usuarios pisen tareas concurrentes y simplifica el seguimiento.

Lo mejor:

- serialización simple y efectiva
- mensajes de progreso y heartbeat
- manejo explícito de fallos transitorios de Telegram
- rehidratación tras reinicio

Lo peor:

- la clase concentra demasiadas responsabilidades
- la complejidad de streaming, edición de mensajes, persistencia y reintentos vive en un solo módulo

### 3. Multiactor y enrutado de agentes

La capa de agentes permite seleccionar entre Claude, Codex y OpenCode. Esto es una ventaja estratégica porque:

- reduce dependencia de un solo proveedor
- permite elegir por coste, velocidad o calidad
- abre la puerta a políticas de ruteo por sensibilidad de tarea

La abstracción es buena, pero todavía se percibe como una capa de integración más que como una plataforma plenamente extensible.

### 4. Automatización y observabilidad

El sistema no solo ejecuta tareas; también informa:

- cambios de archivos
- commits git
- estado de tareas
- telemetría por API

Eso eleva el producto por encima de un bot de chat simple. El observability surface es una de sus mejores partes porque hace visible el ciclo de vida real del trabajo.

## Arquitectura

### Vista general

La arquitectura actual es un monolito modular:

- un único proceso Node.js
- una base SQLite local
- un bot Telegram como interfaz principal
- múltiples servicios internos coordinados por clases dedicadas

### Capas

#### 1. Bootstrap

[`src/index.ts`](../../src/index.ts) se encarga de:

- inicializar el entorno
- aplicar migraciones o crear tablas manualmente
- crear el bot
- montar middleware
- registrar handlers
- iniciar la API
- cargar proyectos activos

Esto funciona, pero la clase/archivo de arranque está bastante cargado. Es una señal típica de que el proyecto ha crecido alrededor de un entrypoint que acabó absorbiendo demasiada responsabilidad.

#### 2. Orquestación

[`ProjectManager`](../../src/projects/ProjectManager.ts) es el centro operacional:

- crea y recupera sesiones
- arranca watchers
- archiva y pausa proyectos
- registra proyectos nuevos

El diseño es correcto en espíritu: hay una sola pieza que conoce el ciclo de vida de un proyecto. El coste es que se convierte en un punto caliente de coordinación.

#### 3. Handlers de Telegram

Los handlers están separados por dominio:

- tareas
- configuración
- git
- issues
- schedule
- ideas

Esto es una buena práctica. El problema es que algunos archivos están creciendo mucho y mezclan:

- parsing de comandos
- lógica de negocio
- persistencia
- formateo de respuesta

#### 4. Persistencia

Drizzle define el esquema en [`src/db/schema.ts`](../../src/db/schema.ts), pero el arranque también contiene SQL manual de fallback y migración ad hoc.

Eso da resiliencia inicial, pero introduce un riesgo clásico:

- el esquema real y el esquema esperado pueden divergir

#### 5. Observabilidad

La API HTTP en [`src/api/server.ts`](../../src/api/server.ts) expone:

- health
- lista de agentes
- detalle de agente
- tareas recientes
- stream SSE de eventos

Esta capa está bien pensada para inspección y automatización externa.

## Buenas prácticas detectadas

- Separación por dominio en handlers y managers.
- Persistencia estructurada con Drizzle en vez de SQL disperso.
- Reintentos defensivos ante errores transitorios de Telegram.
- Notificaciones sin `parse_mode` en mensajes sensibles para evitar inyección de formato.
- Rehidratación de sesiones y recuperación de cola tras reinicio.
- Validación de cron antes de registrar jobs.
- Soporte de múltiples agentes con una capa de registro central.
- Uso de API interna y SSE para observabilidad sin acoplarse a Telegram.

## Smells y deuda técnica

### 1. `index.ts` hace demasiado

Síntoma:

- bootstrap
- migraciones
- creación de tablas
- setup de handlers
- arranque de API
- control de secretos

Impacto:

- más difícil de testear
- más difícil de leer
- más fácil introducir regresiones al tocar arranque

### 2. Doble fuente de verdad de esquema

Síntoma:

- Drizzle schema en `src/db/schema.ts`
- SQL manual en `src/index.ts`

Impacto:

- drift de esquema
- migraciones menos confiables
- mantenimiento más costoso

### 3. Handlers demasiado largos

Síntoma:

- [`src/bot/handlers/topic/config.ts`](../../src/bot/handlers/topic/config.ts)
- [`src/bot/handlers/topic/tasks.ts`](../../src/bot/handlers/topic/tasks.ts)
- [`src/bot/handlers/topic/text.ts`](../../src/bot/handlers/topic/text.ts)

Impacto:

- alta complejidad cognitiva
- difícil aislar bugs
- mayor fricción para añadir comandos nuevos

### 4. Estado en memoria como dependencia operativa

Síntoma:

- mapas de sesiones y secretos pendientes
- watchers y timers residentes

Impacto:

- el proceso único es un punto de fallo
- las reinicializaciones requieren rehidratación cuidadosa

### 5. Typing laxo

Síntoma:

- uso frecuente de `any` en handlers
- contratos implícitos entre módulos

Impacto:

- menos ayuda del compilador
- más probabilidad de errores silenciosos

### 6. Responsabilidad mixta en la capa de mensajes

Síntoma:

- edición de mensajes
- chunking
- fallback a sendMessage
- formateo

Impacto:

- lógica repetida
- más difícil corregir diferencias entre flujos

## Riesgos principales

### Riesgo 1: drift de persistencia

La convivencia de Drizzle + SQL manual puede acabar en inconsistencias si se sigue creciendo sin consolidar migraciones.

### Riesgo 2: crecimiento desordenado de handlers

Si se siguen añadiendo comandos y flujos sin extraer servicios auxiliares, los handlers terminarán siendo el cuello de botella del mantenimiento.

### Riesgo 3: dependencia de proceso único

La arquitectura es válida para un bot de control local, pero la resiliencia depende de que el proceso siga vivo y de que la rehidratación esté siempre correcta.

### Riesgo 4: complejidad operacional de IA

La convivencia de varios proveedores, límites, modelos y estados de sesión obliga a tener muy bien controlados:

- errores transitorios
- cuotas
- caídas parciales
- cambios de API

## Recomendaciones priorizadas

### Prioridad alta

1. Consolidar el bootstrap y las migraciones en una capa dedicada.
2. Reducir la lógica de los handlers grandes extrayendo servicios por caso de uso.
3. Eliminar la doble fuente de verdad del esquema o, como mínimo, documentar una estrategia clara de migración.
4. Añadir más tests de integración sobre los flujos críticos: `/task`, `/model`, cola, rehidratación y watchers.

### Prioridad media

1. Tipar mejor los handlers y evitar `any` cuando el contrato ya es estable.
2. Centralizar utilidades repetidas de formateo y chunking de mensajes.
3. Separar con más nitidez el acceso a datos del control de conversación.
4. Reforzar métricas internas o logs estructurados para costes, latencia y fallos por agente.

### Prioridad baja

1. Extraer una capa de configuración de comandos y ayuda generada automáticamente.
2. Revisar si algunas capacidades periféricas podrían moverse a módulos opcionales.
3. Documentar explícitamente qué estado es efímero y cuál es persistente.

## Valoración final

Este proyecto tiene una base muy útil y bastante sólida para un caso de uso real: controlar desarrollo y automatización desde Telegram. No es un demo superficial. Hay persistencia, recuperación, notificación, automatización y soporte para varios agentes.

La principal deuda no está en la idea ni en la funcionalidad; está en la evolución de la base de código:

- el núcleo ha crecido
- algunos archivos concentran demasiado
- el arranque manual y el schema drift son los riesgos más claros

Si se ataca esa deuda, el proyecto tiene recorrido real para convertirse en una herramienta bastante seria de orquestación asistida por IA.

