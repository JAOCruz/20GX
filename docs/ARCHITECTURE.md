# Arquitectura de producción — Slippi Pipeline

## Estado actual (monolito)

Todo corre en un solo proceso Node.js (`dashboard-server.js`):

- API HTTP (`express`)
- Scans de replays
- Renderizado de clips (spawn de `render-selected-stocks.js`)
- Grabación de audio Discord
- Envío de Telegram

Esto funciona para uso personal, pero un render pesado puede degradar el dashboard o causar timeouts.

---

## Objetivo

Separar lo que es **interactivo** (dashboard/API) de lo que es **pesado** (renders), con una cola persistente en el medio.

## Arquitectura objetivo

```
┌─────────────┐      ┌──────────────┐      ┌─────────────────┐
│   Usuario   │─────▶│  API Server  │─────▶│   Redis (BullMQ)│
│  (dashboard)│◀─────│  (ligero)    │◀─────│   cola de jobs  │
└─────────────┘      └──────────────┘      └─────────────────┘
                            │                         │
                            │                  ┌──────┘
                            │                  ▼
                            │         ┌─────────────────┐
                            │         │  Render Worker  │
                            │         │  (proceso aparte)│
                            │         └─────────────────┘
                            │                  │
                            ▼                  ▼
                     ┌───────────────────────────────────┐
                     │   Object storage (S3/MinIO)       │
                     │   clips intermedios y finales       │
                     └───────────────────────────────────┘
```

### Componentes

| Componente        | Tecnología propuesta | Responsabilidad |
|-------------------|----------------------|-----------------|
| API / Dashboard   | Express + React SPA  | Recibir requests, listar juegos, encolar jobs, mostrar estado. |
| Cola de jobs      | BullMQ + Redis       | Persistencia, reintentos, prioridad, rate-limit. |
| Render Worker     | Proceso Node aparte  | Consumir jobs, ejecutar Dolphin/ffmpeg, reportar progreso. |
| Object storage    | MinIO o S3           | Guardar clips, previews y recordings. |
| Base de datos     | PostgreSQL o SQLite  | Metadata de jobs, games, sessions, historial. |
| Bots              | Telegram / Discord   | Notificaciones y control. |
| Monitoring        | Logs estructurados   | Trackear fallos, tiempos, reintentos. |

---

## Fases de migración

### Fase 1 — Monolito robusto (ya en curso)

- [x] `/api/video-preview` async y cancelable.
- [x] Progreso en tiempo real en el dashboard.
- [x] Logs limpios.
- [x] Notificaciones por Telegram.
- [ ] Manejo de errores y reintentos por job.

### Fase 2 — Worker separado, cola simple

Crear un `worker-server.js` que corra como proceso aparte (incluso en la misma máquina) y una cola mínima:

- Opción A: **BullMQ + Redis** (recomendado si se puede instalar Redis).
- Opción B: **SQLite + eventos** (sin nuevas dependencias de infraestructura).

El API server solo encola jobs; el worker los procesa y reporta progreso vía la cola o un endpoint de callback.

**Beneficio principal:** el dashboard nunca se congela por un render.

### Fase 3 — Escalable / multi-máquina

- Docker Compose con `api`, `worker`, `redis`, `postgres`, `minio`.
- Múltiples workers escuchando la misma cola.
- CDN para servir clips.
- Auth multi-tenant si se va a vender como servicio.

---

## Decisiones de diseño

### ¿Por qué separar el worker?

Un render de Dolphin + ffmpeg puede saturar CPU/GPU y bloquear el event loop de Express. Con un worker aparte:

- El dashboard sigue respondiendo.
- Se pueden escalar workers independientemente.
- Un crash del render no tumba la API.

### ¿Por qué Redis/BullMQ?

- Jobs persistentes ante reinicios.
- Reintentos automáticos con backoff.
- Prioridad de jobs.
- Dead letter queue para fallos.
- Múltiples workers consumiendo la misma cola.

### ¿Cuándo NO usar Redis?

Si el objetivo es seguir en una sola VPS sin instalar nada nuevo, la Opción B (SQLite + eventos) da el 80% del beneficio:

- Jobs persistentes en SQLite.
- Worker en proceso aparte (spawn).
- Sin instalar Redis.

---

## API mínima para la cola

```ts
interface RenderJob {
  id: string;
  type: 'render-stock' | 'render-game' | 'render-preview';
  payload: {
    slpPath: string;
    selectedStocks: SelectedStock[];
    options: ProcessOptions;
  };
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: JobProgress | null;
  retries: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}
```

Endpoints:

- `POST /api/queue/render` — encolar render.
- `GET /api/queue/jobs/:id` — estado de un job.
- `POST /api/queue/jobs/:id/cancel` — cancelar job pendiente o en curso.
- `GET /api/queue/jobs` — listar jobs recientes.

---

## Próximos pasos recomendados

1. Implementar `worker-server.js` con cola en SQLite (Opción B) para no depender de Redis todavía.
2. Migrar `/api/process-stocks` para que solo encole en vez de renderizar en el mismo proceso.
3. Agregar reintentos y dead-letter jobs.
4. Logging estructurado (JSON) para cada job.
5. Luego, si se escala, migrar la cola a BullMQ + Redis.
