# Módulo de Enfoque y Estudio ("Mi Diario")

Este documento detalla la arquitectura, modelo de datos, algoritmos de cálculo de estadísticas, políticas del temporizador y sincronización offline-first del módulo de Estudio y Enfoque de la aplicación.

---

## 1. Modelo de Datos y Colecciones

El sistema gestiona 5 colecciones sincronizables mediante SQLite en el backend y `localStorage` en el cliente:
1. `activities`: Actividades de la agenda diaria (`id`, `title`, `date`, `startTime`, `endTime`, `description`, `priority`, `tags`, `completed`, `alarm`, `version`, `created_at`, `updated_at`, `deleted_at`).
2. `subjects`: Materias o proyectos de estudio (`id`, `name`, `color`, `icon`, `weekly_goal_minutes`, `archived`, `created_at`, `updated_at`, `deleted_at`, `version`).
3. `topics`: Subtemas asociados a una materia (`id`, `subject_id`, `name`, `status` ∈ `{'pending', 'in_progress', 'mastered'}`, `created_at`, `updated_at`, `deleted_at`, `version`).
4. `focus_sessions`: Sesiones de enfoque registradas mediante temporizador o entrada manual (`id`, `subject_id`, `topic_ids`, `activity_id`, `method`, `goal`, `started_at`, `ended_at`, `focus_intervals`, `effective_seconds`, `break_seconds`, `cycles_completed`, `distractions_count`, `status` ∈ `{'completed', 'abandoned'}`, `source` ∈ `{'timer', 'manual'}`, `iana_timezone`, `created_at`, `updated_at`, `deleted_at`, `version`).
5. `learning_notes`: Notas de aprendizaje vinculadas a sesiones o actividades (`id`, `session_id`, `activity_id`, `subject_id`, `topic_ids`, `learned_text`, `questions_text`, `resources_text`, `next_step_text`, `comprehension_level` (1-5), `focus_level` (1-5), `conflict_of`, `created_at`, `updated_at`, `deleted_at`, `version`).

### Invariantes de Sincronización y Validación:
- **Tombstones (`deleted_at`)**: Borrado lógico estricto. Registros con `deleted_at` no son resucitados por inserciones tardías (`create_if_absent`) y son excluidos de vistas activas, contadores y métricas agregadas.
- **`created_at`**: Asignado en la creación original (ISO 8601 UTC). En bases de datos migradas desde versiones previas, se rellena de forma retroactiva con `updated_at`.
- **`iana_timezone`**: Validado contra el catálogo oficial IANA del sistema (`zoneinfo`). Las sesiones que cruzan la medianoche o cambios de horario (DST) se dividen con precisión según la zona horaria local del usuario.
- **Límites de Seguridad y Validación**:
  - `topic_ids` ≤ 50 IDs por sesión.
  - `focus_intervals` ≤ 500 intervalos por sesión.
  - Subtemas huérfanos o sesiones sin materia (`subject_id` nulo o apuntando a registros eliminados) se agrupan ordenadamente como `"Sin materia"` sin provocar excepciones ni romper la sincronización.

---

## 2. Claves de Almacenamiento Local (`localStorage`)

El cliente almacena su estado en las siguientes claves:

| Clave | Descripción |
| :--- | :--- |
| `agenda_activities` | Lista JSON de actividades de la agenda. |
| `agenda_subjects` | Lista JSON de materias de estudio. |
| `agenda_topics` | Lista JSON de temas y subtemas. |
| `agenda_focus_sessions` | Lista JSON de sesiones de enfoque concluidas o manuales. |
| `agenda_learning_notes` | Lista JSON de notas de aprendizaje asociadas. |
| `agenda_sync_queue` | Cola de mutaciones pendientes de envío al backend. |
| `agenda_sync_meta` | Metadatos de sincronización (última marca de tiempo UTC del servidor). |
| `agenda_active_focus_session` | Estado serializado de la sesión de enfoque activa para sincronización multiventana. |
| `agenda_settings` | Preferencias generales del usuario (nombre, temas, notificaciones). |

---

## 3. Métodos de Enfoque y Reglas del Temporizador (`timer-core.js`)

El módulo soporta 8 configuraciones de temporizador con reglas adaptadas a cada metodología:

| Método | Clave | Enfoque Nominal | Descanso Corto | Descanso Largo | Intervalo Descanso Largo | Tipo de Reloj | Permite Pausa |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Pomodoro Clásico** | `pomodoro` | 25 min (1500s) | 5 min (300s) | 15 min (900s) | Cada 4 ciclos | Cuenta regresiva | Sí |
| **Pomodoro 50/10** | `50_10` | 50 min (3000s) | 10 min (600s) | 20 min (1200s) | Cada 3 ciclos | Cuenta regresiva | Sí |
| **Regla 52/17** | `52_17` | 52 min (3120s) | 17 min (1020s) | 17 min (1020s) | Cada 3 ciclos | Cuenta regresiva | Sí |
| **Ritmo Ultradiano** | `ultradian` | 90 min (5400s) | 20 min (1200s) | 30 min (1800s) | Cada 2 ciclos | Cuenta regresiva | Sí |
| **Flowtime** | `flowtime` | Libre (ascendente) | Dinámico | Dinámico | 1 ciclo | Cronómetro ascendente | Sí |
| **Deep Work** | `deep_work` | 90–120 min | Sin descansos | — | 1 ciclo | Cuenta regresiva | No (bloque continuo) |
| **Cronómetro Libre**| `stopwatch` | Libre (ascendente) | — | — | 1 ciclo | Cronómetro ascendente | Sí |
| **Personalizado** | `custom` | 1 a 360 min | Configurable | Configurable | Configurable | Cuenta regresiva | Sí |

### Reglas Dinámicas de Descanso en Flowtime:
En la metodología Flowtime, la duración del descanso sugerido se calcula a partir del tiempo continuo trabajado:

| Minutos de Enfoque Continuo | Descanso Sugerido |
| :--- | :--- |
| Menos de 25 min | 5 min |
| De 25 a 50 min | 8 min |
| De 50 a 90 min | 10 min |
| Más de 90 min | 15 min |

---

## 4. Política de Ausencias y Detección de Inactividad (Gaps)

Para evitar que el usuario acredite tiempo no trabajado si cierra la pestaña, apaga la pantalla o suspende el equipo, se aplican las siguientes reglas:

1. **Latido Normal ($\le 2$ min)**: La sesión continúa normalmente sin interrupciones ni cuadros de diálogo.
2. **Métodos de Cuenta Regresiva (Pomodoro, 50/10, 52/17, Ultradiano, Personalizado)**:
   - Si la aplicación se reactiva tras un corte prolongado superior a la duración restante de la fase, el tiempo acreditado queda estrictamente limitado al tope nominal de la fase expirada (no se acreditan minutos adicionales posteriores).
   - El estado pasa a `waiting` para que el usuario inicie la siguiente fase conscientemente.
3. **Métodos Abiertos / Sin Límite (Cronómetro, Deep Work, Personalizado Ascendente)**:
   - Ausencias superiores a 30 minutos sin interacción se marcan como `absence_detected`.
   - Queda terminantemente prohibido acreditar tiempo de forma automática y silenciosa.
   - El usuario debe confirmar la hora real en que se detuvo o descartar el tramo no supervisado.
4. **Flowtime**:
   - Brecha entre 5 y 30 minutos: Se presenta un diálogo modal con 3 opciones claras:
     1. *Conservar todo*: Acredita el intervalo completo si continuó enfocado.
     2. *Ajustar corte*: Recorta el fin de la sesión al último momento de presencia confirmada.
     3. *Descartar brecha*: Excluye el tiempo inactivo.
   - Brecha superior a 30 minutos: Pasa automáticamente a resolución forzada de ausencia sin acreditación automática.

---

## 5. Limitaciones del Entorno Web y Mitigaciones

1. **Throttling de temporizadores en segundo plano**:
   - Los navegadores modernos ralentizan `setInterval` y `setTimeout` a 1 tick por segundo o 1 por minuto en pestañas inactivas.
   - **Mitigación**: El cálculo de tiempo no depende de contar ticks. Se calcula la diferencia de marcas de tiempo absolutas (`Date.now() - interval.started_at`) basada en el reloj del sistema.
2. **Políticas de Autoplay de Audio**:
   - Los navegadores bloquean la reproducción de sonidos de campana si no hubo interacción previa del usuario en la pestaña.
   - **Mitigación**: Inicialización y desbloqueo del `AudioContext` o elemento de audio en el primer clic del usuario al iniciar o reanudar el temporizador.
3. **Permisos de Notificaciones Web (`Notification API`)**:
   - Solicitud explícita de permisos al iniciar la primera sesión para emitir alertas cuando finaliza una fase.
4. **Pantalla Activa (`Screen Wake Lock API`)**:
   - Mientras el temporizador esté en estado `running`, se adquiere un `wakeLock` del navegador (cuando esté disponible) para evitar que el dispositivo bloquee la pantalla o suspenda los procesos.
5. **Concurrencia Multi-Pestaña**:
   - Se utiliza un `tabId` único generado al arranque de la ventana y eventos de `storage` para coordinar el temporizador activo, impidiendo que múltiples pestañas avancen contadores duplicados.

---

## 6. Motor de Estadísticas (`stats-core.js`)

Módulo puro UMD con reloj inyectable y soporte completo de zonas horarias IANA.

### Algoritmos Principales:
1. **`splitSessionByLocalDate`**:
   - Divide tramos de enfoque que cruzan la medianoche o transiciones de horario de verano/invierno (DST), asignando los segundos de estudio a cada día local exacto (`YYYY-MM-DD`).
2. **Ventanas Móviles (7 días y 30 días)**:
   - **Ventana de 7 días**: Abarca exactamente 7 días naturales incluyendo el día de hoy (`[hoy - 6, hoy]`).
   - **Ventana de 30 días**: Abarca exactamente 30 días naturales incluyendo el día de hoy (`[hoy - 29, hoy]`).
   - Ambas series exponen datos formateados para gráficos de barras SVG/CSS con una tabla accesible oculta (`<table class="sr-only">`).
3. **Comparativa "Hoy vs Promedio"**:
   - Compara el tiempo acumulado en el día de hoy frente a la media diaria de los 7 días anteriores inmediatos (`[hoy - 7, hoy - 1]`).
   - Muestra el delta neto absoluto en minutos (ej. `"+45 min sobre tu promedio de 7 días"`).
   - Si hoy no hay sesiones registradas y el día no ha terminado, se muestra un mensaje neutro (`"Aún sin sesiones hoy"`) sin indicadores de alerta ni color rojo.
   - Si la media previa es inferior a 15 minutos, no se muestra comparativa para evitar deltas engañosos.
4. **Ciclo de Estudio (15->14)**:
   - Ventana mensual fija que va desde el día 15 del mes actual hasta el día 14 del mes siguiente.
   - Incluye mapa de calor de intensidad diaria y conteos consolidados.
5. **Racha de Estudio (Streaks)**:
   - **Umbral por defecto**: 10 minutos de estudio diario (configurable vía `minMinutesPerDay = 10`).
   - **Racha Activa**: Si hoy todavía no se alcanza el umbral pero ayer se cumplió, la racha se mantiene viva en estado pendiente.
   - **Récord Histórico**: Máxima secuencia ininterrumpida de días que alcanzaron el umbral.
6. **Distribución por Materia y Huérfanos**:
   - Agrupa todas las sesiones con `subject_id` nulo, vacío o correspondiente a materias eliminadas bajo una única categoría unificada `"Sin materia"`.
   - Calcula el progreso de metas semanales de materias considerando exclusivamente los minutos de la semana en curso (Lunes a Domingo local).
