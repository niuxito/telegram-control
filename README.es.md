# Telegram Control

Orquestador de agentes de IA controlado desde Telegram. Cada proyecto es un tópico de un supergrupo: envías un mensaje, un agente (Claude Code, Codex u OpenCode) trabaja en el repositorio, hace commit, puede desplegar y responde en el mismo tópico.

[Read in English](README.md) · La documentación de instalación y configuración está en el README en inglés.

## Por qué existe

Trabajar con agentes de IA implicaba abrir un terminal, elegir el proyecto correcto, lanzar la tarea y esperar delante de la pantalla. Con varios proyectos activos a la vez, cambiar de contexto era el verdadero coste. Telegram Control convierte cada proyecto en un tópico de un chat: lanzo una tarea desde el móvil, sigo el progreso en tiempo real y reviso el resultado cuando puedo, sin depender de tener el portátil abierto.

## Cómo funciona

- Cada proyecto vive en su propio tópico dentro de un supergrupo de Telegram.
- Las tareas se encolan por proyecto y se procesan en orden, con historial, estado, coste y registro completo.
- Motor de IA intercambiable por proyecto o por tarea: Claude, Codex u OpenCode, con sesiones persistentes para mantener contexto y controlar el coste.
- Avisa en el tópico de los cambios de archivos y de los commits nuevos, y puede ejecutar tareas programadas por cron.
- Revisa diffs y PRs, crea issues y hace checkpoints de sesión: resume el trabajo hecho y reinicia el contexto sin perder el hilo.

## Despliegue

Funciona en cualquier máquina con Node. Yo lo uso en una Raspberry Pi, pero no es un requisito. El despliegue de los proyectos, por ejemplo a Vercel, se lanza desde el propio chat.

## Seguridad

Los agentes se ejecutan sin pedir confirmación, con tu usuario y en tu máquina. Lee [SECURITY.md](SECURITY.md) antes de instalarlo.

## Licencia

[MIT](LICENSE)
