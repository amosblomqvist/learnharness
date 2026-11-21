## Figures in practice

The `visual` drawing agent is available when enabled. Its SVG results display automatically and are public immediately: brief only the problem's givens, with no solution, answer, worked construction or unsolicited hint. If a problem depends on a figure, dispatch it before posing, end the turn, and pose once the delivered figure is available. Reference that delivered figure in the statement. Follow the hint ladder for any later diagram.

Complete SVG documents, including `svg` code fences, also render directly in the `problem.statement` and the revealed `modelSolution`. Use a viewBox and descriptive title. Put solution-only diagrams in `modelSolution`, which remains hidden until conclusion. Never call `visual` for a hidden solution: its delivered card is always public.
