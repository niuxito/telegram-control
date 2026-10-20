<p align="center"><img src="docs/logo.svg" width="96" height="96" alt="Telegram Control logo"></p>

# Telegram Control

Orquestador de agentes de IA controlado desde Telegram. Cada proyecto es un tópico de un supergrupo: envías un mensaje, un agente (Claude Code, Codex u OpenCode) trabaja en el repositorio, hace commit, puede desplegar y responde en el mismo tópico.

[Web](https://www.alexisparron.com/telegram-control/) · [Read in English](README.md) · La documentación de instalación y configuración está en el README en inglés.

## Por qué existe

Trabajar con agentes de IA implicaba abrir un terminal, elegir el proyecto correcto, lanzar la tarea y esperar delante de la pantalla. Con varios proyectos activos a la vez, cambiar de contexto era el verdadero coste. Telegram Control convierte cada proyecto en un tópico de un chat: lanzo una tarea desde el móvil, sigo el progreso en tiempo real y reviso el resultado cuando puedo, sin depender de tener el portátil abierto.

## Cómo funciona

**Trabajar**
- Cada proyecto vive en su propio tópico. Un mensaje normal en el tópico es una tarea para ese proyecto. Se crean con `/new`, se clonan de GitHub con `/clone` o se importan con `/import`.
- Las tareas se encolan por proyecto y se procesan en orden, con historial, estado, coste y registro completo (`/queue`, `/tasklist`, `/tasklog`).
- Agente intercambiable por proyecto (`/setdefault`) o por tarea (`/codex`, `/opencode`): Claude Code, Codex u OpenCode, con sesiones persistentes para mantener el contexto y controlar el coste.
- `/plan` prepara un plan antes de tocar código, `/issue` crea issues en GitHub y `/review` revisa el diff actual o un PR.
- Los mensajes de voz se transcriben y se convierten en tareas (opcional, con `OPENAI_API_KEY`).

**Controlar**
- Presupuesto por proyecto con `/budget`: avisa al acercarse al límite y detiene las tareas al superarlo.
- `/checkpoint` resume el trabajo hecho y reinicia el contexto sin perder el hilo.
- `/costs` muestra el coste de todos los proyectos de un vistazo.

**Automatizar**
- Tareas programadas con expresiones cron (`/schedule add`) y la misma tarea en todos los proyectos con `/broadcast`.
- Avisos en el tópico de los cambios de archivos y de los commits nuevos (`/watch`, `/gitwatch`).
- `/github` crea el repo y lo sube; `/vercel deploy` despliega en Vercel tras pedir confirmación (o `/vercel preview`).

**Compartir**
- Invitados de solo lectura que ven el estado de los proyectos (`/guest`).
- API HTTP con eventos en directo (SSE) para seguir a los agentes desde otras herramientas.

## Despliegue

Funciona en cualquier máquina con Node. Yo lo uso en una Raspberry Pi, pero no es un requisito. El despliegue de los proyectos, por ejemplo a Vercel, se lanza desde el propio chat.

## Seguridad

Los agentes se ejecutan sin pedir confirmación, con tu usuario y en tu máquina. Lee [SECURITY.md](SECURITY.md) antes de instalarlo.

## Licencia

[MIT](LICENSE)
