# Session Radar

Eine VS-Code-Extension, die alle deine KI-Coding-Agent-Sessions auf einen Blick zeigt: was gerade
läuft, was auf dich wartet und was fertig ist oder seit Tagen herumliegt. Projektübergreifend,
in jedem VS-Code-Fenster.

Unterstützt: **Claude Code** (VS-Code-Extension, Terminal, Desktop-App).
Vorbereitet: **Codex CLI** (Provider-Skelett), weitere Agenten über die Provider-Schnittstelle.

```
SESSION RADAR                         ✓✓  ⏷  ⟳
├─ 🟢 Läuft                                      1
│   ✦ Login-Formular mit Validierung   frnis-ai · ⎇ main · gerade eben
├─ 🟡 Wartet auf mich                            2
│   ✦ API-Client refaktorieren   🔐 Freigabe nötig · frnis-ai · ⎇ dev · vor 2 Min.
│   ✦ Release Notes             ✉️ ungelesen · docs · vor 1 Std.
├─ ⚪ Idle / fertig                              3
└─ 💤 Alt                                       47
```

## Inhalt

- [Was es kann](#was-es-kann)
- [Installation (.vsix)](#installation-vsix)
- [Hooks einrichten (empfohlen)](#hooks-einrichten-empfohlen)
- [Bedienung](#bedienung)
- [Wie der Status bestimmt wird](#wie-der-status-bestimmt-wird)
- [Einstellungen](#einstellungen)
- [Datenschutz und Sicherheit](#datenschutz-und-sicherheit)
- [Bekannte Grenzen](#bekannte-grenzen)
- [Entwicklung](#entwicklung)
- [Einen neuen Provider hinzufügen](#einen-neuen-provider-hinzufügen)

## Was es kann

- **Tree View in der Activity Bar**, gruppiert nach Status: 🟢 Läuft · 🟡 Wartet auf mich · ⚪ Idle/fertig (< 24 h) · 💤 Alt (> 24 h)
- Pro Session: Titel (dein lokales Label > `/rename`-Name > KI-Titel > erste Nachricht), Projekt, Git-Branch,
  „zuletzt aktiv vor X“, Agent-Icon. Der Tooltip zeigt alle Details inkl. Statusquelle und PID.
- **Badge** an der Activity Bar mit der Anzahl „wartet auf mich“.
- **Klick** fokussiert oder setzt die Session fort (Details unter [Bedienung](#bedienung)).
- **Kontextmenü:** lokal umbenennen, als gelesen markieren, archivieren, Transkript schreibgeschützt anzeigen,
  im Explorer zeigen, Session-ID kopieren.
- **Filter:** nur aktueller Workspace / alle Projekte; archivierte ein-/ausblenden.
- Live-Aktualisierung über FileSystemWatcher (mit Debounce), kein Dauer-Polling der Inhalte.

## Installation (.vsix)

Voraussetzungen: VS Code ≥ 1.140, Node.js ≥ 20 (für die Hooks und zum Bauen).

```powershell
cd C:\Users\phili\session-radar
npm install
npm run package:vsix                                 # erzeugt session-radar.vsix
code --install-extension .\session-radar.vsix
```

Alternativ in VS Code: Extensions-Ansicht → `…` → **Install from VSIX…** → `session-radar.vsix` wählen.
Danach erscheint das Radar-Icon in der Activity Bar jedes Fensters.

- **Update:** Version in `package.json` erhöhen, `npm run package:vsix`, erneut installieren, Fenster neu laden.
- **Deinstallieren:** zuerst in Session Radar `…` → **Claude-Code-Hooks entfernen…** (falls installiert),
  dann die Extension in VS Code deinstallieren. Optional `~/.session-radar` löschen.

## Hooks einrichten (empfohlen)

Ohne Hooks liest Session Radar die Prozessliste von Claude Code und die Transkripte. Das reicht für
„läuft / fertig / ungelesen“. **Offene Freigabe-Dialoge** (Permission Prompts) erkennt es aber nur mit Hooks.

In der Session-Radar-Ansicht: `…` → **Claude-Code-Hooks installieren…**

1. Ein Diff zeigt die geplante Änderung an `~/.claude/settings.json`.
2. Nach deiner Bestätigung legt Session Radar ein Backup unter `~/.session-radar/backups/` an.
3. Dann trägt es Hooks für `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop` und `SessionEnd` ein.
   **Bestehende Hooks bleiben unverändert.**
4. Das Hook-Skript (`~/.session-radar/hooks/session-radar-hook.js`, reines Node.js) schreibt pro Session eine
   kleine Statusdatei nach `~/.session-radar/status/claude-code/`. Es gibt nichts aus, endet immer mit Exit-Code 0
   und speichert **keine** Prompt- oder Antwortinhalte.

Die Hooks wirken für neu gestartete bzw. fortgesetzte Sessions. Entfernen geht genauso über
**Claude-Code-Hooks entfernen…**: Diff, Backup, nur die eigenen Einträge werden gelöscht.
Ohne Hooks zeigt die Ansicht im Titel den Hinweis „ohne Hooks“.

## Bedienung

**Klick auf eine Session** markiert sie als gelesen und dann:

| Session | Aktion |
|---|---|
| VS-Code-Session aus dem aktuellen Workspace | öffnet sie über den offiziellen Deep-Link `vscode://anthropic.claude-code/open?session=<id>`; ein schon offener Tab wird fokussiert |
| VS-Code-Session aus einem anderen Projekt | Auswahl: Projektfenster öffnen/fokussieren oder hier im Terminal fortsetzen |
| laufende Terminal-Session im integrierten Terminal | fokussiert dieses Terminal |
| beendete Session | `claude --resume <id>` in einem neuen Terminal im Projektordner |

Ist eine Session noch aktiv (z. B. in einem anderen Fenster) und du wählst „Im Terminal fortsetzen“,
fragt Session Radar nach: Zwei Prozesse auf derselben Session können den Verlauf durcheinanderbringen.

**Titelleiste:** ✓✓ alle als gelesen markieren · Filter Workspace/alle · ⟳ aktualisieren ·
`…` archivierte ein-/ausblenden, Hooks installieren/entfernen.

**Labels und Archiv** sind lokal. Sie verändern nichts in Claude Code und liegen in `~/.session-radar/annotations.json`.

## Wie der Status bestimmt wird

Drei Quellen, jede meldet eine Phase mit Zeitstempel. **Die neueste Meldung gewinnt; bei Gleichstand gilt
Hooks > Prozessliste > Transkript.**

| Quelle | Was sie liefert |
|---|---|
| **Hooks** (`~/.session-radar/status/…`) | läuft / wartet auf Freigabe oder Eingabe / Turn beendet / Session beendet |
| **Prozessliste** (`~/.claude/sessions/<pid>.json`) | lebt der Prozess? `busy` / `idle` |
| **Transkript** (`~/.claude/projects/…/<id>.jsonl`) | Titel, Projekt, Branch, letzte Aktivität, ob der letzte Turn abgeschlossen ist |

| Gruppe | Bedeutung |
|---|---|
| 🟢 **Läuft** | der Agent arbeitet gerade |
| 🟡 **Wartet auf mich** | 🔐 Freigabe nötig · ❓ Eingabe nötig (nur mit Hooks) · ✉️ ungelesen: Antwort fertig, seitdem nicht im Radar angeklickt |
| ⚪ **Idle / fertig** | gesehen oder beendet, letzte Aktivität < 24 h |
| 💤 **Alt** | > 24 h ohne Aktivität |

Beim ersten Start gelten alle bis dahin fertigen Antworten als gelesen. „Ungelesen“ lässt sich in den
Einstellungen abschalten.

## Einstellungen

| Einstellung | Standard | Bedeutung |
|---|---|---|
| `sessionRadar.claudeDir` | leer | Claude-Konfigurationsordner; leer = `$CLAUDE_CONFIG_DIR` bzw. `~/.claude` |
| `sessionRadar.maxAgeDays` | 30 | ältere Transkripte werden ignoriert |
| `sessionRadar.staleAfterHours` | 24 | ab wann eine Session „alt“ ist |
| `sessionRadar.runningTimeoutMinutes` | 30 | „läuft“ ohne neue Aktivität gilt danach als hängengeblieben |
| `sessionRadar.unreadAsWaiting` | true | fertige, ungesehene Antworten als „wartet auf mich“ zählen |

Die Umgebungsvariable `SESSION_RADAR_HOME` verlegt `~/.session-radar` (z. B. für Tests).

## Datenschutz und Sicherheit

- **Strikt lokal:** kein Netzwerkzugriff, keine Telemetrie.
- **Transkripte werden nur gelesen**, und zwar nur Anfang und Ende jeder Datei. Die Transkript-Ansicht ist
  eine schreibgeschützte virtuelle Ansicht ohne Speichern-Möglichkeit.
- Die `.key`-Dateien in `~/.claude/sessions/` (Tokens) werden nie gelesen.
- Die Statusschicht `~/.session-radar/` enthält keine Prompt- oder Antworttexte, nur Zustände, Zeitstempel,
  Pfade und IDs.
- Änderungen an `~/.claude/settings.json` erfolgen nur auf Knopfdruck, mit Diff, Bestätigung und Backup.
  Wurde die Datei während des Dialogs geändert, wird nichts geschrieben.
- Session-IDs werden geprüft, bevor sie in einen Terminal-Befehl gelangen.

## Bekannte Grenzen

- **Transkript-Format und Prozessliste sind nicht offiziell dokumentiert.** Laut Claude-Code-Doku können sie sich
  mit jedem Release ändern. Der Parser ist tolerant (unbekannte Einträge werden ignoriert). Wenn nach einem
  Claude-Update etwas fehlt, zuerst die Unit-Tests mit neuen anonymisierten Fixtures erweitern. Dokumentiert und
  damit stabil ist nur der Hook-Weg.
- Nach einer beantworteten Freigabe gibt es kein eigenes Hook-Event. „Wartet“ endet, sobald das Transkript
  weiterläuft.
- Ein Abbruch mit Esc löst keinen `Stop`-Hook aus. Das fängt die Prozessliste bzw. der Timeout ab.
- Externe Terminalfenster (außerhalb von VS Code) können nicht fokussiert werden.
- Wird eine PID nach einem Absturz von einem anderen Prozess wiederverwendet, kann eine Session kurz fälschlich als lebend gelten.

## Entwicklung

```powershell
npm install
npm run test:unit        # schnelle Unit-Tests (Mocha, ohne VS Code), Fixtures unter test/fixtures
npm test                 # Integrationstest in einer VS-Code-Testinstanz (gegen Fixtures, nicht gegen echte Daten)
npm run compile          # Typecheck + Lint + Build
npm run package:vsix     # .vsix bauen
```

**Debuggen:** Projekt in VS Code öffnen, F5 → „Run Extension (Arbeitsordner)“. Im Extension Development Host
öffnet sich ein echter Arbeitsordner. Nach Codeänderungen dort `Ctrl+R`. Benötigt die empfohlene Extension
`connor4312.esbuild-problem-matchers`.

**Fixtures:** Nur anonymisierte, von Hand geschriebene Beispieldaten. `.gitignore` blockiert alle anderen `*.jsonl`.

### Struktur

```
src/
├── extension.ts                    Einstieg: verdrahtet Provider, Store, Tree, Watcher, Commands
├── core/                           ohne VS-Code-Abhängigkeit, voll unit-getestet
│   ├── model.ts                    AgentSession, StatusSignals, …
│   ├── provider.ts                 SessionProvider-Interface, ResumeHost, WatchHost
│   ├── status.ts                   deriveStatus(): Signale → Status
│   ├── SessionStore.ts             bündelt Provider + Annotationen
│   ├── statusLayer.ts              liest ~/.session-radar/status (Format: docs/status-format.md)
│   └── annotations.ts …            Labels/Archiv/gelesen, atomare Schreibzugriffe, Hilfsfunktionen
├── providers/
│   ├── claude/                     ClaudeCodeProvider, Transkript-Parser, Prozessliste, Hook-Konfiguration
│   └── codex/                      CodexProvider (Skelett)
└── ui/                             TreeView, Commands, Hook-Installer, VS-Code-Hosts
resources/hooks/session-radar-hook.js   Hook-Skript (wird nach ~/.session-radar/hooks kopiert)
docs/status-format.md                   Format der Statusschicht für andere Oberflächen
```

## Einen neuen Provider hinzufügen

Beispiel: ein Provider für einen Agenten „Foo“.

**1. Agent-Typ registrieren** in `src/core/model.ts`:

```ts
export type AgentKind = 'claude-code' | 'codex' | 'foo';
```

**2. Provider schreiben** unter `src/providers/foo/FooProvider.ts`. Am einfachsten von `BaseSessionProvider`
ableiten; dann ist die Standard-Statuslogik schon dabei:

```ts
import { promises as fs } from 'fs';
import * as path from 'path';
import { AgentSession, baseName } from '../../core/model';
import { BaseSessionProvider, Disposable, ResumeHost, WatchHost } from '../../core/provider';
import { readStatusDir } from '../../core/statusLayer';

export class FooProvider extends BaseSessionProvider {
	readonly agent = 'foo' as const;
	readonly displayName = 'Foo Agent';
	readonly iconId = 'robot';                          // Codicon-Name

	constructor(private readonly dataDir: string, private readonly statusDir: string) { super(); }

	async isAvailable() {
		return fs.stat(this.dataDir).then(s => s.isDirectory(), () => false);
	}

	async discover(): Promise<AgentSession[]> {
		const hooks = await readStatusDir(this.statusDir);  // optional: eigene Hooks → Statusschicht
		const sessions: AgentSession[] = [];
		// … Sessions des Agenten finden. Große Dateien nur teilweise lesen
		//   (core/fileChunks.ts) und nach Größe/mtime cachen.
		// Pro Session die Rohsignale füllen; den Status berechnet der Store:
		// sessions.push({ id, agent: this.agent, title, project, projectName: baseName(project),
		//   branch, surface: 'cli', transcriptPath, status: 'idle', statusSource: 'transcript',
		//   signals: { lastActivity, turnEndedAt, turnInProgress, process: {...}, hook: {...} } });
		return sessions;
	}

	watch(host: WatchHost, onChange: () => void): Disposable {
		return host.watch(this.dataDir, '**/*.jsonl', () => onChange());
	}

	async resume(session: AgentSession, host: ResumeHost) {
		host.runInTerminal({ name: `Foo: ${session.title}`, cwd: session.project, command: `foo resume ${session.id}` });
	}
}
```

**Was ein Provider liefern muss:**

| Methode | Aufgabe |
|---|---|
| `isAvailable()` | ist der Agent auf diesem Rechner installiert bzw. hat er Daten? |
| `discover()` | alle Sessions mit Rohsignalen; muss wiederholt billig sein (Cache) |
| `watch()` | Datei-Watcher registrieren; bei Änderungen `onChange()` rufen (der Store debounced) |
| `getStatus()` | geerbt (`deriveStatus`); nur überschreiben, wenn der Agent eigene Zustände hat |
| `resume()` | Session fortsetzen bzw. fokussieren, ausschließlich über `ResumeHost` (keine direkte VS-Code-API) |
| `resumeInTerminal()` | optional; explizites „Im Terminal fortsetzen“ |

**3. Registrieren** in `src/extension.ts`:

```ts
const providers = [
	new ClaudeCodeProvider({ … }),
	new CodexProvider({ … }),
	new FooProvider(path.join(os.homedir(), '.foo'), path.join(home, 'status', 'foo')),
];
```

**4. Live-Status (optional, empfohlen):** Hat der Agent Hooks oder Notify-Callbacks, lass sie Statusdateien im
dokumentierten Format nach `~/.session-radar/status/foo/<sessionId>.json` schreiben
([docs/status-format.md](docs/status-format.md)). `resources/hooks/session-radar-hook.js` ist eine Vorlage.
Ohne Hooks: Prozess-Liveness über `signals.process` und Aktivität über `signals.lastActivity`.

**5. Tests:** anonymisierte Fixtures unter `test/fixtures/foo/` anlegen und Parser-/Discovery-Tests unter
`src/test/unit/` schreiben (siehe `transcript.test.ts`, `provider.test.ts`). Statuslogik und Provider laufen
ohne VS Code und lassen sich daher mit Mocha testen.

**Checkliste:** strikt lokal (kein Netzwerk) · Agent-Daten nur lesen · keine Inhalte in die Statusschicht ·
IDs validieren, bevor sie in Shell-Befehle gehen · Windows-Pfade testen.
