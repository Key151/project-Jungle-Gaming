/**
 * Métricas simples em memória (contadores e gauges).
 *
 * Expostas em /metrics no formato texto do Prometheus.
 * Limitação: são por instância (não há Prometheus aqui).
 */
export class MetricsService {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private latencies = new Map<string, { count: number; sum: number }>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = makeKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(makeKey(name, labels), value);
  }

  /** Registra uma latência (guarda contagem e soma). */
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = makeKey(name, labels);
    const current = this.latencies.get(key) ?? { count: 0, sum: 0 };
    current.count += 1;
    current.sum += value;
    this.latencies.set(key, current);
  }

  getCounter(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(makeKey(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];

    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    for (const [key, value] of this.gauges) lines.push(`${key} ${value}`);
    for (const [key, value] of this.latencies) {
      const name = key.split('{')[0];
      lines.push(`${name}_count ${value.count}`);
      lines.push(`${name}_sum ${value.sum}`);
    }

    return lines.join('\n') + '\n';
  }
}

function makeKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return name;

  const rendered = entries.map(([key, value]) => `${key}="${value}"`).join(',');
  return `${name}{${rendered}}`;
}
