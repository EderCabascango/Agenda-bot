# 📜 Biblia de Lineamientos y Hoja de Ruta Oficial: Mi Diario

**Proyecto:** Mi Diario – Agenda Inteligente  
**Fecha de actualización:** 9 de Octubre, 2026  
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

---

## 📋 3. Orden Aprobado de Desarrollo

El desarrollo seguirá **únicamente** el siguiente orden secuencial:

1. **Correcciones Pendientes de Capturas**:
   - Meta semanal por materia usando minutos de la semana en curso (no total histórico).
   - Eliminación de "Materia Desconocida" y ajuste de comparaciones de delta.
   - Barras de 7/30 días, mapa de calor del ciclo, editar sesión, línea Hoy en timeline.
   - Botón de enfoque configurable por tarea (`allow_focus` booleano explícito por defecto activado con regla de sugerencia por etiquetas).
   - Restauración de tarjeta resumen de "Mis Materias" en el Dashboard.
2. **Fase E (Notas de Aprendizaje)**:
   - Ajuste completo del modal post-sesión de enfoque (inclusión de ratings 1-5 de comprensión y concentración en el temporizador).
3. **Rediseño Visual**:
   - Aprobación previa de maquetas basadas en la referencia crema/negro/pastel enviada por el usuario.
4. **Fase F (Extras)**:
   - Sonidos ambientales, modo no molestar, algoritmo de repaso espaciado (1, 3, 7, 21 días).
5. **Seguridad (Antes de Desplegar)**:
   - Autenticación que falla cerrado, rate limit, tokens JWT y confirmaciones de acciones críticas.

---

## ⛔ 4. Ideas Futuras, No Aprobadas (Bloqueadas)

Las siguientes funcionalidades quedan **completamente congeladas y bloqueadas** hasta que exista autenticación que falla cerrado y aprobación explícita:

- **Fase G (Segundo Cerebro)**:
  - Notas con Wikilinks (`[[Tema]]`).
  - Grafo de Conocimiento visual interconectado.
  - Detector de brechas tecnológicas.
- **Fase H (Asistente de Voz & Conectores Ejecutivos)**:
  - Entrada e instrucciones por voz (Web Speech / Whisper STT).
  - Integración con Gmail (redacción de borradores pre-aprobados).
  - Sincronización bidireccional con Google Calendar.
