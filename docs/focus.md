# Módulo de Enfoque y Estudio ("Mi Diario")

Este documento detalla la arquitectura, modelo de datos, algoritmos de cálculo de estadísticas y políticas del temporizador y la sincronización offline-first del módulo de Estudio y Enfoque.

---

## 1. Modelo de Datos y Colecciones

El sistema gestiona 5 colecciones sincronizables:
1. `activities`: Actividades de la agenda diaria.
2. `subjects`: Materias o proyectos de estudio (`name`, `color`, `icon`, `weekly_goal_minutes`, `archived`, `created_at`, `updated_at`, `deleted_at`, `version`).
3. `topics`: Subtemas asociados a una materia (`subject_id`, `name`, `status` ∈ `{'pending', 'in_progress', 'mastered'}`, `created_at`, `updated_at`, `deleted_at`, `version`).
4. `focus_sessions`: Sesiones de enfoque registradas mediante temporizador o entrada manual (`subject_id`, `topic_ids`, `activity_id`, `method`, `goal`, `started_at`, `ended_at`, `focus_intervals`, `effective_seconds`, `break_seconds`, `cycles_completed`, `distractions_count`, `status` ∈ `{'completed', 'abandoned'}`, `source` ∈ `{'timer', 'manual'}`, `iana_timezone`, `created_at`, `updated_at`, `deleted_at`, `version`).
5. `learning_notes`: Notas de aprendizaje vinculadas a sesiones o actividades (`session_id`, `activity_id`, `subject_id`, `topic_ids`, `learned_text`, `questions_text`, `resources_text`, `next_step_text`, `comprehension_level` (1-5), `focus_level` (1-5), `conflict_of`, `created_at`, `updated_at`, `deleted_at`, `version`).

### Invariantes de Sincronización y Validación:
- **Tombstones (`deleted_at`)**: Borrado lógico estricto. Registros con `deleted_at` no son resucitados por `create_if_absent` y son excluidos de vistas, contadores y métricas.
- **`created_at`**: Asignado en la creación original. En bases de datos existentes, la migración automática lo puebla con `updated_at`.
- **`iana_timezone`**: Validado contra el registro IANA oficial del sistema (`zoneinfo`).
- **Límites de Seguridad**: `topic_ids` ≤ 50 temas por sesión; `focus_intervals` ≤ 500 tramos por sesión.
- **Tolerancia a Huérfanos**: Sesiones sin materia o notas sin sesión se procesan limpiamente sin excepciones de UI ni bloqueos de sincronización.

---

## 2. Métodos de Enfoque y Reglas del Temporizador (`timer-core.js`)

| Método | Enfoque (min) | Descanso Corto | Descanso Largo | Ciclos p/ Descanso Largo | Tipo | Permite Pausa |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Pomodoro Clásico** | 25 min | 5 min | 15 min | 4 | Cuenta regresiva | Sí |
| **Pomodoro 50/10** | 50 min | 10 min | 20 min | 3 | Cuenta regresiva | Sí |
| **Regla 52/17** | 52 min | 17 min | 17 min | 3 | Cuenta regresiva | Sí |
| **Ritmo Ultradiano** | 90 min | 20 min | 30 min | 2 | Cuenta regresiva | Sí |
| **Flowtime** | Libre | Proporcional | Proporcional | 1 | Cronómetro ascendente | Sí |
| **Deep Work** | 120 min | Sin descansos | - | 1 | Bloque continuo | No (sin pausa) |
| **Cronómetro Libre**| Libre | - | - | 1 | Cronómetro ascendente | Sí |
| **Personalizado** | 1 a 360 min | Configurable | Configurable | Configurable | Cuenta regresiva | Sí |

### Política de Ausencias y Huecos de Tiempo (Gaps):
1. **Latido Vivo (<= 2 min)**: El temporizador avanza fluidamente y completa transiciones de fase sin interrupción.
2. **Ausencia > 2 min en Cuenta Regresiva**: Pasa a estado `waiting` limitando los segundos acumulados a la duración nominal de la fase expirada.
3. **Ausencia en Flowtime**:
   - Entre 2 min y 30 min: Se presume concentración activa y se conserva el tiempo.
   - Mayor a 30 min: Pasa a `waiting` solicitando al usuario confirmación de la hora real en que se detuvo.

---

## 3. Motor de Estadísticas (`stats-core.js`)

Módulo puro UMD con reloj inyectable y soporte nativo de zonas horarias IANA.

### Algoritmos Principales:
1. **`splitSessionByLocalDate`**: Divide tramos de enfoque que cruzan la medianoche o transiciones DST (días de 23h o 25h) asignando los segundos a la fecha local correspondiente (`YYYY-MM-DD`).
2. **Totales por Periodo**:
   - **Hoy**: Segundos acumulados en la fecha local en curso.
   - **Semana**: Lunes a Domingo de la semana actual.
   - **Ciclo de Estudio (15->14)**: Ventana mensual que abarca desde el día 15 del mes M hasta el día 14 del mes M+1.
3. **Medias Diarias (7d, 30d, Global)**:
   - Variante A: Promedio sobre todos los días naturales del periodo.
   - Variante B: Promedio calculado exclusivamente sobre días con tiempo de estudio (>0 min).
4. **Comparativa vs 7 Días Anteriores**:
   - Compara el total de Hoy frente a la media de los 7 días inmediatamente precedentes ($t-7$ a $t-1$), indicando delta neto y porcentaje.
5. **Racha de Estudio**:
   - Umbral configurable (por defecto 15 minutos diarios).
   - Racha viva: Si hoy aún no se alcanza el umbral pero ayer sí, la racha permanece viva en estado "Pendiente hoy".
   - Récord histórico: Máxima secuencia consecutiva histórica de días que cumplieron el umbral.
6. **Matriz Heatmap Semanal (7 días × 24 horas)**:
   - Distribución horaria local en formato matricial rendered en SVG accesible.
   - Detección de la mejor franja horaria (bloque de 2 horas con mayor concentración de estudio).
7. **Distribución por Materia**:
   - Minutos, horas y porcentaje relativo por materia con reparto equitativo entre subtemas cuando aplica.
