# Mediciones

El spec marca el cold start del contenedor como riesgo 2. Estas mediciones son las
que lo cierran o lo escalan.

| Fecha | Qué | Valor |
|---|---|---|
| 2026-08-19 | tamaño de la imagen (`docker images craftech-ai-chat-core:dev`) | 471MB (470733004 bytes) |
| 2026-08-19 | import de `agent.workflow` + `agent.llm` en el contenedor | ~28s (dos corridas: 27.86s y 28.49s), bajo emulación QEMU ARM64 sobre host amd64 |
