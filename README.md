# Cobertura Clara · asistente Vielsin

**Vielsin es un asistente conversacional que estima el copago del paciente y le recomienda el hospital de su red más conveniente, antes de atenderse.**

El paciente describe su síntoma en lenguaje natural. Vielsin sugiere la especialidad médica y, cruzando los datos con su plan de seguro, calcula al instante:

- **Cuánto pagaría de su bolsillo** (copago) por la consulta, con desglose transparente.
- **Qué hospital de su red le conviene más**, ordenado por el **Índice CLARO** (nota de 0 a 10).
- **Qué porcentaje cubre su seguro** de esa atención.
- **Cómo llegar** (ruta en Google Maps) y **cómo solicitar la cita**.

---

## ✨ Demo

- **App en vivo:** _(pega aquí la URL pública tras el despliegue)_
- Escribe un síntoma (ej. *"me duele el pecho al respirar"*), elige un plan y conversa con Vielsin.

Funciona en **PC y móvil** (responsive). En el móvil, la ubicación es más precisa y los botones "Llamar" y "Cómo llegar" abren las apps nativas.

---

## 🧠 El Índice CLARO (nuestro diferenciador)

En vez de un simple precio, cada hospital recibe una **nota de 0 a 10** que combina cinco factores:

| Factor | Qué mide | Peso |
|---|---|---|
| **C**osto | lo que pagas de tu bolsillo | 40% |
| **A**tención | calidad del hospital (estrellas) | 25% |
| **O**portunidad | cuánto te cubre tu seguro | 15% |
| **R**apidez | días de espera para la cita | 10% |
| **L**ejanía | distancia hasta el hospital | 10% |

El ranking se ordena por esta nota, no solo por precio. Si el paciente comparte su ubicación, la distancia es **real** (fórmula de Haversine) y el ranking se **personaliza** según dónde está.

---

## 🤖 Arquitectura agéntica

Vielsin no es un chatbot pasivo: es un **agente** que razona sobre un objetivo, mantiene memoria, **decide qué herramienta usar** y actúa. El LLM nunca inventa cifras; delega el cálculo a herramientas deterministas.

```
                 Paciente (texto o voz, tolera faltas de ortografía)
                                  │
                                  ▼
        ┌──────────────────────────────────────────────┐
        │   AGENTE VIELSIN  (POST /api/agente)           │
        │   • Memoria de conversación (plan, síntoma)    │
        │   • Razona y ELIGE una herramienta:            │
        └──────────────────────────────────────────────┘
                                  │
        ┌──────────────┬──────────────────┬──────────────────┐
        ▼              ▼                  ▼                  ▼
   pedir_dato    estimar_copago    comparar_planes      responder
  (falta info)   │                  │                 (saludo/duda)
                 ▼                  ▼
        ┌─────────────────────────────────────┐
        │  HERRAMIENTA: motor determinista     │
        │  copago · Índice CLARO · ranking ·   │
        │  geolocalización · comparador        │
        └─────────────────────────────────────┘
                                  │
                                  ▼
     Respuesta empática + tarjetas + acciones (llamar / cómo llegar / cita)
```

**Cerebro del agente — cascada de proveedores (resiliente):**

```
LLM primario (Groq, rápido)  →  secundario (Cerebras)  →  respaldo (endpoint propio)  →  reglas locales
```

Si un proveedor falla o tarda, pasa al siguiente automáticamente. Si todos fallan, un **motor de reglas local** (con base de conocimiento de afecciones y tolerancia a errores de tipeo) mantiene el agente funcionando. **Nunca se cae.**

## 🚦 Flujo resumido

```
Síntoma → el agente deduce especialidad y decide herramienta
        → ejecuta el cálculo (copago + CLARO + ranking)
        → responde con empatía + acciones
```

Características:

- **Conversación real con memoria:** Vielsin recuerda el síntoma y el plan, pregunta lo que falta y recalcula ante preguntas de seguimiento ("¿y en Plan Premium?").
- **Resumen CLARO informativo:** presenta 3 rutas (precio / atención / balance) con lenguaje sugerente. La decisión es del paciente, nunca impositiva.
- **Comparador de planes:** muestra cuánto pagarías con cada plan (upsell responsable).
- **Geolocalización opt-in:** ordena por cercanía real. La ubicación se usa solo en el dispositivo, no se guarda.
- **Banner de emergencia:** ante síntomas graves, prioriza acudir a urgencias / llamar al 911.
- **Robusto:** si no hay IA configurada, funciona en modo reglas. Nunca se cae.

---

## 🚀 Ejecutar en local

Requisitos: Node.js 18+.

```bash
git clone <este-repo>
cd cobertura-clara
npm install
cp .env.example .env    # edita .env con tu proveedor de IA (opcional)
npm start
```

Abre `http://localhost:4700`.

### Variables de entorno

El cerebro del agente usa una **cascada de proveedores** (todos compatibles con la API de OpenAI). Se intentan en orden; el primero que responda gana. Todos son opcionales: sin ninguno, el agente funciona en modo reglas.

| Variable | Descripción | Ejemplo |
|---|---|---|
| `PORT` | Puerto del servidor | `4700` |
| `GROQ_API_KEY` | Proveedor primario (rápido) | `gsk_...` |
| `GROQ_MODEL` | Modelo del primario | `openai/gpt-oss-120b` |
| `CEREBRAS_API_KEY` | Proveedor secundario | `csk-...` |
| `CEREBRAS_MODEL` | Modelo del secundario | `gpt-oss-120b` |
| `AI_BASE_URL` | Endpoint de respaldo (OpenAI-compatible) | `https://.../v1` |
| `AI_API_KEY` | Clave del respaldo | `sk-...` |
| `AI_MODEL` | Modelo del respaldo | `gpt-4o-mini` |
| `AI_TIMEOUT_MS` | Timeout por proveedor antes de pasar al siguiente | `9000` |

Como todo se consume vía el estándar `POST /v1/chat/completions`, funciona con **cualquier proveedor OpenAI-compatible**.

---

## 🌐 API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | Estado del servicio y si la IA está habilitada |
| `GET` | `/api/meta` | Planes y especialidades disponibles |
| `POST` | `/api/agente` | Turno conversacional: `{ messages, estado, ubicacion }` |
| `POST` | `/api/estimate` | Estimación directa: `{ especialidadId, planId, ubicacion }` |

---

## 🗂️ Estructura

```
cobertura-clara/
├── data/                 # Datos de ejemplo (planes, hospitales, especialidades)
├── lib/
│   ├── estimator.js      # Motor: triaje, copago, Índice CLARO, ranking, comparador
│   └── ai.js             # Vielsin: agente IA OpenAI-compatible con fallback
├── public/               # Frontend (HTML + Tailwind + JS, sin build)
├── server.js             # Servidor Express (API + estáticos)
└── package.json
```

---

## ⚠️ Aviso

Herramienta de **orientación informativa** con datos de ejemplo ficticios (incluidos nombres, teléfonos, webs y ubicaciones de hospitales). No sustituye el criterio de un profesional de la salud, ni la póliza oficial del asegurador, ni constituye una autorización de cobertura. La cita la confirma el hospital.

## Licencia

MIT
