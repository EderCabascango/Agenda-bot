# 📜 Biblia de Lineamientos y Hoja de Ruta Oficial: Mi Diario

**Proyecto:** Mi Diario – Agenda Inteligente  
**Fecha de actualización:** 16 de Octubre, 2026  
**Estado del Sistema:** Desarrollo Congelado para Auditoría • 107 registros resguardados • 100% Pruebas Pasadas (`npm test`)

---

## 🎯 1. Propósito Principal y Biblia de Lineamientos

La aplicación **Mi Diario** es una agenda personal e inteligente orientada a la organización del tiempo, hábitos diarios y seguimiento de sesiones de enfoque de estudio.

### 🛡️ Reglas Inquebrantables de Desarrollo

1. **Cero Pérdida de Datos**: Todos los cambios en la base de datos `agenda.db` deben ser atómicos, con soporte de tombstones y sincronización offline.
2. **Verificación Verde Obligatoria**: Jamás se dará por completada una tarea sin ejecutar `npm test` y verificar el paso al 100% de la suite de pruebas.
3. **Cero Invención de Funcionalidades No Solicitadas**: Ningún botón, módulo o sección se agregará o eliminará sin consentimiento explícito.
4. **Respeto a las Directivas del Usuario**: Prioridad absoluta a las solicitudes explícitas del usuario.

---

## 🛠️ 2. Estado de lo Construido (Fases Completadas)

- **Fase 1**: Sincronización multi-colección, resolución de conflictos por Rebase y tombstones.
- **Fase B**: Gestión de materias y subtemas en la sección Estudio.
- **Fase C**: Temporizador de enfoque con 8 métodos, candado multi-pestaña y recuperación tras F5.
- **Fase D**: Estadísticas y métricas (racha, meta diaria, matriz día × hora).
- **Fase E**: Notas de aprendizaje post-sesión, exportación Markdown y tareas de repaso.
- **Rediseño Visual Taskly**: aprobado por el usuario el 16-10-2026 (paleta negro, blanco y amarillo ámbar).
- **Módulo de Ejercicio (calistenia)** (19-10-2026, a petición del usuario): rutinas reutilizables, registro de entrenos (series × reps, isométricos en segundos y lastre), "la última vez", récords y 1RM estimado, gráfica semanal, resumen y racha; marca la fila "Ejercicio" de la matriz y se puede entrenar desde una actividad de la agenda. Sincronizado entre PC y teléfono.
- **Entreno guiado y plan semanal** (19-10-2026): rutinas por segmentos (rango de reps + descanso por ejercicio), modo guiado con descansos cronometrados que pitan, vibran y esperan a "Siguiente", isométricos con cuenta atrás, cardio (caminar/correr) con minutos y km, días por rutina con tarjeta "Hoy toca" y plan sugerido (A · Full body, Caminar, B · Circuito, Correr suave, C · Pierna y core).
- **Apuntes** (19-10-2026): notas con título, texto, lista de tareas, etiquetas, fijar y día; búsqueda sin tildes; apuntes del día en el calendario y enlace desde la Agenda de Hoy. Sincronizado entre PC y teléfono.
- **Login y Perfil** (adelantado desde Seguridad): inicio de sesión con correo y contraseña para un único dueño, sesión JWT y perfil editable.

---

## 📋 3. Orden Aprobado de Desarrollo

El desarrollo seguirá **únicamente** el siguiente orden secuencial:

1. **Correcciones Pendientes de Capturas**:
   - Meta semanal por materia usando minutos de la semana en curso (no total histórico).
   - Eliminación de "Materia Desconocida" y ajuste de comparaciones de delta.
   - Barras de 7/30 días, mapa de calor del ciclo, editar sesión, línea Hoy en timeline.
   - Botón de enfoque configurable por tarea (`allow_focus` booleano explícito por defecto activado con regla de sugerencia por etiquetas).
   - ~~Restauración de tarjeta resumen de "Mis Materias" en el Dashboard.~~ Revertido el 16-10-2026 a petición del usuario: las materias **no** aparecen en la pantalla de inicio, solo en Estudio.
2. **Fase E (Notas de Aprendizaje)**:
   - Ajuste completo del modal post-sesión de enfoque (inclusión de ratings 1-5 de comprensión y concentración en el temporizador).
3. **Rediseño Visual** ✅:
   - Aprobada la línea **Taskly** (`design/mockup.html`): negro, blanco y amarillo ámbar. Sustituye a la referencia crema/negro/pastel.
   - Pendiente menor: llevar a la paleta los elementos que se salen (aviso rojo de vencidas, check verde, degradado verde del asistente) y corregir en móvil los botones flotantes superpuestos y el borde de la barra lateral.
4. **Fase F (Extras)** ✅ (17-10-2026):
   - Sonidos ambientales generados con WebAudio (ruido blanco, rosa, marrón y lluvia), sin archivos ni internet; suenan solo mientras corre el enfoque.
   - Modo no molestar: durante el enfoque las alarmas se guardan en silencio y se entregan al terminar (activable en Ajustes).
   - Repaso espaciado automático: al guardar una nota se crean repasos a 1, 3, 7 y 21 días (activable en Ajustes).
5. **Seguridad (Antes de Desplegar)** — adelantada parcialmente a petición del usuario:
   - ✅ Autenticación que falla cerrado: `POST /auth/login` con correo (`OWNER_EMAIL`) y contraseña (hash scrypt, fijada con `python set_password.py`) → el backend emite su propio JWT (30 días). Sin `JWT_SECRET`, `OWNER_EMAIL` o contraseña fijada, la API no se abre. El login con Google se descartó el 16-10-2026 a petición del usuario.
   - ✅ Rate limit en el login (10 intentos/minuto por IP) y CORS sin comodín.
   - ✅ Perfil (nombre, apellido, rol, foto) en `GET/PUT /profile`, "Cambiar contraseña" (cierra las sesiones de otros dispositivos) y "Cerrar sesión".
   - ✅ Confirmaciones de acciones críticas con un aviso propio: borrar notas, temas, materias, sesiones, descartar enfoque, restaurar respaldo, cargar rutina e importar reemplazando. "Borrar todas las actividades" borra en todos los dispositivos, exige escribir BORRAR y descarga antes un respaldo JSON.

---

## ⛔ 4. Ideas Futuras, No Aprobadas (Bloqueadas)

Las siguientes funcionalidades quedan **completamente congeladas y bloqueadas** hasta su aprobación explícita (la autenticación que falla cerrado ya existe desde el 16-10-2026):

- **Fase G (Segundo Cerebro)**:
  - Notas con Wikilinks (`[[Tema]]`).
  - Grafo de Conocimiento visual interconectado.
  - Detector de brechas tecnológicas.
- **Fase H (Asistente de Voz & Conectores Ejecutivos)**:
  - Entrada e instrucciones por voz (Web Speech / Whisper STT).
  - Integración con Gmail (redacción de borradores pre-aprobados).
  - Sincronización bidireccional con Google Calendar.
