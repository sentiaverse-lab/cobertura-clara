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

## 🚦 Cómo funciona

```
Paciente describe su síntoma
        │
        ▼
[ /api/agente ] ── Vielsin (IA OpenAI-compatible) interpreta y conversa
        │            └─ Fallback por reglas si la IA no está disponible
        ▼
Especialidad + urgencia (+ banner de emergencia si es grave)
        │
        ▼
[ motor determinístico ] ── copago + Índice CLARO + ranking + comparador de planes
        │
        ▼
Vielsin: copago, hospital recomendado, resumen CLARO, acciones (llamar / cómo llegar / cita)
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

| Variable | Descripción | Ejemplo |
|---|---|---|
| `PORT` | Puerto del servidor | `4700` |
| `AI_BASE_URL` | Endpoint del proveedor de IA (compatible con OpenAI) | `https://api.openai.com/v1` |
| `AI_API_KEY` | Clave del proveedor de IA | `sk-...` |
| `AI_MODEL` | Modelo a usar | `gpt-4o-mini` |

El cliente de IA usa el estándar `POST /v1/chat/completions`, por lo que funciona con **cualquier proveedor OpenAI-compatible**.

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
