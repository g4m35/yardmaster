/** Returns one cycle (as a node path) if the directed graph has any, else null. */
export function findCycle(edges: Map<string, Iterable<string>>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (n: string): string[] | null => {
    color.set(n, GRAY);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      const c = color.get(m) ?? WHITE;
      if (c === GRAY) return [...stack.slice(stack.indexOf(m)), m];
      if (c === WHITE) {
        const found = visit(m);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(n, BLACK);
    return null;
  };

  for (const n of edges.keys()) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      const found = visit(n);
      if (found) return found;
    }
  }
  return null;
}
