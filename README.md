# Telegram Control

Orquestador de agentes de IA controlado por Telegram. Gestiono todos mis proyectos personales —código, despliegues, revisiones— sin salir de un chat.

## Por qué existe

Trabajar con agentes de IA (Claude, Codex, OpenCode) implicaba abrir un terminal, elegir el proyecto correcto, lanzar la tarea y esperar delante de la pantalla. Con varios proyectos activos a la vez, cambiar de contexto era el verdadero coste. Telegram Control convierte cada proyecto en un tópico de un chat: lanzo una tarea desde el móvil, sigo el progreso en tiempo real y reviso el resultado cuando puedo, sin depender de tener el portátil abierto.

## Cómo funciona

- Cada proyecto vive en su propio tópico dentro de un supergrupo de Telegram.
- Las tareas se encolan por proyecto: se procesan en orden, con historial y estado (pendiente / en curso / completada / fallida).
- Motor de IA intercambiable por proyecto: Claude, Codex u OpenCode, con sesiones persistentes para mantener contexto y controlar el coste.
- Vigila cambios de archivos y commits de git automáticamente, y puede programar tareas por cron.
- Guarda notas, revisa diffs y PRs, y hace checkpoints de sesión —resume el trabajo hecho y reinicia el contexto— sin perder el hilo.

## Despliegue

Puede ejecutarse en cualquier máquina con Node —lo uso habitualmente en una Raspberry Pi, pero no es una dependencia—, y también se despliega directamente en un proveedor cloud, en mi caso Vercel. El despliegue se dispara desde el propio chat: no hace falta salir de Telegram para pasar de código a producción.

## Arquitectura

TypeScript · grammy (framework de bots de Telegram) · SQLite + Drizzle ORM para persistencia · chokidar (vigilancia de archivos) · simple-git (vigilancia de git) · node-cron (tareas programadas) · API HTTP + SSE para exponer el estado de los agentes en tiempo real a consumidores externos.

## Estado actual

Es la base con la que he construido el resto de mis proyectos desde entonces. Según mi propia auditoría interna (julio 2026): utilidad del producto 8.7/10, arquitectura razonablemente modular pero con lógica concentrada en handlers grandes — la mayor deuda técnica es de mantenibilidad, no de funcionalidad.

## Licencia

Privado — todos los derechos reservados.
