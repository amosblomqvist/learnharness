import type { graph as en } from "../en/graph.ts";

export const graph: Record<keyof typeof en, string> = {
	// Graph view: empty state, node card, context menu, pipeline chips
	"graph.empty.title": "Grafo de conocimiento",
	"graph.empty.body": "Inicia una sesión o importa notas para construir tu grafo.",
	"graph.card.sessions": "Sesiones",
	"graph.card.noSessions": "No hay sesiones registradas.",
	"graph.menu.delete": "Eliminar",
	"graph.pipeline.phase.waiting": "En espera",
	"graph.pipeline.phase.queued": "En cola",
	"graph.pipeline.phase.extracting": "Extrayendo",
	"graph.pipeline.phase.auditing": "Auditando",
	"graph.pipeline.phase.merging": "Fusionando",
	"graph.pipeline.elapsed": "{n}s",

	// Top chrome row
	"graph.chrome.search": "Buscar nodos",
	"graph.chrome.searchPlaceholder": "Buscar nodos…",
	"graph.chrome.noMatch": "Ningún nodo coincide.",
	"graph.chrome.chainsHint": "Todas las cadenas de razonamiento",
	"graph.chrome.chains": "Cadenas",
	"graph.chrome.importHint": "Importar notas al grafo",
	"graph.chrome.importing": "Importando…",
	"graph.chrome.import": "Importar notas…",

	// Pipeline costs
	"graph.costs.hint": "Costos del grafo — haz clic para ver detalles",
	"graph.costs.title": "Costos del proceso del grafo",
	"graph.costs.unpriced": "{n} sin precio",
	"graph.costs.plusUnpriced": "+{n} sin precio",
	"graph.costs.tokensInOut": "{input} entrada / {output} salida",
	"graph.costs.stage.extraction": "Extracción",
	"graph.costs.stage.audit": "Auditoría",
	"graph.costs.ago.now": "ahora",
	"graph.costs.ago.minutes": "{n} min",
	"graph.costs.ago.hours": "{n} h",
	"graph.costs.ago.days": "{n} d",

	// Display settings panel
	"graph.settings.hint": "Ajustes de visualización del grafo",
	"graph.settings.nodeSize": "Tamaño de nodo",
	"graph.settings.edgeWidth": "Grosor de arista",
	"graph.settings.arrowSize": "Tamaño de flecha",
	"graph.settings.labelSize": "Tamaño de etiqueta",
	"graph.settings.labelZoom": "Etiquetas hasta el zoom",
	"graph.settings.regions": "Regiones",
	"graph.settings.backgroundColors": "Colores de fondo",
	"graph.settings.dilation": "Dilatación",
	"graph.settings.blur": "Desenfoque",
	"graph.settings.edgeAlpha": "Opacidad del borde",
	"graph.settings.bitmapResolution": "Resolución del mapa de bits",
	"graph.settings.clusterLabels": "Etiquetas de grupo",
	"graph.settings.clusterLabelSize": "Tamaño de etiqueta de grupo",
	"graph.settings.physics": "Física",
	"graph.settings.nodeRepulsion": "Repulsión entre nodos",
	"graph.settings.edgeAttraction": "Atracción de aristas",
	"graph.settings.edgeLength": "Longitud de arista",
	"graph.settings.centralPull": "Atracción central",
	"graph.settings.clusterPull": "Atracción de grupo",
	"graph.settings.off": "no",
	"graph.settings.friction": "Fricción",
	"graph.settings.depthAnchor": "Anclaje de profundidad",
	"graph.settings.depthMode.off": "Desactivado",
	"graph.settings.depthMode.vertical": "Vertical (hacia arriba)",
	"graph.settings.depthMode.radial": "Radial (hacia afuera)",
	"graph.settings.depthStrength": "Fuerza de profundidad",
	"graph.settings.depthSpacing": "Espaciado de profundidad",
	"graph.settings.baseRingRadius": "Radio del anillo base",

	// Graph-context card (a session's map pick)
	"graph.context.title": "Contexto del grafo",
	"graph.context.propositions.one": "{n} proposición",
	"graph.context.propositions.other": "{n} proposiciones",
	"graph.context.chains.one": "{n} cadena",
	"graph.context.chains.other": "{n} cadenas",

	// Extraction coverage (session menu block + ring meter)
	"graph.coverage.extracting": "extrayendo…",
	"graph.coverage.complete": "extracción completa",
	"graph.coverage.uncoveredTok": "{tokens} tok sin cubrir",
	"graph.coverage.unextracted.one": "{n} mensaje sin extraer",
	"graph.coverage.unextracted.other": "{n} mensajes sin extraer",
	"graph.coverage.running": "En curso",
	"graph.coverage.extract": "Extraer",
	"graph.coverage.ringHint": "Cuánto de esta sesión aún no está en el mapa",
	"graph.coverage.title": "Cobertura de extracción",
	"graph.coverage.uncovered": "Sin cubrir",
	"graph.coverage.covered": "Cubierto",
	"graph.coverage.messages": "Mensajes",
	"graph.coverage.chunkThreshold": "Umbral de fragmento",
	"graph.coverage.lastExtraction": "Última extracción",
	"graph.coverage.status": "Estado",
	"graph.coverage.tokens": "{tokens} tokens",

	// Notes import errors
	"graph.import.invalidResponse": "Respuesta de importación no válida. Vuelve a intentar con el archivo.",
	"graph.import.requestFailed": "Falló la solicitud de importación (HTTP {status}). Vuelve a intentar con el archivo.",
	"graph.import.requestFailedDetail":
		"Falló la solicitud de importación (HTTP {status}): {detail}. Vuelve a intentar con el archivo.",

	// Delete dialogs (shared)
	"graph.delete.cancel": "Cancelar",
	"graph.delete.confirm": "Eliminar",
	"graph.delete.deleting": "Eliminando…",
	"graph.delete.retry": "Reintentar",
	"graph.delete.failed": "No se pudo eliminar ({status})",
	"graph.delete.networkError": "No se pudo eliminar — error de red. Inténtalo de nuevo.",

	// Delete session dialog
	"graph.deleteSession.aria": "Eliminar sesión",
	"graph.deleteSession.title": "¿Eliminar sesión?",
	"graph.deleteSession.body":
		"Esto elimina la sesión de forma permanente — sus mensajes, tareas en segundo plano y registros de extracción. Todo lo que aportó al grafo se conserva, a menos que marques la opción de abajo. No se puede deshacer.",
	"graph.deleteSession.traces.title": "Eliminar también sus rastros en el grafo",
	"graph.deleteSession.traces.body":
		"Los temas, vínculos y eventos de esta sesión también salen del grafo. Los temas que otras sesiones o notas importadas también cubren se conservan; los temas que solo creó esta sesión se eliminan por completo.",

	// Delete node dialog
	"graph.deleteNode.aria": "Eliminar nodo",
	"graph.deleteNode.title.one": "¿Eliminar nodo?",
	"graph.deleteNode.title.other": "¿Eliminar {n} nodos?",
	"graph.deleteNode.andMore": " y {n} más",
	"graph.deleteNode.permanence.one": "Esto elimina el nodo de forma permanente — no se puede deshacer.",
	"graph.deleteNode.permanence.other": "Esto elimina los {n} nodos de forma permanente — no se puede deshacer.",
	"graph.deleteNode.extractionRunning":
		"Hay una extracción en curso — inténtalo de nuevo cuando se vacíe el panel de actividad.",
};
