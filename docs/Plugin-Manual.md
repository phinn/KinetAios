# KinetAios Plugin Manual

> **Version**: v0.1 · **Target**: KinetAiosWin v1.4.0+  
> **Updated**: 2025-07-16

---

## Table of Contents

- [1. Plugin System Overview](#1-plugin-system-overview)
- [2. Plugin Quick Reference](#2-plugin-quick-reference)
- [3. low-altitude (Low-Altitude Economy Plugin)](#3-low-altitude-low-altitude-economy-plugin)
  - [3.1 Tool Reference](#31-tool-reference)
  - [3.2 Slash Commands](#32-slash-commands)
  - [3.3 Practical Examples](#33-practical-examples)
- [4. echo (Example Plugin)](#4-echo-example-plugin)
- [5. Plugin Management](#5-plugin-management)
- [6. Developing New Plugins](#6-developing-new-plugins)

---

## 1. Plugin System Overview

The KinetAios plugin system extends Agent capabilities through a **zero-intrusion core architecture**. Each plugin may include the following components:

| Component | Description | Required |
|-----------|-------------|----------|
| **Tools** | Functions that the Agent can proactively invoke | At least one |
| **Slash Commands** | Predefined workflows triggered by typing `/command` | Optional |
| **System Prompt** | Domain knowledge / behavioral guidance injected into the Direct engine | Optional |
| **Icon** | SVG icon displayed on the plugin card | Optional |

### Engine Compatibility

| Engine | Tool Invocation | Slash Commands | System Prompt |
|--------|----------------|----------------|---------------|
| **Direct (Kaios)** | ✅ Native support | ✅ | ✅ |
| **Claude Code** | ❌ | ❌ | ✅ (via `--append-system-prompt`) |
| **Codex** | ❌ | ❌ | ✅ (via prompt prefix) |

> ⚠️ Plugin tools are currently available **only** under the Direct engine. Switching to Claude Code / Codex disables plugin tool invocation.

### Plugin Load Paths

| Mode | Scan Path |
|------|-----------|
| **Dev mode** (`npm start`) | Project root `plugins/` + `<userData>/plugins/` |
| **Production** (packaged) | `<userData>/plugins/` |

---

## 2. Plugin Quick Reference

| Plugin | Version | Category | Tools | Commands | Engine |
|--------|---------|----------|-------|----------|--------|
| **low-altitude** | v0.1.0 | data | 4 | 3 | direct |
| **echo** | v1.0.0 | misc | 1 | 0 | direct |

---

## 3. low-altitude (Low-Altitude Economy Plugin)

**Domain**: Drone / eVTOL operations, low-altitude airspace management, flight mission planning  
**Permissions**: `shell` · `web_fetch` · `network`  
**Category**: data

### 3.1 Tool Reference

#### 🔧 `weather_brief` — Aviation Weather Briefing

Retrieves aviation weather data for a given coordinate, used for pre-flight weather assessment.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `lat` | number | ✅ | — | Latitude (-90 to 90) |
| `lon` | number | ✅ | — | Longitude (-180 to 180) |
| `hours` | number | ❌ | 12 | Forecast duration in hours (max 48) |

**Returns**: Wind speed, wind direction, visibility, precipitation probability, cloud base height, temperature

**Data Source**: Open-Meteo (free, no API key required). A custom data source can be configured via the `LOWALT_WEATHER_API` environment variable.

> 💡 **Natural language triggers**: "Check flight weather for Shenzhen today", "What's the weather at lat 22.5, lon 114.0?"

---

#### 🔧 `airspace_check` — Airspace / No-Fly Zone Lookup

Checks whether a given coordinate and altitude falls within a restricted zone, controlled airspace, or temporary no-fly area.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lat` | number | ✅ | Latitude (-90 to 90) |
| `lon` | number | ✅ | Longitude (-180 to 180) |
| `altitude` | number | ✅ | Planned flight altitude in meters AGL (Above Ground Level) |

**Returns**: Airspace type (G / W2 / C / D / Restricted), flight clearance recommendation (Permitted / Report / Apply / Prohibited)

> 💡 **Natural language triggers**: "Can I fly at 120m at this coordinate?", "Is 300m over Bao'an District controlled airspace?"

---

#### 🔧 `flight_plan` — Flight Route Planning

Accepts takeoff/landing points and waypoints, automatically calculates total distance, estimated flight time, and battery requirements.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `waypoints` | array\<object\> | ✅ | — | Waypoint list, minimum 2 points |
| ↳ `.lat` | number | ✅ | — | Latitude |
| ↳ `.lon` | number | ✅ | — | Longitude |
| ↳ `.name` | string | ❌ | — | Waypoint name (e.g. "Takeoff") |
| `droneType` | string | ❌ | `generic-multirotor` | Drone model |
| `cruiseSpeed` | number | ❌ | 15 | Cruise speed (m/s) |
| `batteryCapacity` | number | ❌ | 5000 | Battery capacity (mAh) |

**Returns**: Total distance (km), estimated flight time (min), per-segment details, battery consumption estimate, return margin

> 💡 **Natural language triggers**: "Plan a route from Shenzhen to Zhuhai", "Inspection route with 3 waypoints"

---

#### 🔧 `compliance_check` — Regulatory Compliance Check

Checks whether a flight scenario complies with regulations, based on CAAC (Civil Aviation Administration of China) CCAR-92 framework.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scenario` | string | ✅ | Flight scenario (see table below) |
| `droneCategory` | string | ✅ | Drone category (see table below) |
| `flightArea` | string | ✅ | Flight area type (see table below) |
| `altitude` | number | ❌ | Flight altitude in meters AGL |
| `bvlos` | boolean | ❌ | Beyond Visual Line of Sight, default `false` |

**`scenario` values**:

| Value | Meaning |
|-------|---------|
| `inspect` | Inspection (power lines, pipelines, bridges, etc.) |
| `logistics` | Logistics / cargo delivery |
| `photography` | Aerial photography |
| `agriculture` | Agricultural spraying |
| `mapping` | Surveying / mapping |
| `emergency` | Emergency rescue |

**`droneCategory` values**:

| Value | Meaning | Weight Range |
|-------|---------|--------------|
| `micro` | Micro | < 250g |
| `light` | Light | < 4kg |
| `small` | Small | 4 – 15kg |
| `medium` | Medium | 15 – 116kg |
| `large` | Large | > 116kg |
| `evtol` | Passenger eVTOL | eVTOL |

**`flightArea` values**:

| Value | Meaning |
|-------|---------|
| `uncontrolled` | Uncontrolled airspace (Class G) |
| `controlled` | Controlled airspace (Class C/D) |
| `airport` | Near airport |
| `urban` | Over urban area |
| `rural` | Suburban / rural area |
| `border` | Border region |

**Returns**: Compliance checklist (item-by-item ✅/⚠️/🔴), required procedures, overall assessment

> 💡 **Natural language triggers**: "Is light drone commercial photography in the city center compliant?", "What permits are needed for a crop-spraying drone at 50m in a rural area?"

---

### 3.2 Slash Commands

Type `/` in the chat box to trigger command autocomplete. Three commands cover the full flight mission workflow:

#### 📋 `/airspace-brief` — Airspace Situational Briefing

**Purpose**: Quickly understand the restricted status, regulatory requirements, and weather conditions of an area.

**Workflow**:
```
User provides coordinates / altitude / purpose
    ↓
Parallel calls: airspace_check + compliance_check + weather_brief
    ↓
Outputs duty-briefing format (airspace status + regulatory highlights + weather + recommendation)
```

**Example dialog**:
```
User: /airspace-brief
Agent: Please provide the following:
  1. Flight area coordinates (lat, lon)
  2. Planned flight altitude (m)
  3. Flight purpose (inspection / photography / logistics…)

User: 22.5, 114.0, altitude 100m, power line inspection
Agent: 📋 Airspace Duty Briefing
  ✅ Airspace type: Class G (uncontrolled)
  ✅ Regulation: Light inspection compliant, no filing required
  ⚠️ Weather: Wind 7m/s, approaching limit
  → Recommendation: Flight permitted, watch for gusts
```

---

#### 📋 `/plan-flight` — One-Click Flight Mission Planning

**Purpose**: Complete all pre-flight preparation in one workflow.

**Workflow**:
```
Collect parameters (waypoints / altitude / drone model / scenario)
    ↓
Parallel queries: weather_brief + airspace_check + compliance_check
    ↓
flight_plan calculates route
    ↓
Comprehensive assessment → generates Flight Mission Report
```

**Structured mission report includes**:
- Weather assessment
- Airspace status
- Compliance check results
- Route details (segments, distances, times)
- Battery assessment
- **Final verdict**: ✅ Recommended / ⚠️ Conditional / 🔴 Not recommended

---

#### 📋 `/inspect-report` — Inspection Report Generation

**Purpose**: Organize inspection data, identify defects, compare with history, and output a structured report.

**Workflow**:
```
Confirm inspection type / area / data source
    ↓
Read inspection logs / analyze photo data
    ↓
recall_memory searches historical records for comparison
    ↓
Generate structured inspection report → optionally export to file
```

**Report includes**:
- Inspection summary (time, area, equipment)
- Issue list (severity-graded)
- Historical comparison (trend analysis)
- Remediation recommendations

---

### 3.3 Practical Examples

#### Example 1: Quick Weather Check Before Routine Inspection

```
User: Check the flight weather for Shenzhen Nanshan, planning to fly for 2 hours
Agent: [auto-invokes weather_brief]
  📊 Aviation Weather Briefing — Shenzhen Nanshan (22.53, 113.93)
  ┌──────────────────────────────────────┐
  │ Wind: 4.2 m/s (SE)                    │
  │ Visibility: 12 km ✅                  │
  │ Precipitation prob.: 10% ✅           │
  │ Cloud base: 800m ✅                   │
  │ Temperature: 28°C                     │
  └──────────────────────────────────────┘
  ✅ Weather conditions suitable for flight
```

#### Example 2: Complex Route Planning

```
User: I need to plan an inspection route:
  Takeoff: Qianhai, Shenzhen (22.52, 113.89)
  Via: Shenzhen Bay Port (22.49, 113.93)
  Via: Science & Technology Park (22.54, 113.95)
  Landing: Qianhai (22.52, 113.89)
  Drone: Small quadcopter, speed 12m/s

Agent: [auto-invokes flight_plan + airspace_check + weather_brief]
  📐 Route Planning Report
  Total distance: 8.3 km
  Est. time: 11.5 min
  Battery consumption: 32% (5000mAh)
  Return margin: 68% ✅

  ⚠️ Restricted zone near Shenzhen Bay Port, segment altitude ≤ 120m recommended
```

#### Example 3: Compliance Consultation

```
User: Using a DJI Mavic 3 for commercial photography, 80m altitude downtown — what permits do I need?

Agent: [auto-invokes compliance_check]
  📋 Regulatory Compliance Check
  ┌──────────────────────────────────────────┐
  │ Drone category: Light (<4kg)             │
  │ Scenario: Commercial photography          │
  │ Area: Urban                               │
  │ Altitude: 80m (Class G)                   │
  ├──────────────────────────────────────────┤
  │ ✅ Operator cert: Light-class cert needed │
  │ ✅ Registration: Drone must be registered │
  │ ⚠️ Urban flight: Ground safety required   │
  │ ⚠️ Commercial: Liability insurance advised│
  │ ✅ Airspace: Class G, no filing needed    │
  └──────────────────────────────────────────┘
  Overall: Flight permitted, complete the above first
```

---

## 4. echo (Example Plugin)

**Purpose**: SDK verification / development template  
**Usage**: Copy this directory and modify to quickly build a new plugin

### Tool

#### 🔧 `echo_args` — Parameter Echo

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `payload` | string | ✅ | Any string, will be echoed as-is |

**Example**:
```
User: Use the echo tool to test "hello world"
Agent: [invokes echo_args]
  echo: {"payload":"hello world"}
```

### Development Reference

The minimal structure of the echo plugin — usable as a template:

```
plugins/
└── echo/
    ├── plugin.json    ← manifest declaration
    └── index.js       ← tool implementation
```

**Minimal plugin.json**:
```json
{
  "name": "echo",
  "version": "1.0.0",
  "description": "Example plugin",
  "tools": "index.js#tools"
}
```

**Minimal index.js**:
```javascript
module.exports.tools = [
  {
    name: 'echo_args',
    description: 'Echoes parameters as-is',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: 'string', description: 'Any string' }
      },
      required: ['payload']
    },
    run: async (args) => {
      return 'echo: ' + JSON.stringify(args);
    }
  }
];
```

---

## 5. Plugin Management

### 5.1 View Plugin List

1. Click **Settings** ⚙️ in the sidebar
2. Navigate to the **Plugins** tab
3. Top bar shows stats: total plugins · enabled · total tools · total commands
4. Filter by category and search by keyword

### 5.2 View Plugin Details

1. In the plugin list, **click the plugin card's name/description area**
2. A detail panel expands, showing:
   - 🔧 Tool list (name + description)
   - Slash command list (name + description)
   - Permission declarations
   - System prompt preview (first 500 chars)
   - Plugin directory path
   - Error details (if loading failed)
3. Click again to collapse

### 5.3 Enable / Disable a Plugin

- Click the **toggle switch** on the right side of the plugin card
- Disabling immediately removes the plugin's tools from the Agent's available list
- Toggle is non-operational for plugins that failed to load

### 5.4 Uninstall a Plugin

- Click the **trash icon** 🗑 on the plugin card
- Confirm to remove from the system
- Only plugins under `<userData>/plugins/` can be uninstalled
- In dev mode, plugins in the project `plugins/` directory will reload after restart

### 5.5 Install a Plugin

**Option A: Drag & Drop**
- Drag a plugin folder / archive into the installation area on the settings page
- Automatically extracts and registers

**Option B: Manual Install**
- Copy the plugin folder to `<userData>/plugins/` (production) or project `plugins/` (dev)
- Click the **Reload** button to refresh the plugin list

### 5.6 Reload Plugins

- Click the **Reload** button on the settings page
- Hot-reloads all plugins without restarting the app
- Use this after modifying plugin code during development

---

## 6. Developing New Plugins

### 6.1 Directory Structure

```
plugins/
└── my-plugin/
    ├── plugin.json          ← required, manifest
    ├── index.js             ← required, tool implementation
    ├── prompt.md            ← optional, system prompt
    ├── icon.svg             ← optional, SVG icon
    └── commands/            ← optional, slash commands
        ├── cmd1.md
        └── cmd2.md
```

### 6.2 plugin.json Full Reference

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Plugin description",
  "author": "Author name",
  "category": "office",
  "icon": "icon.svg",
  "engines": ["direct"],
  "permissions": ["shell", "web_fetch"],
  "tools": "index.js#tools",
  "slashCommands": "commands",
  "systemPrompt": "prompt.md"
}
```

**Field reference**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Unique identifier |
| `version` | string | ✅ | Semantic version number |
| `description` | string | ✅ | Short description |
| `author` | string | ❌ | Author |
| `category` | string | ❌ | Category: `office`/`dev`/`media`/`data`/`system`/`misc` |
| `icon` | string | ❌ | SVG icon file path |
| `engines` | string[] | ❌ | Supported engines, defaults to `["direct"]` |
| `permissions` | string[] | ❌ | Permissions: `shell`/`web_fetch`/`network` |
| `tools` | string | ✅ | Tool entry point, format `file.js#exportName` |
| `slashCommands` | string | ❌ | Command directory path |
| `systemPrompt` | string | ❌ | System prompt file path |

### 6.3 Tool Implementation Spec

```javascript
module.exports.tools = [
  {
    name: 'my_tool',
    description: 'Tool description (the Agent uses this to decide when to call)',
    readOnly: true,  // true = read-only, false = has side effects

    inputSchema: {
      type: 'object',
      properties: {
        param1: {
          type: 'string',
          description: 'Parameter description',
          enum: ['option1', 'option2']  // optional enum
        },
        param2: {
          type: 'number',
          description: 'Numeric parameter'
        }
      },
      required: ['param1']
    },

    // run is an async function receiving the parsed arguments object
    run: async (args) => {
      // implementation...
      // return value is read by the Agent
      return JSON.stringify({ result: '...' });
    }
  }
];
```

### 6.4 Slash Command Format

Each `.md` file in the `commands/` directory is one command. The filename (without extension) becomes the command name:

```markdown
<!-- commands/inspect-report.md -->
---
description: Inspection report generation
---

You are an inspection report expert. Follow these steps:

1. Confirm inspection type, area, and data source
2. Read and analyze inspection data
3. Use recall_memory to search historical records
4. Generate a structured inspection report
...
```

### 6.5 System Prompt

The content of `prompt.md` is appended to the Direct engine's base system prompt. Use it to:
- Inject domain knowledge (regulations, classifications, terminology)
- Define tool usage guidance (when to call which tool)
- Set safety principles and communication style

### 6.6 Development & Debugging Workflow

```
1. Copy plugins/examples/echo/ → plugins/my-plugin/
2. Modify plugin.json and index.js
3. Launch the app: npm run dev
4. In Settings → Plugins, click "Reload"
5. Verify the plugin loaded successfully (card displays normally, no error badge)
6. Test tool invocation in a conversation
7. Click the plugin card to expand details and confirm information is correct
```

---

> 📌 **Safety Notice**: Plugin tools are available only under the Direct engine. Always consult the latest regulations from local ATC authorities and the CAAC before any actual flight. Information provided by this plugin is for reference only.
